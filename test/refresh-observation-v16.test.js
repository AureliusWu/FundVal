import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRefreshPlan } from '../js/runtime/refresh-execution.js';
import { RefreshCoordinator } from '../js/runtime/refresh-runtime.js';

const NOW = Date.parse('2026-09-30T06:00:00Z');
const tick = () => new Promise(resolve => setImmediate(resolve));
const abort = () => Object.assign(new Error('synthetic stop'), { name: 'AbortError' });

function harness({ previous, observer, observe = true, blocked = false, storageResult = true, failedFunds = false } = {}) {
  const reports = [], writes = [], entered = [];
  const network = signal => {
    entered.push(signal);
    if (!blocked) return Promise.resolve();
    return new Promise((_, reject) => {
      if (signal.aborted) reject(abort());
      else signal.addEventListener('abort', () => reject(abort()), { once: true });
    });
  };
  const coordinator = new RefreshCoordinator({ now: () => NOW,
    execute: context => executeRefreshPlan({ context, previous, options: { force: false }, now: () => NOW,
      snapshot: failedFunds ? [{ code: '005844', name: 'Synthetic QDII', shares: 0, cost: null }] : [],
      onDiagnostics: observe ? observer || (report => reports.push(report)) : undefined,
      clients: {
        estimates: async (_holdings, _options, _context, dispatch) => dispatch(async () => new Map()),
        nav: async () => null,
        indices: async (codes, signal) => { await network(signal); return codes.map(code => ({ code, price: 100,
          changePct: 0, observedAt: new Date(NOW - 1000).toISOString(), status: 'current' })); },
        gold: async (signal, dispatch) => dispatch(async () => { await network(signal); return {
          price: 100, changePct: 0, observedAt: new Date(NOW - 1000).toISOString(), status: 'current', cached: false }; }),
        models: async () => [],
      },
      ui: { market() {}, cacheData: () => [], holdingsHash: () => 'synthetic', complete() {}, primary: () => null, failure() {} },
      storage: { setItem(key, bytes) { writes.push({ key, value: JSON.parse(bytes) }); return storageResult; } },
    }) });
  return { coordinator, reports, writes, entered, run: () => coordinator.request({ trigger: 'manual' }) };
}

test('observer receives actual started, drained and final counter snapshots without portfolio payloads', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.status, 'completed');
  assert.deepEqual(h.reports.map(row => row.phase), ['started', 'resources_settled', 'final']);
  const first = h.reports[0], final = h.reports.at(-1);
  assert.equal(first.counters.requests, 0);
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.counters, result.result.diagnostics);
  assert.equal(final.counters.requests, 2);
  assert.equal(final.counters.cacheWrites, 1);
  assert.equal(h.reports[1].counters.cacheWrites, 0);
  assert.deepEqual(final.plan, [
    { kind: 'indices', cache: 0, fetch: 1, skip: 0 }, { kind: 'gold', cache: 0, fetch: 1, skip: 0 },
    { kind: 'securities', cache: 0, fetch: 0, skip: 1 }, { kind: 'model-quotes', cache: 0, fetch: 0, skip: 1 },
  ]);
  assert.deepEqual(final.skipReasons, { market_ineligible: 0, no_active_holdings: 2 });
  assert.ok(Object.isFrozen(final) && Object.isFrozen(final.plan) && final.plan.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(h.reports), /source_quote|holdingsHash|payload|AU9999|sh000001|005844/);
});

test('warm diagnostic counters are observed hits, not requests or renewed source times', async () => {
  const cold = harness(); await cold.run();
  const previous = cold.writes[0].value, before = structuredClone(previous);
  const warm = harness({ previous });
  const result = await warm.run();
  assert.equal(result.status, 'completed');
  assert.equal(warm.reports.at(-1)?.counters.cacheHits, 2);
  assert.equal(warm.reports.at(-1)?.counters.requests, 0);
  assert.equal(warm.entered.length, 0);
  assert.deepEqual(previous, before);
});

test('executor relays the original fixed plan reasons in all phases without counting them as actual dispatches', async () => {
  const cold = harness(); await cold.run();
  const expectedCold = { fresh_cache: 0, cache_miss: 2, cache_metadata_invalid: 0, cache_quality_unusable: 0,
    cache_expired: 0, force_live: 0, force_stable: 0, market_ineligible: 0, phase_pending: 0, no_active_holdings: 2 };
  for (const row of cold.reports) {
    assert.deepEqual(row.planReasons, expectedCold);
    assert.ok(Object.isFrozen(row.planReasons));
    assert.strictEqual(row.planReasons, cold.reports[0].planReasons);
    assert.equal(Object.values(row.planReasons).reduce((sum, value) => sum + value, 0), row.counters.planned);
  }
  const previous = cold.writes[0].value, bytes = JSON.stringify(previous);
  const warm = harness({ previous }); await warm.run();
  for (const row of warm.reports) assert.deepEqual(row.planReasons, { ...expectedCold, fresh_cache: 2, cache_miss: 0 });
  assert.equal(warm.reports.at(-1).counters.requests, 0);
  assert.equal(warm.reports.at(-1).counters.cacheHits, 2);
  assert.equal(JSON.stringify(previous), bytes);
  assert.equal(warm.entered.length, 0);
  assert.doesNotMatch(JSON.stringify(warm.reports), /source_cooldown|payload|sourceDate|fetchedAt|AU9999|sh000001/);
});

test('enabling observation leaves provider calls, finance results and serialized cache bytes identical', async () => {
  const observed = harness(), silent = harness({ observe: false });
  const [a, b] = await Promise.all([observed.run(), silent.run()]);
  assert.deepEqual(a, b);
  assert.equal(silent.reports.length, 0);
  assert.equal(observed.entered.length, silent.entered.length);
  assert.equal(JSON.stringify(observed.writes), JSON.stringify(silent.writes));
  const previous = observed.writes[0].value, originalBytes = JSON.stringify(previous);
  const warmObserved = harness({ previous }), warmSilent = harness({ previous, observe: false });
  assert.deepEqual(await warmObserved.run(), await warmSilent.run());
  assert.equal(warmObserved.entered.length, 0);
  assert.equal(warmSilent.entered.length, 0);
  assert.equal(JSON.stringify(warmObserved.writes), JSON.stringify(warmSilent.writes));
  assert.equal(JSON.stringify(previous), originalBytes);
});

test('cancelled executor reports drained dispatch aborts without appending completed coordinator diagnostics', async () => {
  const h = harness({ blocked: true });
  const task = h.run();
  for (let attempt = 0; h.entered.length < 2 && attempt < 20; attempt++) await tick();
  assert.equal(h.entered.length, 2);
  h.coordinator.stop('synthetic observation stop');
  const diagnosticCount = h.coordinator.snapshot().diagnosticCount;
  const result = await task;
  assert.ok(['aborted', 'superseded'].includes(result.status));
  const final = h.reports.at(-1);
  assert.equal(final?.status, 'cancelled');
  assert.equal(final?.counters.abortedRequests, 2);
  assert.ok(final.counters.cancelledResources >= 2, 'This is a rejection/call count, not unique resource identities');
  assert.equal(final.counters.cacheWrites, 0);
  assert.equal(h.coordinator.snapshot().diagnosticCount, diagnosticCount);
  assert.equal(h.writes.length, 0);
});

test('all-fund failure and refused cache write remain separate observed terminal outcomes', async () => {
  const failed = harness({ failedFunds: true });
  assert.equal((await failed.run()).status, 'failed');
  assert.equal(failed.reports.at(-1)?.status, 'failed');
  assert.equal(failed.reports.at(-1)?.counters.cacheWrites, 0);
  assert.equal(failed.writes.length, 0);
  const refused = harness({ storageResult: false });
  assert.equal((await refused.run()).status, 'completed');
  assert.equal(refused.reports.at(-1)?.counters.writeAttempts, 1);
  assert.equal(refused.reports.at(-1)?.counters.cacheWrites, 0);
});

for (const kind of ['throw', 'rejected_promise', 'throwing_then_getter']) {
  test(`observer ${kind} cannot fail a refresh or create an unhandled rejection`, async () => {
    const unhandled = [], listener = error => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
      const h = harness({ observer() {
        if (kind === 'throw') throw new Error('synthetic observer');
        if (kind === 'rejected_promise') return Promise.reject(new Error('synthetic observer'));
        return Object.defineProperty({}, 'then', { get() { throw new Error('synthetic observer'); } });
      } });
      assert.equal((await h.run()).status, 'completed');
      await tick(); await tick();
      assert.equal(h.writes.length, 1);
      assert.deepEqual(unhandled, []);
    } finally { process.off('unhandledRejection', listener); }
  });
}
