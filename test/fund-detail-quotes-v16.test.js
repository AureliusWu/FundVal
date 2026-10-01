import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { holdingQuoteCode } from '../js/fund-holdings.js';
import { classifyFundMarket } from '../js/freshness.js';
import { formatChinaQuoteTime, normalizeTencentQuoteTime } from '../js/holdings-estimate.js';
import { nullableNumber } from '../js/runtime/quote-contract.js';
import { throwIfAborted } from '../js/runtime/request-signal.js';
import { createRefreshPlan, createSecurityQuotePlan } from '../js/runtime/refresh-plan.js';
import { createGenerationResourceScope } from '../js/runtime/generation-resource-scope.js';
import { executeSecurityQuotePlan } from '../js/runtime/security-quote-batch.js';
import * as securityQuoteFeature from '../js/runtime/security-quote-batch.js';
import { isRefreshAbort } from '../js/runtime/refresh-generation.js';
import { RefreshCoordinator } from '../js/runtime/refresh-coordinator.js';
import { TTL } from '../js/config.js';

const NOW = Date.parse('2026-09-30T14:00:00+08:00');
const TIME = '2026-09-30 14:00:00';
const FUND = { code: '005844', name: '合成测试混合基金' };
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const quoteStart = source.indexOf('async function fetchHoldingsQuotes(');
const quoteEnd = source.indexOf('function fmtQuoteNav(', quoteStart);
assert.ok(quoteStart >= 0 && quoteEnd > quoteStart, 'the real app detail quote entry must exist');
const quoteBody = source.slice(quoteStart, quoteEnd);

function em(code, extra = {}) {
  return { f12: code.slice(2), f13: code.startsWith('sh') ? 1 : 0, f2: 10, f3: 1, f124: NOW / 1000, ...extra };
}
function tencent(code, extra = {}) {
  return { code, price: 10, changePct: 1, sourceTimeRaw: '20260930140000', ...extra };
}
function stock(code, market = 'sh', extra = {}) {
  return { code, market, name: '合成股票', ratio: 5, ...extra };
}

function harness({ primary = [], fallback = [], fetchPrimary, fetchFallback } = {}) {
  const primaryCalls = [], fallbackCalls = [];
  const dependencies = {
    loadHoldingsEstimateFeature: async () => ({ formatChinaQuoteTime, normalizeTencentQuoteTime }),
    loadFundHoldingsFeature: async () => ({ holdingQuoteCode }),
    fundsData: [FUND], holdings: [FUND], classifyFundMarket,
    fetchWithTimeout: async (url, options) => {
      primaryCalls.push({ url, signal: options?.signal });
      return fetchPrimary ? fetchPrimary(url, options) : Response.json({ data: { diff: primary } });
    },
    TIMING: { INDEX_JSONP_TIMEOUT: 100 },
    parseNav: value => nullableNumber(value) ?? NaN,
    formatChinaQuoteTime,
    loadQuoteBridgeFeature: async () => ({ securityQuotes: async (codes, options) => {
      fallbackCalls.push({ codes: [...codes], signal: options?.signal });
      return fetchFallback ? fetchFallback(codes, options) : { quotes: fallback };
    } }),
    normalizeTencentQuoteTime, nullableNumber, throwIfAborted,
    createRefreshPlan, createSecurityQuotePlan, createGenerationResourceScope, executeSecurityQuotePlan,
    loadSecurityQuoteFeature: async () => securityQuoteFeature,
    isRefreshAbort,
    Date: FixedDate,
  };
  // Execute the production functions themselves; transports are synthetic, not
  // a second implementation of the parsing, qualification or fallback rules.
  const fetchQuotes = new Function(...Object.keys(dependencies), `${quoteBody}\nreturn fetchHoldingsQuotes;`)(...Object.values(dependencies));
  return { fetchQuotes, primaryCalls, fallbackCalls };
}

test('manual detail requests explicit Eastmoney market identity and assigns colliding bare codes independently', async () => {
  const rows = [stock('000001', 'sh'), stock('000001', 'sz')];
  const h = harness({ primary: [em('sh000001', { f3: 11 }), em('sz000001', { f3: 22 })] });
  await h.fetchQuotes(FUND.code, rows);
  assert.equal(rows[0].change, 11);
  assert.equal(rows[1].change, 22);
  assert.equal(rows[0].quoteTime, TIME);
  assert.equal(rows[1].quoteTime, TIME);
  assert.equal(h.primaryCalls.length, 1);
  const fields = new URL(h.primaryCalls[0].url).searchParams.get('fields').split(',');
  assert.ok(fields.includes('f13'), 'f12 without f13 cannot identify an exchange');
  assert.deepEqual(h.fallbackCalls, []);
});

test('manual detail rejects duplicate, missing-market or unexpected primary identities before any assignment', async () => {
  for (const primary of [
    [em('sh600000', { f3: 99 }), em('sh600000', { f3: 88 })],
    [{ f12: '600000', f3: 99, f124: NOW / 1000 }],
    [em('sh600000', { f3: 99 }), em('sh600001', { f3: 88 })],
  ]) {
    const rows = [stock('600000')], h = harness({ primary, fallback: [tencent('sh600000', { changePct: 5 })] });
    await h.fetchQuotes(FUND.code, rows);
    assert.equal(rows[0].change, 5, 'untrusted primary identity set must fall through, never publish poisoned values');
    assert.equal(rows[0].quoteTime, TIME);
    assert.deepEqual(h.fallbackCalls.map(call => call.codes), [['sh600000']]);
  }
});

test('manual detail excludes future or impossible primary clocks and requests only that missing identity', async () => {
  for (const f124 of [NOW / 1000 + 1, NOW / 1000 + 0.5, null, 0]) {
    const rows = [stock('600000'), stock('600001')];
    const h = harness({ primary: [em('sh600000', { f3: 99, f124 }), em('sh600001', { f3: 0 })],
      fallback: [tencent('sh600000', { changePct: 5 })] });
    await h.fetchQuotes(FUND.code, rows);
    assert.equal(rows[0].change, 5);
    assert.equal(rows[1].change, 0);
    assert.deepEqual(h.fallbackCalls.map(call => call.codes), [['sh600000']]);
  }
});

test('manual detail preserves a genuine primary zero and leaves null without a manufactured contribution', async () => {
  const rows = [stock('600000'), stock('600001')];
  const h = harness({ primary: [em('sh600000', { f3: 0 }), em('sh600001', { f3: null })] });
  await h.fetchQuotes(FUND.code, rows);
  assert.equal(rows[0].change, 0);
  assert.equal(rows[0].quoteTime, TIME);
  assert.equal(Number.isFinite(rows[1].change), false);
  assert.equal(Boolean(rows[1].quoteTime), false);
  assert.deepEqual(h.fallbackCalls.map(call => call.codes), [['sh600001']]);
});

test('manual detail revalidates duplicate and unexpected identities from its untrusted Tencent client result', async () => {
  for (const fallback of [
    [tencent('hk00700', { changePct: 99 }), tencent('hk00700', { changePct: 88 })],
    [tencent('hk00700', { changePct: 99 }), tencent('hk00001', { changePct: 88 })],
  ]) {
    const rows = [stock('00700', 'hk')], h = harness({ fallback });
    await h.fetchQuotes(FUND.code, rows);
    assert.equal(Number.isFinite(rows[0].change), false);
    assert.equal(Boolean(rows[0].quoteTime), false);
    assert.equal(h.primaryCalls.length, 0);
    assert.deepEqual(h.fallbackCalls.map(call => call.codes), [['hk00700']]);
  }
});

test('manual detail never publishes Tencent moves with future, empty or impossible source clocks', async () => {
  for (const sourceTimeRaw of ['20260930140001', '20260230140000', null]) {
    const rows = [stock('00700', 'hk')], h = harness({ fallback: [tencent('hk00700', { changePct: 99, sourceTimeRaw })] });
    await h.fetchQuotes(FUND.code, rows);
    assert.equal(Number.isFinite(rows[0].change), false, String(sourceTimeRaw));
    assert.equal(Boolean(rows[0].quoteTime), false, String(sourceTimeRaw));
  }
});

test('manual detail keeps a valid Tencent zero distinct from null', async () => {
  const rows = [stock('00700', 'hk'), stock('00001', 'hk')];
  const h = harness({ fallback: [tencent('hk00700', { changePct: 0 }), tencent('hk00001', { changePct: null })] });
  await h.fetchQuotes(FUND.code, rows);
  assert.equal(rows[0].change, 0);
  assert.equal(rows[0].quoteTime, TIME);
  assert.equal(Number.isFinite(rows[1].change), false);
  assert.equal(Boolean(rows[1].quoteTime), false);
});

test('manual detail keeps overseas numeric identities separate and never fetches an unidentified disclosure row', async () => {
  const rows = [stock('000660', 'cn'), stock('000660', 'kr'),
    stock('000660', 'unknown', { change: 99, quoteTime: TIME })];
  const h = harness({ primary: [em('sz000660', { f3: 0 })],
    fallback: [tencent('kr000660', { changePct: -2, sourceTimeRaw: '20260930150000' })] });
  await h.fetchQuotes(FUND.code, rows);
  assert.equal(rows[0].change, 0);
  assert.equal(rows[1].change, -2);
  assert.equal(rows[1].quoteTime, TIME);
  assert.equal(Number.isFinite(rows[2].change), false);
  assert.equal(Boolean(rows[2].quoteTime), false);
  assert.equal(new URL(h.primaryCalls[0].url).searchParams.get('secids'), '0.000660');
  assert.deepEqual(h.fallbackCalls.map(call => call.codes), [['kr000660']]);
});

test('manual detail validates an overseas source clock after conversion from the exchange timezone', async () => {
  const rows = [stock('QQQ', 'us'), stock('SPY', 'us')];
  const h = harness({ fallback: [tencent('usQQQ', { changePct: 0, sourceTimeRaw: '20260930020000' }),
    tencent('usSPY', { changePct: 99, sourceTimeRaw: '20260930030000' })] });
  await h.fetchQuotes(FUND.code, rows);
  assert.equal(rows[0].change, 0);
  assert.equal(rows[0].quoteTime, TIME);
  assert.equal(Number.isFinite(rows[1].change), false);
  assert.equal(Boolean(rows[1].quoteTime), false);
});

test('manual detail deduplicates qualified quote demands without dropping disclosed rows', async () => {
  const rows = [stock('600000'), stock('600000', 'sh', { ratio: 6 }), stock('00700', 'hk'), stock('00700', 'hk', { ratio: 7 })];
  const h = harness({ primary: [em('sh600000', { f3: 0 })], fallback: [tencent('hk00700', { changePct: -1 })] });
  await h.fetchQuotes(FUND.code, rows);
  assert.equal(new URL(h.primaryCalls[0].url).searchParams.get('secids'), '1.600000');
  assert.deepEqual(h.fallbackCalls.map(call => call.codes), [['hk00700']]);
  assert.deepEqual(rows.map(row => row.change), [0, 0, -1, -1]);
  assert.equal(rows.length, 4);
});

test('manual detail discards a late primary response after caller cancellation, without mutating prior rows', async () => {
  let entered, resolve;
  const started = new Promise(done => { entered = done; });
  const pending = new Promise(done => { resolve = done; });
  const rows = [stock('600000', 'sh', { change: 7, quoteTime: '2026-09-29 15:00:00' })];
  const h = harness({ fetchPrimary: async () => { entered(); return pending; } });
  const controller = new AbortController(), task = h.fetchQuotes(FUND.code, rows, controller.signal);
  await started;
  controller.abort('detail_closed');
  resolve(Response.json({ data: { diff: [em('sh600000', { f3: 99 })] } }));
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(rows[0].change, 7);
  assert.equal(rows[0].quoteTime, '2026-09-29 15:00:00');
  assert.equal(h.primaryCalls.length, 1);
  assert.deepEqual(h.fallbackCalls, []);
});

test('manual detail discards a late Tencent response after caller cancellation and starts no extra request', async () => {
  let entered, resolve;
  const started = new Promise(done => { entered = done; });
  const pending = new Promise(done => { resolve = done; });
  const rows = [stock('00700', 'hk')];
  const h = harness({ fetchFallback: async () => { entered(); return pending; } });
  const controller = new AbortController(), task = h.fetchQuotes(FUND.code, rows, controller.signal);
  await started;
  controller.abort('detail_switched');
  resolve({ quotes: [tencent('hk00700', { changePct: 99 })] });
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(Number.isFinite(rows[0].change), false);
  assert.equal(Boolean(rows[0].quoteTime), false);
  assert.equal(h.primaryCalls.length, 0);
  assert.equal(h.fallbackCalls.length, 1);
});

test('expanding a cached disclosure with missing quotes still runs the real detail quote acquisition path', async () => {
  const start = source.indexOf('async function fetchFundDetails(');
  const end = source.indexOf('function inferFundType(', start);
  assert.ok(start >= 0 && end > start, 'the real app detail orchestration must exist');
  const quoteCalls = [], renders = [];
  const holdingsCache = { [FUND.code]: [stock('600000')] };
  const dependencies = {
    loadingDetails: null, expandedFund: FUND.code, holdingsCache, holdingsMetaCache: {}, fundsData: [FUND],
    fundTypeCache: { [FUND.code]: { type: '混合型' } }, fundFeeCache: { [FUND.code]: null },
    loadFundHoldings: async () => { assert.fail('a cached disclosure must not be downloaded again'); },
    fetchHoldingsQuotes: async (code, rows) => { quoteCalls.push({ code, rows }); rows[0].change = 0; rows[0].quoteTime = TIME; },
    renderFundList: data => renders.push(data), inferFundType: () => '混合型',
    throwIfAborted, isRefreshAbort,
    refreshCoordinator: { activePromise: null },
  };
  const fetchDetails = new Function(...Object.keys(dependencies), `${source.slice(start, end)}\nreturn fetchFundDetails;`)(...Object.values(dependencies));
  await fetchDetails(FUND.code);
  assert.equal(quoteCalls.length, 1);
  assert.equal(quoteCalls[0].code, FUND.code);
  assert.equal(quoteCalls[0].rows, holdingsCache[FUND.code]);
  assert.equal(holdingsCache[FUND.code][0].change, 0);
  assert.ok(renders.length > 0);
});

function detailFeature(options) {
  assert.equal(typeof securityQuoteFeature.executeDetailSecurityQuotes, 'function', 'the production detail entry must reuse the real batch executor');
  return securityQuoteFeature.executeDetailSecurityQuotes({ normalizeTime: normalizeTencentQuoteTime, now: () => NOW, ...options });
}

test('the production detail helper returns a deduplicated qualified map without modifying disclosure items', async () => {
  const items = [Object.freeze({ quoteCode: 'sh000001', ratio: 1 }), Object.freeze({ quoteCode: 'sz000001', ratio: 2 }),
    Object.freeze({ quoteCode: 'sh000001', ratio: 3 }), Object.freeze({ quoteCode: 'hk00700', ratio: 4 })];
  const before = structuredClone(items), primaryCalls = [], fallbackCalls = [];
  const quotes = await detailFeature({ items,
    fetchEastmoney: async codes => { primaryCalls.push([...codes]); return { data: { diff: codes.map(code => em(code, { f3: code.startsWith('sh') ? 0 : -2 })) } }; },
    fetchBridge: async (operation, codes) => { fallbackCalls.push({ operation, codes: [...codes] }); return { quotes: codes.map(code => tencent(code)) }; },
  });
  assert.deepEqual(primaryCalls, [['sh000001', 'sz000001']]);
  assert.deepEqual(fallbackCalls, [{ operation: 'securityQuotes', codes: ['hk00700'] }]);
  assert.deepEqual(quotes, { hk00700: { quoteCode: 'hk00700', change: 1, quoteTime: TIME },
    sh000001: { quoteCode: 'sh000001', change: 0, quoteTime: TIME }, sz000001: { quoteCode: 'sz000001', change: -2, quoteTime: TIME } });
  assert.deepEqual(items, before);
});

test('the production detail helper honors 50-identity batching and primary missing-only fallback', async () => {
  const codes = Array.from({ length: 51 }, (_, index) => `sh${600000 + index}`);
  const primaryCalls = [], fallbackCalls = [];
  const quotes = await detailFeature({ items: codes.map(quoteCode => ({ quoteCode })),
    fetchEastmoney: async requested => { primaryCalls.push([...requested]);
      return { data: { diff: requested.filter(code => code !== 'sh600001').map(code => em(code)) } }; },
    fetchBridge: async (operation, requested) => { fallbackCalls.push({ operation, codes: [...requested] });
      return { quotes: requested.map(code => tencent(code, { changePct: 0 })) }; },
  });
  assert.deepEqual(primaryCalls.map(batch => batch.length), [50, 1]);
  assert.deepEqual(primaryCalls.flat(), codes);
  assert.deepEqual(fallbackCalls, [{ operation: 'securityQuotes', codes: ['sh600001'] }]);
  assert.equal(Object.keys(quotes).length, 51);
  assert.equal(quotes.sh600001.change, 0);
});

test('the production detail helper performs no acquisition for an already-cancelled detail request', async () => {
  const controller = new AbortController();
  controller.abort('already_closed');
  let calls = 0;
  const task = detailFeature({ items: [{ quoteCode: 'sh600000' }], signal: controller.signal,
    fetchEastmoney: async () => { calls++; return { data: { diff: [] } }; },
    fetchBridge: async () => { calls++; return { quotes: [] }; },
  });
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('the production detail helper rejects late primary and Tencent results through its real cancellation scope', async () => {
  for (const provider of ['primary', 'overseas']) {
    let entered, resolve;
    const started = new Promise(done => { entered = done; });
    const pending = new Promise(done => { resolve = done; });
    const controller = new AbortController(), calls = [], items = [{ quoteCode: provider === 'primary' ? 'sh600000' : 'hk00700' }];
    const task = detailFeature({ items, signal: controller.signal,
      fetchEastmoney: async codes => { calls.push([...codes]); entered(); return pending; },
      fetchBridge: async (_operation, codes) => { calls.push([...codes]); entered(); return pending; },
    });
    await started;
    controller.abort('switched_detail');
    resolve(provider === 'primary' ? { data: { diff: [em('sh600000')] } } : { quotes: [tencent('hk00700')] });
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(calls.length, 1);
    assert.deepEqual(items, [{ quoteCode: provider === 'primary' ? 'sh600000' : 'hk00700' }]);
  }
});

test('the production detail helper degrades ordinary provider failures to missing records, never synthetic zero', async () => {
  const calls = [];
  const quotes = await detailFeature({ items: [{ quoteCode: 'sh600000' }],
    fetchEastmoney: async codes => { calls.push({ provider: 'primary', codes: [...codes] }); throw new Error('synthetic detail primary failure'); },
    fetchBridge: async (_operation, codes) => { calls.push({ provider: 'fallback', codes: [...codes] }); throw new Error('synthetic detail fallback failure'); },
  });
  assert.deepEqual(quotes, {});
  assert.deepEqual(calls, [{ provider: 'primary', codes: ['sh600000'] }, { provider: 'fallback', codes: ['sh600000'] }]);
});

function detailsHarness({ cache = {}, metadata = {}, coordinator = new RefreshCoordinator({ execute: async () => {}, now: () => NOW }), loadDisclosure, fetchQuotes } = {}) {
  const start = source.indexOf('function holdingsCacheIsFresh(');
  const end = source.indexOf('function inferFundType(', start);
  assert.ok(start >= 0 && end > start, 'the production disclosure, toggle and detail functions must exist');
  const tasks = [], renders = [], toasts = [], disclosureCalls = [], quoteCalls = [];
  const dependencies = {
    holdingsCache: cache, holdingsMetaCache: metadata, fundHoldingsRequests: new Map(), TTL, Date: FixedDate,
    fundsData: [FUND, { code: '012920', name: '合成海外基金(QDII)' }],
    fundTypeCache: { [FUND.code]: { type: '混合型' }, '012920': { type: 'QDII' } },
    fundFeeCache: { [FUND.code]: null, '012920': null },
    refreshCoordinator: coordinator, throwIfAborted, isRefreshAbort,
    loadFundHoldingsFeature: async () => ({ fetchFundHoldings: async (code, options) => {
      disclosureCalls.push({ code, signal: options?.signal });
      if (!loadDisclosure) assert.fail('no disclosure request expected');
      return loadDisclosure(code, options);
    } }),
    fetchHoldingsQuotes: async (code, rows, signal) => {
      quoteCalls.push({ code, signal });
      if (!fetchQuotes) assert.fail('no separate detail quote request expected');
      return fetchQuotes(code, rows, signal);
    },
    renderFundList: data => renders.push(data), showToast: message => toasts.push(message),
    inferFundType: () => '混合型', tasks,
  };
  const state = new Function(...Object.keys(dependencies), `
    let expandedFund = null, loadingDetails = null, detailToggleGeneration = 0, detailController = null, detailRefreshGeneration = null;
    let quoteDiagnosticsPromise = Promise.resolve({}), quoteDiagnosticsRuntime = null;
    ${source.slice(start, end)}
    const realDetails = fetchFundDetails;
    fetchFundDetails = function(...args) { const task = realDetails(...args); tasks.push(task); return task; };
    return { toggle: toggleFundDetail, fetchDetails: fetchFundDetails, loadDisclosure: loadFundHoldings,
      expanded: () => expandedFund, controller: () => detailController,
      setExpanded: code => { expandedFund = code; }, requests: fundHoldingsRequests };
  `)(...Object.values(dependencies));
  return { ...state, cache, metadata, coordinator, tasks, renders, toasts, disclosureCalls, quoteCalls };
}

test('a detail opened during a real refresh consumes its pending union with one actual provider acquisition', async () => {
  let entered, resolve;
  const started = new Promise(done => { entered = done; });
  const pending = new Promise(done => { resolve = done; });
  const cache = {}, primaryCalls = [];
  const coordinator = new RefreshCoordinator({ now: () => NOW, execute: async context => {
    const items = [{ ...stock('600000'), quoteCode: 'sh600000' }];
    const plan = createSecurityQuotePlan({ generation: context.generation, snapshots: [{ validated: true, status: 'ok', items }] });
    const scope = createGenerationResourceScope({ context, now: () => NOW, plan: { generation: context.generation, resources: [] } });
    const result = await executeSecurityQuotePlan({ plan, scope, now: () => NOW, normalizeTime: normalizeTencentQuoteTime,
      fetchEastmoney: async codes => { primaryCalls.push([...codes]); entered(); return pending; },
      fetchBridge: async () => { assert.fail('the valid primary union needs no fallback'); },
    });
    context.commit(() => { cache[FUND.code] = items.map(item => ({ ...item, ...result.securityQuotes[item.quoteCode] })); });
    return scope.snapshot();
  } });
  const refresh = coordinator.request({ trigger: 'synthetic_pending_refresh' });
  await started;
  const h = detailsHarness({ cache, coordinator });
  h.setExpanded(FUND.code);
  const detail = h.fetchDetails(FUND.code);
  await new Promise(done => setImmediate(done));
  assert.deepEqual(primaryCalls, [['sh600000']]);
  assert.deepEqual(h.disclosureCalls, []);
  assert.deepEqual(h.quoteCalls, []);
  assert.deepEqual(h.renders, []);
  resolve({ data: { diff: [em('sh600000', { f3: 0 })] } });
  const outcome = await refresh;
  await detail;
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.result.requests, 1);
  assert.equal(cache[FUND.code][0].change, 0);
  assert.equal(cache[FUND.code][0].quoteTime, TIME);
  assert.deepEqual(h.disclosureCalls, []);
  assert.deepEqual(h.quoteCalls, []);
});

test('closing and reopening a detail aborts its old request and keeps the newer quote when the old result arrives last', async () => {
  const waiting = [], started = [];
  const quoteHarness = harness({ fetchPrimary: async (_url, options) => {
    return new Promise(resolve => { waiting.push({ resolve, signal: options.signal }); started.splice(0).forEach(done => done()); });
  } });
  const waitForCalls = async count => { while (waiting.length < count) await new Promise(done => started.push(done)); };
  const h = detailsHarness({ cache: { [FUND.code]: [stock('600000')] }, fetchQuotes: quoteHarness.fetchQuotes });
  await h.toggle(FUND.code);
  await waitForCalls(1);
  await h.toggle(FUND.code);
  assert.equal(h.expanded(), null);
  assert.equal(waiting[0].signal.aborted, true);
  await h.toggle(FUND.code);
  await waitForCalls(2);
  assert.equal(waiting[1].signal.aborted, false);
  waiting[1].resolve(Response.json({ data: { diff: [em('sh600000', { f3: 0 })] } }));
  await h.tasks[1];
  assert.equal(h.cache[FUND.code][0].change, 0);
  waiting[0].resolve(Response.json({ data: { diff: [em('sh600000', { f3: 99 })] } }));
  await assert.rejects(h.tasks[0], { name: 'AbortError' });
  assert.equal(h.expanded(), FUND.code);
  assert.equal(h.cache[FUND.code][0].change, 0);
  assert.equal(h.cache[FUND.code][0].quoteTime, TIME);
  assert.equal(quoteHarness.primaryCalls.length, 2);
  assert.deepEqual(quoteHarness.fallbackCalls, []);
  assert.deepEqual(h.toasts, []);
});

test('switching detail funds cancels the old pending quotes without publishing them into either disclosure', async () => {
  const waiting = [], started = [];
  const quoteHarness = harness({ fetchPrimary: async (_url, options) => new Promise(resolve => {
    waiting.push({ resolve, signal: options.signal }); started.splice(0).forEach(done => done());
  }) });
  const waitForCalls = async count => { while (waiting.length < count) await new Promise(done => started.push(done)); };
  const h = detailsHarness({ cache: { [FUND.code]: [stock('600000')], '012920': [stock('600001')] }, fetchQuotes: quoteHarness.fetchQuotes });
  await h.toggle(FUND.code);
  await waitForCalls(1);
  await h.toggle('012920');
  await waitForCalls(2);
  assert.equal(waiting[0].signal.aborted, true);
  assert.equal(waiting[1].signal.aborted, false);
  waiting[0].resolve(Response.json({ data: { diff: [em('sh600000', { f3: 99 })] } }));
  await assert.rejects(h.tasks[0], { name: 'AbortError' });
  assert.equal(Number.isFinite(h.cache[FUND.code][0].change), false);
  assert.equal(Number.isFinite(h.cache['012920'][0].change), false);
  waiting[1].resolve(Response.json({ data: { diff: [em('sh600001', { f3: -1 })] } }));
  await h.tasks[1];
  assert.equal(h.expanded(), '012920');
  assert.equal(h.cache['012920'][0].change, -1);
  assert.equal(quoteHarness.primaryCalls.length, 2);
  assert.deepEqual(h.toasts, []);
});

test('a cancelled disclosure load never writes a late payload or error marker into existing or absent caches', async () => {
  for (const warm of [false, true]) {
    let entered, resolve;
    const started = new Promise(done => { entered = done; });
    const pending = new Promise(done => { resolve = done; });
    const cache = warm ? { [FUND.code]: [stock('600000', 'sh', { change: 7 })] } : {};
    const metadata = warm ? { [FUND.code]: { status: 'ok', cachedAt: NOW - TTL.HOLDINGS - 1, reportDate: '2026-06-30' } } : {};
    const beforeCache = structuredClone(cache), beforeMetadata = structuredClone(metadata);
    const h = detailsHarness({ cache, metadata, loadDisclosure: async () => { entered(); return pending; } });
    const controller = new AbortController(), task = h.loadDisclosure(FUND.code, { signal: controller.signal });
    await started;
    controller.abort('disclosure_no_longer_current');
    resolve({ status: 'ok', reportDate: '2026-06-30', source: 'synthetic-holdings', sourceStatus: 'ok',
      wireVersion: 1, fetchedAt: new Date(NOW).toISOString(), items: [stock('600001')] });
    await assert.rejects(task, { name: 'AbortError' });
    assert.deepEqual(h.cache, beforeCache);
    assert.deepEqual(h.metadata, beforeMetadata);
    assert.equal(h.requests.size, 0);
    assert.equal(h.disclosureCalls.length, 1);
  }
});

test('starting the production refresh aborts an active detail before any refresh acquisition boundary', async () => {
  const start = source.indexOf('async function runRefresh(');
  const end = source.indexOf('function updateLatestSourceSummary(', start);
  assert.ok(start >= 0 && end > start, 'the real refresh entry must exist');
  const controller = new AbortController();
  const order = [];
  controller.signal.addEventListener('abort', () => order.push('detail_aborted'), { once: true });
  const sentinel = Object.assign(new Error('synthetic stop before acquiring refresh data'), { name: 'AbortError' });
  const dependencies = { detailController: controller, detailRefreshGeneration: 0, isRefreshAbort,
    requireCurrentRefresh: () => order.push('refresh_checked'),
    reconcileActiveFundState: () => { order.push('refresh_preflight'); throw sentinel; },
  };
  const runRefresh = new Function(...Object.keys(dependencies), `${source.slice(start, end)}\nreturn runRefresh;`)(...Object.values(dependencies));
  await assert.rejects(runRefresh({ generation: 1, signal: new AbortController().signal }, {}), { name: 'AbortError' });
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(order, ['refresh_checked', 'detail_aborted', 'refresh_preflight']);
});

test('the refresh abort guard preserves same-generation detail consumers and does not let an obsolete refresh cancel them', async () => {
  const start = source.indexOf('async function runRefresh(');
  const end = source.indexOf('function updateLatestSourceSummary(', start);
  for (const obsolete of [false, true]) {
    const controller = new AbortController(), order = [];
    const sentinel = Object.assign(new Error('synthetic read-only refresh boundary'), { name: 'AbortError' });
    const dependencies = { detailController: controller, detailRefreshGeneration: 7, isRefreshAbort,
      requireCurrentRefresh: () => { order.push('refresh_checked'); if (obsolete) throw sentinel; },
      reconcileActiveFundState: () => { order.push('refresh_preflight'); throw sentinel; },
    };
    const runRefresh = new Function(...Object.keys(dependencies), `${source.slice(start, end)}\nreturn runRefresh;`)(...Object.values(dependencies));
    await assert.rejects(runRefresh({ generation: obsolete ? 6 : 7, signal: new AbortController().signal }, {}), { name: 'AbortError' });
    assert.equal(controller.signal.aborted, false);
    assert.deepEqual(order, obsolete ? ['refresh_checked'] : ['refresh_checked', 'refresh_preflight']);
  }
});
