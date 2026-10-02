import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { holdingQuoteCode } from '../js/fund-holdings.js';
import { classifyFundMarket } from '../js/freshness.js';
import { calculateHoldingsEstimate, normalizeTencentQuoteTime } from '../js/holdings-estimate.js';
import { RefreshCoordinator } from '../js/runtime/refresh-coordinator.js';
import { throwIfAborted } from '../js/runtime/request-signal.js';
import { parseQuoteTimestamp } from '../js/runtime/quote-contract.js';
import * as quotes from '../js/runtime/security-quote-batch.js';

const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const between = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'real app function boundaries must exist');
  return source.slice(first, last);
};
const quoteBody = between('async function fetchHoldingsQuotes(', 'function fmtQuoteNav(');
const detailBody = between('async function fetchFundDetails(', 'function inferFundType(');
const FUND = { code: '005844', name: '合成境内混合基金' };
const epoch = time => Date.parse(time.replace(' ', 'T') + '+08:00');
const row = (extra = {}) => ({ code: '600000', market: 'sh', name: '合成股票', ratio: 60,
  quoteCode: 'sh600000', change: 0, quoteTime: '2026-09-29 15:00:00', ...extra });

function harness({ now = '2026-09-30 14:00:00', rows = [row()], primary = [], failed = false, coordinator } = {}) {
  const at = epoch(now), primaryCalls = [], bridgeCalls = [], renders = [];
  class Clock extends Date { static now() { return at; } }
  const dependencies = {
    Date: Clock, fundsData: [FUND], holdings: [FUND], classifyFundMarket, parseQuoteTimestamp,
    holdingsCache: { [FUND.code]: rows }, holdingsMetaCache: {},
    loadingDetails: null, expandedFund: FUND.code,
    fundTypeCache: { [FUND.code]: {} }, fundFeeCache: { [FUND.code]: null },
    refreshCoordinator: coordinator || { activePromise: null }, throwIfAborted,
    loadFundHoldings: async () => assert.fail('warm disclosure must not be re-acquired'),
    loadFundHoldingsFeature: async () => ({ holdingQuoteCode }),
    loadSecurityQuoteFeature: async () => quotes,
    loadHoldingsEstimateFeature: async () => ({ normalizeTencentQuoteTime }),
    normalizeTencentQuoteTime, TIMING: { INDEX_JSONP_TIMEOUT: 100 },
    fetchWithTimeout: async url => {
      primaryCalls.push(new URL(url).searchParams.get('secids'));
      if (failed) throw new Error('synthetic primary failure');
      return Response.json({ data: { diff: primary } });
    },
    loadQuoteBridgeFeature: async () => ({ securityQuotes: async codes => {
      bridgeCalls.push([...codes]);
      if (failed) throw new Error('synthetic fallback failure');
      return { quotes: [] };
    } }),
    renderFundList: () => renders.push(structuredClone(rows)), inferFundType: () => '混合型',
  };
  const fetchQuotes = new Function(...Object.keys(dependencies), `${quoteBody}\nreturn fetchHoldingsQuotes;`)(...Object.values(dependencies));
  dependencies.fetchHoldingsQuotes = fetchQuotes;
  const fetchDetails = new Function(...Object.keys(dependencies), `${detailBody}\nreturn fetchFundDetails;`)(...Object.values(dependencies));
  return { fetchDetails, fetchQuotes, rows, primaryCalls, bridgeCalls, renders, at };
}

test('warm cross-day detail after a failed real generation fetches only missing securities and retains the original valid clock on failure', async () => {
  let release;
  const coordinator = new RefreshCoordinator({ execute: async () => {
    await new Promise(resolve => { release = resolve; });
    throw new Error('synthetic refresh failure');
  } });
  const generation = coordinator.request({ trigger: 'synthetic_failure' });
  const h = harness({ coordinator, failed: true });
  const details = h.fetchDetails(FUND.code);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.primaryCalls, []);
  release();
  assert.equal((await generation).status, 'failed');
  await details;
  assert.deepEqual(h.primaryCalls, ['1.600000']);
  assert.deepEqual(h.bridgeCalls, [['sh600000']]);
  assert.equal(h.rows[0].change, 0);
  assert.equal(h.rows[0].quoteTime, '2026-09-29 15:00:00');
  assert.ok(h.renders.length);
  const estimate = calculateHoldingsEstimate(h.rows, { now: h.at, reportDate: '2026-06-30', minQuotes: 1 });
  assert.equal(estimate.quoteCount, 0);
  assert.equal(estimate.available, false);
});

test('warm invalid, future and null detail values are re-acquired without re-requesting a fresh valid zero', async () => {
  for (const invalid of [{ quoteTime: 'not-a-clock' }, { quoteTime: '2026-09-30 14:00:01' },
    { quoteTime: '' }, { change: null }]) {
    const rows = [row(invalid), row({ code: '600001', quoteCode: 'sh600001', quoteTime: '2026-09-30 13:59:00' })];
    const h = harness({ rows, primary: [{ f12: '600000', f13: 1, f2: 10, f3: 2, f124: epoch('2026-09-30 14:00:00') / 1000 }] });
    await h.fetchDetails(FUND.code);
    assert.deepEqual(h.primaryCalls, ['1.600000']);
    assert.deepEqual(h.bridgeCalls, []);
    assert.equal(rows[0].change, 2);
    assert.equal(rows[0].quoteTime, '2026-09-30 14:00:00');
    assert.equal(rows[1].change, 0);
    assert.equal(rows[1].quoteTime, '2026-09-30 13:59:00');
  }
});

test('a warm valid recent zero makes no additional detail provider acquisition', async () => {
  const h = harness({ rows: [row({ quoteTime: '2026-09-30 13:59:00' })] });
  await h.fetchDetails(FUND.code);
  assert.deepEqual(h.primaryCalls, []);
  assert.deepEqual(h.bridgeCalls, []);
  assert.equal(h.rows[0].change, 0);
});

test('legal weekend and holiday histories survive without a detail refresh or a manufactured today value', async () => {
  for (const [now, quoteTime] of [['2026-09-20 14:00:00', '2026-09-18 15:00:00'],
    ['2026-10-06 14:00:00', '2026-09-30 15:00:00']]) {
    const h = harness({ now, rows: [row({ quoteTime })] });
    await h.fetchDetails(FUND.code);
    assert.deepEqual(h.primaryCalls, []);
    assert.deepEqual(h.bridgeCalls, []);
    assert.equal(h.rows[0].change, 0);
    assert.equal(h.rows[0].quoteTime, quoteTime);
  }
});

test('US warm quotes compare exchange-local dates, not China midnight, and refresh only after the real age boundary', async () => {
  const stock = row({ code: 'AAPL', market: 'us', quoteCode: 'usAAPL', quoteTime: '2026-09-29 23:59:00' });
  const h = harness({ now: '2026-09-30 00:02:00', rows: [stock], failed: true });
  await h.fetchDetails(FUND.code);
  assert.deepEqual(h.bridgeCalls, []);
  assert.equal(stock.change, 0);
  assert.equal(stock.quoteTime, '2026-09-29 23:59:00');
  const later = harness({ now: '2026-09-30 00:10:00', rows: [stock], failed: true });
  await later.fetchDetails(FUND.code);
  assert.deepEqual(later.bridgeCalls, [['usAAPL']]);
  assert.equal(stock.quoteTime, '2026-09-29 23:59:00');
});

test('a failed detail batch retains only prior valid same-identity clocks, never future or reassigned prices', async () => {
  const rows = [row(), row({ code: '600001', quoteCode: 'sz600001', change: 9 }),
    row({ code: '600002', quoteCode: 'sh600002', quoteTime: '2026-09-30 14:00:01' }),
    row({ code: '000660', market: 'unknown', quoteCode: 'kr000660', change: 8 })];
  const h = harness({ rows, failed: true });
  await h.fetchQuotes(FUND.code, rows);
  assert.equal(rows[0].change, 0);
  assert.equal(rows[0].quoteTime, '2026-09-29 15:00:00');
  for (const invalid of rows.slice(1)) {
    assert.equal(Number.isFinite(invalid.change), false);
    assert.equal(Boolean(invalid.quoteTime), false);
  }
  assert.deepEqual(h.primaryCalls, ['1.600000,1.600001,1.600002']);
});

test('an older successful provider row cannot overwrite a newer valid same-identity cache row', async () => {
  const h = harness({ rows: [row({ change: 7, quoteTime: '2026-09-30 13:40:00' })],
    primary: [{ f12: '600000', f13: 1, f2: 10, f3: 2, f124: epoch('2026-09-30 13:30:00') / 1000 }] });
  await h.fetchQuotes(FUND.code, h.rows);
  assert.equal(h.rows[0].change, 7);
  assert.equal(h.rows[0].quoteTime, '2026-09-30 13:40:00');
});

test('monotonic retention compares the original validated clock including subsecond precision', async () => {
  const quoteTime = '2026-09-30T05:40:00.999Z';
  const h = harness({ rows: [row({ change: 7, quoteTime })],
    primary: [{ f12: '600000', f13: 1, f2: 10, f3: 2, f124: epoch('2026-09-30 13:40:00') / 1000 }] });
  await h.fetchQuotes(FUND.code, h.rows);
  assert.equal(h.rows[0].change, 7);
  assert.equal(h.rows[0].quoteTime, quoteTime);
});

test('detail policy fails closed on absent or non-record rows without inventing requests', () => {
  for (const stock of [null, undefined, 1, '600000', [], true]) {
    const state = quotes.assessDetailSecurityQuote(stock, { now: epoch('2026-09-30 14:00:00') });
    assert.equal(state.displayChange, null);
    assert.equal(state.needsRefresh, false);
    assert.ok(Object.isFrozen(state));
  }
});

test('detail policy is strict, immutable, preserves zero, and does not authorize a model from a historical display', () => {
  assert.equal(typeof quotes.assessDetailSecurityQuote, 'function');
  const input = Object.freeze(row()), before = structuredClone(input);
  const state = quotes.assessDetailSecurityQuote(input, { now: epoch('2026-09-30 14:00:00') });
  assert.equal(state.displayChange, 0);
  assert.equal(state.status, 'historical');
  assert.equal(state.needsRefresh, true);
  assert.equal(state.sourceTime, '2026-09-29 15:00:00');
  assert.equal(state.todayCandidate, false);
  assert.ok(Object.isFrozen(state));
  assert.deepEqual(input, before);
  for (const value of [null, NaN, Infinity, '2026-09-30', 0]) {
    const invalidClock = quotes.assessDetailSecurityQuote(input, { now: value });
    assert.equal(invalidClock.displayChange, null);
    assert.equal(invalidClock.needsRefresh, false);
  }
});

test('policy discloses holidays and unverified calendars instead of inventing a current market state', () => {
  assert.equal(typeof quotes.assessDetailSecurityQuote, 'function');
  const holiday = quotes.assessDetailSecurityQuote(row({ quoteTime: '2026-09-30 15:00:00' }), { now: epoch('2026-10-06 14:00:00') });
  assert.equal(holiday.status, 'historical');
  assert.equal(holiday.needsRefresh, false);
  assert.match(holiday.caption, /旧行情.*2026-09-30 15:00:00/);
  for (const stock of [row({ code: '00700', market: 'hk', quoteCode: 'hk00700' }),
    row({ code: '000660', market: 'kr', quoteCode: 'kr000660' })]) {
    const state = quotes.assessDetailSecurityQuote(stock, { now: epoch('2026-09-30 14:00:00') });
    assert.equal(state.needsRefresh, true);
    assert.match(state.caption, /日历未验证/);
    assert.doesNotMatch(state.caption, /实时|休市|已收盘/);
  }
});
