import test from 'node:test';
import assert from 'node:assert/strict';
import { TTL } from '../js/config.js';
import { executeRefreshPlan } from '../js/runtime/refresh-execution.js';
import { RefreshCoordinator } from '../js/runtime/refresh-coordinator.js';
import { makeRefreshResourceEntry } from '../js/runtime/refresh-resource-cache.js';
import { getSourceHealth, listDataSources, recordSourceFailure } from '../js/runtime/source-registry.js';
import { calculateOverseasEstimate } from '../js/overseas-model.js';

// Synthetic inputs only. Exercise the production executor, generation guards,
// source-health registry and real Storage mutation boundary together.
const NOW = Date.parse('2026-09-30T06:00:00Z');
const CODE = '005844';
const SOURCE = 'quarterly-holdings-model';
const MODEL_SOURCE = 'market-model';
const INDEX_CODES = ['sh000001', 'sh000300', 'usINX', 'usNDX'];
const INDEX_KEY = `indices:${INDEX_CODES.join(',')}`;
const HOLDING = { code: CODE, name: 'Synthetic 混合基金', shares: 0, cost: null };
const clone = value => structuredClone(value);
const abortError = () => Object.assign(new Error('Synthetic cancellation'), { name: 'AbortError' });
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function estimateRow(at = NOW, code = CODE) {
  return { code, name: 'Synthetic fund', status: 'ok', est_change: 0,
    source_quote: { fundCode: code, fundName: 'Synthetic fund', market: 'cn', assetKind: 'fund',
      valueKind: 'intraday_estimate', value: 1, changePct: 0, baseNav: 1,
      baseNavDate: '2026-09-29', targetDate: '2026-09-30', sourceId: 'sinan-estimate-proxy',
      sourceTier: 'primary', status: 'realtime', observedAt: new Date(at - 1000).toISOString(),
      fetchedAt: new Date(at).toISOString(), reasonCodes: [] } };
}
function nav() {
  return { nav: 1.1, prevNav: 1, date: '2026-09-29', prevDate: '2026-09-28', change: 10,
    changeAmt: 0.1, fundName: 'Synthetic fund', meta: { manager: 'Synthetic manager', currentRate: '0.15' } };
}
function disclosure(at = NOW) {
  return { status: 'ok', sourceStatus: 'ok', wireVersion: 2, reportDate: '2026-06-30',
    fetchedAt: new Date(at).toISOString(), source: 'sinan-holdings-proxy',
    items: [{ code: '600001', market: 'sh', name: 'Synthetic stock', ratio: 20 }] };
}
function indexQuotes(at = NOW) {
  return INDEX_CODES.map((code, index) => ({ code, price: 100 + index, changePct: index ? null : 0,
    observedAt: new Date(at - 1000).toISOString(), status: 'current' }));
}
function goldQuote(at = NOW) {
  return { price: 100, changePct: 0, observedAt: new Date(at - 1000).toISOString(),
    status: 'current', cached: false };
}

function cacheFixture(at = NOW - 1000, { holdingAt = at } = {}) {
  const resources = {};
  const add = (key, payload, sourceDate, fetchedAt = at) => {
    const entry = makeRefreshResourceEntry(key, payload, { now: fetchedAt, fetchedAt, sourceDate });
    assert.ok(entry, `Synthetic fixture must satisfy the real contract: ${key}`);
    resources[key] = entry;
  };
  add(`estimates:${CODE}`, { source: 'sinan-estimate-proxy', codes: [CODE], rows: [estimateRow(at)] }, '2026-09-30');
  add(`nav:${CODE}`, { ...nav(), code: CODE, source: 'eastmoney-official-nav', status: 'current' }, '2026-09-29');
  add(`meta:${CODE}`, { code: CODE, source: 'eastmoney-official-nav', meta: nav().meta }, '2026-09-29');
  add(`holdings:${CODE}`, { ...disclosure(holdingAt), code: CODE }, '2026-06-30', holdingAt);
  add(INDEX_KEY, { source: 'tencent-market-quote', codes: [...INDEX_CODES], quotes: indexQuotes(at) }, '2026-09-30');
  add('gold:AU9999', { ...goldQuote(at), code: 'AU9999', source: 'eastmoney-security-quote' }, '2026-09-30');
  return { data: [], refreshResources: resources, fetchedAt: at, expiresAt: at + TTL.INTRADAY,
    source: 'fund-estimate', holdingsHash: 'synthetic' };
}

function harness({ snapshot = [HOLDING], previous = null, options = {}, clients: overrides = {}, halfOpen = false } = {}) {
  let clock = NOW;
  const calls = { estimates: 0, nav: 0, holdings: 0, indices: 0, gold: 0, eastmoney: 0, bridge: 0 };
  const events = [];
  const writes = [];
  const claims = [];
  const rows = new Map();
  const diagnostics = [];
  let context;
  const clients = {
    estimates: async (active, _options, _context, dispatch) => dispatch(async () => {
      calls.estimates++;
      return new Map(active.map(h => [h.code, estimateRow(clock, h.code)]));
    }),
    nav: async () => { calls.nav++; return nav(); },
    holdings: async () => { calls.holdings++; return disclosure(clock); },
    indices: async () => { calls.indices++; return indexQuotes(clock); },
    gold: async (_signal, dispatch) => dispatch(async () => { calls.gold++; return goldQuote(clock); }),
    models: async () => [],
    qualifyHoldings: (_holding, items) => items.map(item => ({ ...item, quoteCode: `${item.market}${item.code}` })),
    calculateHoldings: async items => ({ status: 'synthetic', items: clone(items) }),
    normalizeTime: value => value,
    eastmoney: async codes => {
      calls.eastmoney++;
      return { data: { diff: codes.map(code => ({ f12: code.slice(2), f13: code.startsWith('sh') ? 1 : 0,
        f2: 100, f3: 0, f124: Math.floor(clock / 1000) })) } };
    },
    bridge: async () => { calls.bridge++; return { quotes: [] }; },
    ...overrides,
  };
  const ui = {
    primary: (_holding, raw, move) => raw || (move && { code: CODE, status: 'ok', latest_nav_move: move }),
    publish: (holding, raw) => { events.push(['publish', holding.code, clone(raw)]); rows.set(holding.code, { ...raw, code: holding.code }); },
    enriched: (holding, raw, move, estimate, models) => { events.push(['enriched', holding.code, clone({ raw, move, estimate, models })]); },
    holdings: (code, payload) => { events.push(['holdings', code, clone(payload)]); },
    metadata: (code, meta) => { events.push(['metadata', code, clone(meta)]); },
    market: (indices, gold, components) => { events.push(['market', clone({ indices, gold, components })]); },
    failure: (holding, error) => { events.push(['failure', holding.code, error.code || error.name]); },
    cacheData: () => [...rows.values()].map(clone),
    holdingsHash: () => 'synthetic',
    complete: () => { events.push(['complete']); },
  };
  const coordinator = new RefreshCoordinator({
    now: () => clock, sources: listDataSources(), sourceHealthPolicy: { failureThreshold: 1, cooldownMs: 5 },
    onDiagnostic: entry => diagnostics.push(entry),
    execute(realContext) {
      context = Object.freeze({ ...realContext, claimSourceAttempt(source) {
        claims.push(source);
        return realContext.claimSourceAttempt(source);
      } });
      return executeRefreshPlan({ context, snapshot, options, previous, clients, ui,
        storage: { setItem(key, bytes) { writes.push({ key, value: JSON.parse(bytes) }); return true; } }, now: () => clock });
    },
  });
  if (halfOpen) coordinator.registry = recordSourceFailure(coordinator.registry, SOURCE, { reason: 'synthetic initial failure' }, NOW - 10);
  return { calls, events, writes, claims, diagnostics, coordinator,
    get context() { return context; },
    setNow(value) { clock = value; },
    run(trigger = 'manual') { return coordinator.request({ trigger }); },
    health(source = SOURCE) { return getSourceHealth(coordinator.snapshot().sourceRegistry, source); },
    failSource(source, at = NOW - 10) {
      coordinator.registry = recordSourceFailure(coordinator.registry, source, { reason: 'synthetic initial failure' }, at);
    },
  };
}

test('all primary and NAV failures cannot persist or renew the fund aggregate when indices succeed', async () => {
  const old = cacheFixture();
  delete old.refreshResources[`estimates:${CODE}`];
  delete old.refreshResources[`nav:${CODE}`];
  const before = clone(old);
  const h = harness({ previous: old, clients: {
    estimates: async (_snapshot, _options, _context, dispatch) => dispatch(async () => new Map()),
    nav: async () => null,
    holdings: async () => null,
  } });
  const result = await h.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'ALL_FUNDS_FAILED');
  assert.ok(h.events.some(event => event[0] === 'market'), 'Valid indices may still update memory UI');
  assert.equal(h.writes.length, 0, 'Failed nonempty portfolio must not refresh the fund-cache clock');
  assert.deepEqual(old, before);
});

for (const outcome of ['success', 'failure', 'empty', 'abort']) {
  test(`half-open holdings probe is settled or released after ${outcome}`, async () => {
    const started = deferred();
    const h = harness({ halfOpen: true, clients: {
      holdings: async (_code, signal) => {
        started.resolve();
        if (outcome === 'failure') throw new Error('Synthetic upstream outage');
        if (outcome === 'empty') return null;
        if (outcome === 'abort') return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
        return disclosure();
      },
    } });
    const task = h.run();
    await started.promise;
    if (outcome === 'abort') h.coordinator.stop('synthetic stop');
    const result = await task;
    assert.equal(result.status, outcome === 'abort' ? 'aborted' : 'completed');
    const health = h.health();
    assert.equal(health.halfOpenProbeActive, false, 'No path may leave the one half-open slot occupied');
    assert.equal(health.halfOpenProbeAt, null);
    if (outcome === 'success') {
      assert.equal(health.status, 'healthy');
      assert.equal(health.lastSuccessAt, NOW);
    } else if (outcome !== 'abort') {
      assert.equal(health.status, 'cooldown');
      assert.equal(health.lastFailureAt, NOW);
      assert.equal(health.consecutiveFailures, 2);
    } else {
      assert.equal(health.consecutiveFailures, 1, 'Cancellation must not poison upstream health');
      assert.equal(h.writes.length, 0);
    }
    assert.equal(h.claims.filter(source => source === SOURCE).length, 1);
  });
}

test('warm resources within the 12-hour holdings TTL load nothing stable and claim no source', async () => {
  const previous = cacheFixture(NOW - 1000, { holdingAt: NOW - TTL.HOLDINGS + 1 });
  const before = clone(previous);
  const h = harness({ previous, options: { force: false }, halfOpen: true });
  const result = await h.run('timer');
  assert.equal(result.status, 'completed');
  for (const client of ['estimates', 'nav', 'holdings', 'indices', 'gold']) assert.equal(h.calls[client], 0, client);
  assert.deepEqual(h.claims, []);
  assert.equal(h.health().halfOpenProbeActive, false);
  assert.equal(h.health().lastSuccessAt, null, 'A cache hit is not new upstream health evidence');
  assert.equal(h.writes.length, 0, 'Cache-only reads cannot restage or renew the envelope');
  assert.equal(result.result.diagnostics.requests, 1, 'Volatile security union is the sole actual request');
  assert.deepEqual(result.result.diagnostics.providers, { 'eastmoney-security-quote': 1 });
  assert.deepEqual(previous, before);
});

test('manual refresh forces volatile resources only, not NAV, holdings or metadata', async () => {
  const previous = cacheFixture();
  const h = harness({ previous, options: { force: true, forceStable: [`nav:${CODE}`, `holdings:${CODE}`, `meta:${CODE}`] } });
  const result = await h.run('manual');
  assert.equal(result.status, 'completed');
  assert.equal(h.calls.nav, 0);
  assert.equal(h.calls.holdings, 0);
  assert.equal(h.calls.estimates, 1);
  assert.equal(h.calls.indices, 1);
  assert.equal(h.calls.gold, 1);
  assert.deepEqual(h.claims, []);
  assert.equal(h.writes.length, 1);
  for (const key of [`nav:${CODE}`, `holdings:${CODE}`, `meta:${CODE}`]) {
    assert.deepEqual(h.writes[0].value.refreshResources[key], previous.refreshResources[key]);
  }
});

for (const mode of ['diagnostic-force', 'missing']) {
  test(`${mode} metadata acquires its shared official endpoint once while preserving the fresh NAV envelope`, async () => {
    const previous = cacheFixture();
    const originalNav = clone(previous.refreshResources[`nav:${CODE}`]);
    if (mode === 'missing') delete previous.refreshResources[`meta:${CODE}`];
    const before = clone(previous);
    const requested = [];
    const nextMeta = { manager: 'Synthetic new manager', currentRate: '0.20' };
    const h = harness({ previous, options: { force: false,
      ...(mode === 'diagnostic-force' ? { forceStable: [`meta:${CODE}`] } : {}),
    }, clients: {
      nav: async code => {
        requested.push(code);
        return { ...nav(), date: '2026-09-30', prevDate: '2026-09-29', meta: nextMeta };
      },
    } });
    const result = await h.run(mode === 'diagnostic-force' ? 'diagnostic' : 'timer');
    assert.equal(result.status, 'completed');
    assert.deepEqual(requested, [CODE], 'Missing or explicitly forced metadata needs one real shared official acquisition');
    assert.equal(result.result.diagnostics.providers['eastmoney-official-nav'], 1);
    const shown = h.events.filter(event => event[0] === 'metadata').at(-1)[2];
    assert.deepEqual(shown, nextMeta);
    assert.equal(h.writes.length, 1);
    const persisted = h.writes[0].value.refreshResources;
    assert.deepEqual(persisted[`nav:${CODE}`], originalNav, 'Meta demand must not implicitly force or renew the warm NAV');
    const metadata = persisted[`meta:${CODE}`];
    assert.deepEqual(metadata.payload.meta, nextMeta);
    assert.equal(metadata.sourceDate, '2026-09-30', 'Metadata provenance comes from the actual response, not the warm NAV');
    assert.equal(metadata.fetchedAt, NOW);
    assert.equal(metadata.cachedAt, NOW);
    assert.equal(metadata.expiresAt, NOW + TTL.FUND_META);
    assert.equal(metadata.originalSource, 'eastmoney-official-nav');
    assert.deepEqual(previous, before);
  });
}

test('a slow metadata acquisition drains before the generation finishes and performs its only aggregate flush', async () => {
  const previous = cacheFixture();
  const entered = deferred();
  const pending = deferred();
  const next = { ...nav(), date: '2026-09-30', prevDate: '2026-09-29',
    meta: { manager: 'Synthetic delayed manager', currentRate: '0.25' } };
  const h = harness({ previous, options: { force: false, forceStable: [`meta:${CODE}`] }, clients: {
    nav: async () => { entered.resolve(); return pending.promise; },
  } });
  let finished = false;
  const task = h.run('diagnostic').then(result => { finished = true; return result; });
  await entered.promise;
  try {
    for (let turn = 0; turn < 3; turn++) await tick();
    assert.equal(finished, false, 'Late-added metadata tasks must not escape the final drain list');
    assert.equal(h.events.some(event => event[0] === 'complete'), false);
    assert.equal(h.writes.length, 0);
  } finally {
    h.setNow(NOW + 30000);
    pending.resolve(next);
    await task;
  }
  const result = await task;
  assert.equal(result.status, 'completed');
  assert.equal(h.writes.length, 1);
  const metadata = h.writes[0].value.refreshResources[`meta:${CODE}`];
  assert.deepEqual(metadata.payload.meta, next.meta);
  assert.equal(metadata.fetchedAt, NOW + 30000);
  assert.equal(metadata.sourceDate, '2026-09-30');
  assert.equal(result.result.diagnostics.providers['eastmoney-official-nav'], 1);
  const metadataEvent = h.events.findIndex(event => event[0] === 'metadata');
  const completedEvent = h.events.findIndex(event => event[0] === 'complete');
  assert.ok(metadataEvent >= 0 && completedEvent > metadataEvent);
});

test('cancelling a pending late-added metadata task produces no unhandled rejection or late UI/cache write', async () => {
  const previous = cacheFixture();
  const before = clone(previous);
  const entered = deferred();
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const h = harness({ previous, options: { force: false, forceStable: [`meta:${CODE}`] }, clients: {
      nav: async (_code, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
        entered.resolve();
      }),
    } });
    const task = h.run('diagnostic');
    await entered.promise;
    const committedBeforeAbort = h.events.length;
    h.coordinator.stop('synthetic pending-meta stop');
    const result = await task;
    await tick();
    assert.ok(['aborted', 'superseded'].includes(result.status));
    assert.deepEqual(unhandled, []);
    assert.equal(h.events.length, committedBeforeAbort);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(previous, before);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('NAV fallback and enrichment share one actual request and one metadata acquisition', async () => {
  const h = harness({ clients: {
    estimates: async (_snapshot, _options, _context, dispatch) => dispatch(async () => new Map()),
  } });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.equal(h.calls.nav, 1);
  assert.equal(h.events.filter(event => event[0] === 'metadata').length, 1);
  assert.equal(h.events.filter(event => event[0] === 'enriched').length, 1);
  assert.equal(result.result.diagnostics.providers['eastmoney-official-nav'], 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].value.refreshResources[`nav:${CODE}`].fetchedAt, NOW);
  assert.equal(h.writes[0].value.refreshResources[`meta:${CODE}`].fetchedAt, NOW);
});

test('expired estimate fallback keeps original source identity and acquisition clocks without renewal', async () => {
  const previous = cacheFixture(NOW - TTL.INTRADAY - 1);
  // Leave only the expired estimate resource; every live resource is empty.
  for (const key of Object.keys(previous.refreshResources)) if (key !== `estimates:${CODE}`) delete previous.refreshResources[key];
  const original = clone(previous.refreshResources[`estimates:${CODE}`]);
  const h = harness({ previous, clients: {
    estimates: async (_snapshot, _options, _context, dispatch) => dispatch(async () => new Map()),
    nav: async () => null, holdings: async () => null,
    indices: async () => [], gold: async (_signal, dispatch) => dispatch(async () => null),
  } });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  const published = h.events.find(event => event[0] === 'publish')[2].source_quote;
  assert.equal(published.fundCode, CODE);
  assert.equal(published.sourceId, 'local-cache');
  assert.equal(published.sourceTier, 'cache');
  assert.equal(published.originalSource, 'sinan-estimate-proxy');
  assert.equal(published.originalSourceTier, 'primary');
  assert.equal(published.cacheState, 'stale');
  assert.equal(published.status, 'stale');
  assert.equal(published.fetchedAt, original.payload.rows[0].source_quote.fetchedAt);
  assert.equal(published.cachedAt, original.cachedAt);
  assert.equal(published.expiresAt, original.expiresAt);
  assert.equal(h.writes.length, 0);
  assert.deepEqual(previous.refreshResources[`estimates:${CODE}`], original);
  assert.deepEqual(result.result.diagnostics.providers, {
    'sinan-estimate-proxy': 1, 'tencent-market-quote': 1, 'eastmoney-security-quote': 1,
    'sinan-holdings-proxy': 1, 'eastmoney-official-nav': 1,
  });
});

test('a cached estimate with a different fund identity is rejected instead of reassigned', async () => {
  const previous = clone(cacheFixture());
  previous.refreshResources[`estimates:${CODE}`].payload.rows[0].source_quote.fundCode = '000001';
  const before = clone(previous);
  const h = harness({ previous, options: { force: false }, clients: {
    estimates: async (_snapshot, _options, _context, dispatch) => dispatch(async () => new Map()),
  } });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.equal(h.events.find(event => event[0] === 'publish')[2].source_quote, undefined);
  assert.equal(h.calls.nav, 0, 'A valid cached NAV fallback remains independently reusable');
  assert.equal(result.result.diagnostics.providers['sinan-estimate-proxy'], 1);
  assert.deepEqual(previous, before);
});

test('cold acquisition counts actual provider dispatches and makes only one aggregate Storage write', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].key, 'fuyu_funds_cache_v1');
  const diag = result.result.diagnostics;
  assert.equal(diag.requests, 6);
  assert.equal(diag.writeAttempts, 1);
  assert.equal(diag.cacheWrites, 1);
  assert.deepEqual(diag.providers, { 'sinan-estimate-proxy': 1, 'tencent-market-quote': 1,
    'eastmoney-security-quote': 2, 'sinan-holdings-proxy': 1, 'eastmoney-official-nav': 1 });
  const enrichment = h.events.find(event => event[0] === 'enriched')[2];
  assert.equal(enrichment.estimate.items[0].quoteCode, 'sh600001');
  assert.equal(enrichment.estimate.items[0].change, 0, 'A real zero change is preserved');
});

test('the detail UI receives the same generation security quotes and real disclosure-cache clock', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.status, 'completed');
  const detail = h.events.filter(event => event[0] === 'holdings').at(-1)[2];
  assert.equal(detail.cachedAt, NOW, 'Disclosure freshness must use the successful acquisition clock');
  assert.equal(detail.expiresAt, NOW + TTL.HOLDINGS);
  assert.equal(detail.items[0].quoteCode, 'sh600001');
  assert.equal(detail.items[0].change, 0, 'Detail stocks must consume the union result, not remain --');
  assert.equal(detail.items[0].quoteTime, '2026-09-30 14:00:00');
  assert.equal(h.calls.holdings, 1);
  assert.equal(h.calls.eastmoney, 1, 'Detail projection must not launch a second security request');
});

test('warm disclosure detail projection preserves the original clock rather than refreshing its 12-hour TTL', async () => {
  const acquiredAt = NOW - 3600000;
  const previous = cacheFixture(NOW - 1000, { holdingAt: acquiredAt });
  const h = harness({ previous, options: { force: false } });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  const detail = h.events.filter(event => event[0] === 'holdings').at(-1)[2];
  assert.equal(detail.cachedAt, acquiredAt);
  assert.equal(detail.expiresAt, acquiredAt + TTL.HOLDINGS);
  assert.equal(detail.items[0].change, 0);
  assert.equal(h.calls.holdings, 0);
  assert.equal(h.writes.length, 0);
});

test('a holdings cache expiring between planning and acquire claims health only for the actual request', async () => {
  const previous = cacheFixture(NOW - 1000, { holdingAt: NOW - TTL.HOLDINGS + 1 });
  let h;
  h = harness({ previous, options: { force: false }, halfOpen: true, clients: {
    // Models start after planning but before queued stable operations run.
    models: () => { h.setNow(NOW + 2); return []; },
  } });
  const result = await h.run('timer');
  assert.equal(result.status, 'completed');
  assert.equal(h.calls.holdings, 1);
  assert.equal(h.claims.filter(source => source === SOURCE).length, 1);
  assert.equal(h.health().halfOpenProbeActive, false);
  assert.equal(h.health().lastSuccessAt, NOW + 2);
  assert.equal(result.result.diagnostics.providers['sinan-holdings-proxy'], 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].value.refreshResources[`holdings:${CODE}`].cachedAt, NOW + 2);
});

test('empty portfolio may acquire market resources and persist once without requesting any fund', async () => {
  const h = harness({ snapshot: [] });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.result.refreshed, 0);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].value.data, []);
  assert.equal(h.calls.estimates, 0);
  assert.equal(h.calls.nav, 0);
  assert.equal(h.calls.holdings, 0);
  assert.deepEqual(h.claims, []);
  assert.equal(result.result.diagnostics.requests, 2);
});

test('51 active funds retain primary estimates through canonical provider batches of at most 50', async () => {
  const snapshot = Array.from({ length: 51 }, (_, index) => ({
    code: String(1000 + index).padStart(6, '0'), name: 'Synthetic QDII', shares: 0, cost: null,
  }));
  const batchSizes = [];
  const h = harness({ snapshot, clients: {
    estimates: async (active, _options, _context, dispatch) => dispatch(async () => {
      batchSizes.push(active.length);
      return new Map(active.map(holding => [holding.code, estimateRow(NOW, holding.code)]));
    }),
  } });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.deepEqual(batchSizes, [50, 1], 'The provider contract must not silently drop primary coverage at 51');
  const published = h.events.filter(event => event[0] === 'publish');
  assert.equal(published.length, 51);
  assert.deepEqual(published.map(event => event[2].source_quote?.fundCode), snapshot.map(holding => holding.code));
  assert.equal(result.result.diagnostics.providers['sinan-estimate-proxy'], 2);
  assert.equal(h.writes.length, 1);
  assert.equal(Object.keys(h.writes[0].value.refreshResources).filter(key => key.startsWith('estimates:')).length, 2);
});

test('selected AU9999 model uses the real China text clock accepted by the existing overseas calculator', async () => {
  const model = { min_weight: 100, version: 'synthetic-gold-v1',
    legs: [{ code: 'AU9999', weight: 100 }] };
  const h = harness({ clients: { models: async () => [model] } });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  const gold = h.events.find(event => event[0] === 'enriched')[2].models.AU9999;
  assert.deepEqual(gold, { price: 100, changePct: 0, sourceTime: '2026-09-30 13:59:59' });
  // Use the actual downstream parser through its public calculator, rather
  // than accepting an ISO string that parses generically but is rejected here.
  const calculated = calculateOverseasEstimate(model, {
    AU9999: { change: gold.changePct, time: gold.sourceTime },
  }, NOW);
  assert.equal(calculated.change, 0);
  assert.equal(calculated.usableWeight, 100);
  assert.equal(calculated.rejected.missingTime, 0);
  assert.equal(calculated.sourceTime, gold.sourceTime);
  assert.equal(h.calls.gold, 1, 'The already acquired market gold result is shared with the selected model');
  assert.equal(h.calls.bridge, 0);
});

test('market-model cooldown suppresses model-only acquisition without blocking domestic holdings', async () => {
  const requested = [];
  const h = harness({ clients: {
    models: async () => [{ min_weight: 100, legs: [{ code: 'jp7203', weight: 100 }] }],
    bridge: async (operation, codes) => {
      requested.push({ operation, codes });
      return { quotes: codes.map(code => ({ code, price: 100, changePct: 0, sourceTimeRaw: '2026-09-30 14:00:00' })) };
    },
  } });
  h.failSource(MODEL_SOURCE, NOW - 1); // cooldown expires at NOW + 4
  const healthBefore = h.health(MODEL_SOURCE);
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.deepEqual(requested, [], 'No model-only quote request may bypass the source cooldown');
  assert.equal(h.calls.eastmoney, 1, 'Domestic securities remain independent of model-source health');
  const enriched = h.events.find(event => event[0] === 'enriched')[2];
  assert.equal(enriched.estimate.items[0].change, 0);
  assert.equal(enriched.models.jp7203, undefined);
  assert.deepEqual(h.health(MODEL_SOURCE), healthBefore, 'A cooldown skip is not another failed acquisition');
});

for (const outcome of ['success', 'partial', 'failure', 'empty', 'null-change', 'abort']) {
  test(`market-model half-open probe settles or releases after ${outcome}`, async () => {
    const entered = deferred();
    const requested = [];
    const h = harness({ clients: {
      models: async () => [{ min_weight: outcome === 'partial' ? 50 : 100,
        legs: outcome === 'partial' ? [{ code: 'jp7203', weight: 50 }, { code: 'jp9984', weight: 50 }]
          : [{ code: 'jp7203', weight: 100 }] }],
      bridge: async (operation, codes, signal) => {
        requested.push({ operation, codes });
        entered.resolve();
        if (outcome === 'abort') return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
        if (outcome === 'failure') throw new Error('Synthetic model upstream outage');
        if (outcome === 'empty') return { quotes: [] };
        return { quotes: (outcome === 'partial' ? codes.slice(0, 1) : codes).map(code => ({ code, price: 100,
          changePct: outcome === 'null-change' ? null : 0, sourceTimeRaw: '2026-09-30 14:00:00' })) };
      },
    } });
    h.failSource(MODEL_SOURCE);
    const task = h.run();
    await entered.promise;
    if (outcome === 'abort') h.coordinator.stop('synthetic model stop');
    const result = await task;
    if (outcome === 'abort') await tick();
    assert.equal(result.status, outcome === 'abort' ? 'aborted' : 'completed');
    assert.deepEqual(requested, [{ operation: 'overseasComponents', codes: outcome === 'partial' ? ['jp7203', 'jp9984'] : ['jp7203'] }]);
    assert.equal(h.claims.filter(source => source === MODEL_SOURCE).length, 1);
    const health = h.health(MODEL_SOURCE);
    assert.equal(health.halfOpenProbeActive, false);
    assert.equal(health.halfOpenProbeAt, null);
    if (outcome === 'success' || outcome === 'partial') {
      assert.equal(health.status, outcome === 'partial' ? 'degraded' : 'healthy');
      assert.equal(health.lastSuccessAt, NOW);
      assert.equal(health.consecutiveFailures, 0);
      assert.equal(h.events.find(event => event[0] === 'enriched')[2].models.jp7203.changePct, 0);
      if (outcome === 'partial') assert.equal(h.events.find(event => event[0] === 'enriched')[2].models.jp9984, undefined);
    } else if (outcome !== 'abort') {
      assert.equal(health.status, 'cooldown');
      assert.equal(health.lastFailureAt, NOW);
      assert.equal(health.consecutiveFailures, 2, 'A real model request returning no valid change must fail business coverage');
      assert.equal(h.events.find(event => event[0] === 'enriched')[2].models.jp7203, undefined);
    } else {
      assert.equal(health.consecutiveFailures, 1, 'Cancellation releases the probe without counting an upstream outage');
      assert.equal(health.lastFailureAt, NOW - 10);
      assert.equal(h.writes.length, 0);
    }
  });
}

for (const leg of ['usINX', 'AU9999']) {
  test(`warm ${leg} seed consumes no market-model probe and does not change source-health history`, async () => {
    const at = NOW - 1000;
    const previous = cacheFixture(at);
    if (leg === 'usINX') {
      const quotes = indexQuotes(at).map(quote => quote.code === leg ? { ...quote, changePct: 0 } : quote);
      previous.refreshResources[INDEX_KEY] = makeRefreshResourceEntry(INDEX_KEY,
        { source: 'tencent-market-quote', codes: [...INDEX_CODES], quotes },
        { now: at, fetchedAt: at, sourceDate: '2026-09-30' });
      assert.ok(previous.refreshResources[INDEX_KEY]);
    }
    const h = harness({ previous, options: { force: false }, clients: {
      models: async () => [{ min_weight: 100, legs: [{ code: leg, weight: 100 }] }],
    } });
    h.failSource(MODEL_SOURCE);
    const healthBefore = h.health(MODEL_SOURCE);
    const result = await h.run('timer');
    assert.equal(result.status, 'completed');
    assert.equal(h.calls.indices, 0);
    assert.equal(h.calls.gold, 0);
    assert.equal(h.calls.bridge, 0);
    assert.equal(h.calls.eastmoney, 1, 'Only the independent domestic holding union is acquired');
    assert.equal(h.claims.filter(source => source === MODEL_SOURCE).length, 0);
    assert.deepEqual(h.health(MODEL_SOURCE), healthBefore, 'Cache reads cannot become failures or fabricate a new success timestamp');
    assert.equal(h.events.find(event => event[0] === 'enriched')[2].models[leg].changePct, 0);
    assert.equal(h.writes.length, 0);
  });
}

test('valid partial index response remains visible instead of being discarded with missing instruments', async () => {
  const provided = indexQuotes().slice(0, 2);
  const h = harness({ clients: { indices: async () => clone(provided) } });
  const result = await h.run();
  assert.equal(result.status, 'completed');
  const shown = h.events.find(event => event[0] === 'market' && event[1].components?.indices === true)[1].indices;
  assert.ok(shown, 'Valid requested index rows must survive partial provider coverage');
  assert.deepEqual(shown.payload.quotes, provided);
  assert.equal(shown.sourceDate, '2026-09-30');
  assert.equal(shown.payload.quotes[0].changePct, 0);
  assert.equal(shown.payload.quotes[1].changePct, null);
  assert.equal(shown.payload.quotes.some(quote => quote.code === 'usINX' || quote.code === 'usNDX'), false);
  assert.equal(result.result.diagnostics.providers['tencent-market-quote'], 1);
  assert.equal(h.writes.length, 1);
  // Either persist an explicitly validated partial envelope or omit the
  // complete-batch cache. Never invent the two missing rows as zero/current.
  const persisted = h.writes[0].value.refreshResources[INDEX_KEY];
  if (persisted) assert.deepEqual(persisted.payload.quotes, provided);
});

for (const consumer of ['indices', 'domestic-securities', 'non-gold-model']) {
  test(`${consumer} becomes visible before an unrelated slow gold request completes`, async () => {
    const entered = deferred();
    const pendingGold = deferred();
    const originalGold = goldQuote();
    const models = consumer === 'non-gold-model'
      ? [{ min_weight: 100, version: 'synthetic-domestic-v1', legs: [{ code: 'sh600001', weight: 100 }] }]
      : [];
    let h;
    h = harness({ clients: {
      models: async () => models,
      gold: async (_signal, dispatch) => dispatch(async () => {
        h.calls.gold++;
        entered.resolve();
        return pendingGold.promise;
      }),
    } });
    const task = h.run();
    await entered.promise;
    try {
      // All other synthetic operations are resolved promises. Yield complete
      // turns while deliberately keeping the one gold request unresolved.
      for (let turn = 0; turn < 3; turn++) await tick();
      assert.equal(h.writes.length, 0, 'Partial UI commits must not add intermediate aggregate Storage writes');
      if (consumer === 'indices') {
        const visible = h.events.filter(event => event[0] === 'market' && event[1].components?.indices === true);
        assert.equal(visible.length, 1, 'Completed indices must be independently committed while gold is pending');
        assert.deepEqual(visible[0][1].indices.payload.quotes, indexQuotes());
        assert.equal(visible[0][1].indices.sourceDate, '2026-09-30');
      } else {
        const enriched = h.events.filter(event => event[0] === 'enriched');
        assert.equal(enriched.length, 1, 'Security/model enrichment must not wait for an unrelated market component');
        assert.equal(h.calls.eastmoney, 1);
        assert.equal(enriched[0][2].estimate.items[0].change, 0);
        assert.equal(enriched[0][2].estimate.items[0].quoteTime, '2026-09-30 14:00:00');
        assert.equal(enriched[0][2].models.AU9999, undefined);
        if (consumer === 'non-gold-model') assert.deepEqual(enriched[0][2].models.sh600001, {
          price: 100, changePct: 0, sourceTime: '2026-09-30 14:00:00',
        });
      }
      assert.equal(h.calls.gold, 1);
    } finally {
      // Always drain the real executor, including intentional first-red runs.
      h.setNow(NOW + 30000);
      pendingGold.resolve(originalGold);
      await task;
    }
    const result = await task;
    assert.equal(result.status, 'completed');
    assert.equal(h.calls.gold, 1);
    assert.equal(h.calls.eastmoney, 1, 'Gold completion cannot repeat the earlier union acquisition');
    assert.equal(h.calls.indices, 1);
    assert.equal(h.writes.length, 1);
    assert.equal(result.result.diagnostics.cacheWrites, 1);
    assert.equal(result.result.diagnostics.providers['eastmoney-security-quote'], 2, 'One gold dispatch plus one mainland union dispatch');
    const goldVisible = h.events.filter(event => event[0] === 'market' && event[1].components?.gold === true);
    assert.equal(goldVisible.length, 1);
    assert.equal(goldVisible[0][1].gold.payload.observedAt, originalGold.observedAt);
    const persisted = h.writes[0].value.refreshResources;
    assert.equal(persisted['gold:AU9999'].payload.observedAt, originalGold.observedAt);
    assert.equal(persisted['gold:AU9999'].sourceDate, '2026-09-30');
    assert.equal(persisted['gold:AU9999'].fetchedAt, NOW + 30000);
    assert.deepEqual(persisted[INDEX_KEY].payload.quotes, indexQuotes());
  });
}

test('cancelled background branches are observed and cannot write or commit late UI', async () => {
  const entered = deferred();
  const lateMarket = deferred();
  const lateModels = deferred();
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const h = harness({ clients: {
      indices: async () => { entered.resolve(); return lateMarket.promise; },
      models: async () => lateModels.promise,
    } });
    const task = h.run();
    await entered.promise;
    h.coordinator.stop('synthetic stop');
    const committedBeforeLate = h.events.length;
    // Providers intentionally ignore signal to reproduce real late responses.
    lateMarket.resolve(indexQuotes());
    lateModels.reject(abortError());
    const result = await task;
    await tick();
    assert.ok(['aborted', 'superseded'].includes(result.status));
    assert.deepEqual(unhandled, []);
    assert.equal(h.events.length, committedBeforeLate);
    assert.equal(h.writes.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
