import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshDiagnosticsStore } from '../js/runtime/refresh-generation.js';
import { RefreshCoordinator } from '../js/runtime/refresh-runtime.js';

const KINDS = ['estimates', 'nav', 'holdings', 'meta', 'indices', 'gold', 'securities', 'model-quotes'];
const PROVIDERS = ['sinan-estimate-proxy', 'sinan-holdings-proxy', 'eastmoney-official-nav',
  'eastmoney-security-quote', 'tencent-market-quote', 'gold', 'model-config'];
const COUNTERS = ['generation', 'planned', 'staged', 'cacheHits', 'deduped', 'requests',
  'abortedRequests', 'failedRequests', 'cancelledResources', 'writeAttempts', 'cacheWrites'];
const RECORD_KEYS = ['generation', 'phase', 'status', 'observed', 'counters', 'plan', 'skipReasons'];
const state = (active, completed = null, failed = null, current = active) => ({
  active: active === null ? null : { generation: active }, currentGeneration: current,
  lastCompleted: completed === null ? null : { generation: completed },
  lastFailure: failed === null ? null : { generation: failed },
});
function report(generation, phase = 'started', status = 'running', requests = 0) {
  return { generation, phase, status,
    counters: { generation, planned: 8, staged: 0, cacheHits: 0, deduped: 0, requests,
      abortedRequests: 0, failedRequests: 0, cancelledResources: 0, writeAttempts: 0,
      cacheWrites: 0, providers: { gold: requests } },
    plan: KINDS.map(kind => ({ kind, cache: 0, fetch: 1, skip: 0 })),
    skipReasons: { market_ineligible: 0, no_active_holdings: 0 } };
}
function assertFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach(assertFrozen);
}
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

test('empty store has only three frozen slots and no fabricated observations', () => {
  const store = createRefreshDiagnosticsStore();
  assert.deepEqual(Object.keys(store), ['observeState', 'observe', 'snapshot']);
  assertFrozen(store);
  assert.deepEqual(store.snapshot(), { current: null, lastSettled: null, lastCancelled: null });
  assertFrozen(store.snapshot());
  store.observeState(state(1));
  assert.deepEqual(store.snapshot().current, { generation: 1, phase: null, status: 'running',
    observed: false, counters: null, plan: null, skipReasons: null });
});

test('new state cancels old running generation without zero-filling unobserved counters', () => {
  const store = createRefreshDiagnosticsStore();
  store.observeState(state(1));
  store.observeState(state(2));
  assert.equal(store.snapshot().current.generation, 2);
  assert.deepEqual(store.snapshot().lastCancelled, { generation: 1, phase: 'final',
    status: 'cancelled', observed: false, counters: null, plan: null, skipReasons: null });
  store.observeState(state(1));
  assert.equal(store.snapshot().current.generation, 2);
  assert.equal(store.snapshot().current.status, 'running');
});

test('old finishes cannot replace a newer start and cancellation history uses generation order', () => {
  const store = createRefreshDiagnosticsStore();
  store.observe(report(1));
  store.observe(report(2));
  store.observe(report(3));
  store.observe(report(1, 'final', 'completed', 99));
  store.observe(report(1, 'final', 'cancelled', 99));
  assert.equal(store.snapshot().current.generation, 3);
  assert.equal(store.snapshot().lastCancelled.generation, 2);
  assert.equal(store.snapshot().lastCancelled.counters, null);
  assert.equal(store.snapshot().lastSettled, null);
  store.observe(report(3, 'final', 'completed', 3));
  store.observe(report(2, 'resources_settled', 'cancelled', 2));
  assert.equal(store.snapshot().current.generation, 3);
  assert.equal(store.snapshot().current.status, 'completed');
  assert.equal(store.snapshot().lastSettled.generation, 3);
  assert.equal(store.snapshot().lastCancelled.generation, 2);
  assert.equal(store.snapshot().lastCancelled.counters.requests, 2);
});

test('terminal lifecycle records accept late scope counts without becoming running', () => {
  const store = createRefreshDiagnosticsStore();
  store.observeState(state(1));
  store.observeState(state(2));
  store.observe(report(1, 'resources_settled', 'running', 4));
  const cancelled = store.snapshot().lastCancelled;
  assert.equal(cancelled.phase, 'final');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.observed, true);
  assert.equal(cancelled.counters.requests, 4);
  store.observe(report(1, 'started', 'running', 1));
  assert.strictEqual(store.snapshot().lastCancelled, cancelled);
  store.observe(report(1, 'final', 'completed', 5));
  assert.equal(store.snapshot().lastCancelled.status, 'cancelled');
  assert.equal(store.snapshot().lastCancelled.counters.requests, 5);
  store.observe(report(1, 'resources_settled', 'cancelled', 8));
  assert.equal(store.snapshot().lastCancelled.counters.requests, 5);
});

test('observed started plans survive cancellation and late drain updates abort counters', () => {
  const store = createRefreshDiagnosticsStore();
  store.observe(report(1, 'started', 'running', 1));
  store.observeState(state(2));
  const late = report(1, 'resources_settled', 'cancelled', 2);
  late.counters.abortedRequests = 2;
  store.observe(late);
  assert.equal(store.snapshot().lastCancelled.counters.abortedRequests, 2);
  assert.equal(store.snapshot().lastCancelled.phase, 'final');
  store.observeState(state(null, 2, null, 2));
  assert.equal(store.snapshot().current.observed, false);
  assert.equal(store.snapshot().current.counters, null);
  assert.equal(store.snapshot().lastSettled.status, 'completed');
});

test('started-only zero counts are not exposed as terminal actual counts after failure or stop', () => {
  for (const status of ['failed', 'cancelled']) {
    const store = createRefreshDiagnosticsStore();
    store.observe(report(1));
    store.observeState(state(null, null, status === 'failed' ? 1 : null, null));
    const terminal = store.snapshot().current;
    assert.equal(terminal.status, status);
    assert.equal(terminal.observed, true);
    assert.equal(terminal.counters, null);
    assert.equal(terminal.plan.length, 8);
    store.observe(report(1, 'started', 'running', 0));
    assert.equal(store.snapshot().current.counters, null);
    store.observe(report(1, 'resources_settled', 'running', 3));
    assert.equal(store.snapshot().current.status, status);
    assert.equal(store.snapshot().current.counters.requests, 3);
  }
});

test('failed or completed lifecycle can be observed later but terminal status cannot change', () => {
  for (const status of ['failed', 'completed']) {
    const store = createRefreshDiagnosticsStore();
    store.observeState(state(7));
    store.observeState(state(null, status === 'completed' ? 7 : null, status === 'failed' ? 7 : null,
      status === 'failed' ? null : 7));
    assert.equal(store.snapshot().current.status, status);
    assert.equal(store.snapshot().current.observed, false);
    store.observe(report(7, 'resources_settled', 'running', 6));
    assert.equal(store.snapshot().current.status, status);
    assert.equal(store.snapshot().current.phase, 'final');
    assert.equal(store.snapshot().current.counters.requests, 6);
    assert.strictEqual(store.snapshot().current, store.snapshot().lastSettled);
  }
});

test('phase rollback cannot replace final metrics or undo a terminal observation', () => {
  const store = createRefreshDiagnosticsStore();
  store.observe(report(1, 'resources_settled', 'running', 3));
  const settled = store.snapshot().current;
  store.observe(report(1, 'started', 'running', 1));
  assert.strictEqual(store.snapshot().current, settled);
  store.observe(report(1, 'final', 'completed', 4));
  const final = store.snapshot().current;
  store.observe(report(1, 'resources_settled', 'failed', 99));
  store.observeState(state(1));
  assert.strictEqual(store.snapshot().current, final);
  assert.equal(final.counters.requests, 4);
});

test('same-generation health/coalesce states do not reset observed plans or metrics', () => {
  const store = createRefreshDiagnosticsStore();
  store.observeState(state(4));
  store.observe(report(4, 'resources_settled', 'running', 8));
  const before = store.snapshot().current;
  for (let i = 0; i < 10; i++) store.observeState({ ...state(4), sourceRegistry: { token: 'PRIVATE' } });
  assert.strictEqual(store.snapshot().current, before);
  store.observeState(state(null, 4, null, 4));
  assert.equal(store.snapshot().current.counters.requests, 8);
  assert.equal(store.snapshot().current.status, 'completed');
});

test('inactive old generation snapshot does not cancel a newer current generation', () => {
  const store = createRefreshDiagnosticsStore();
  store.observeState(state(11));
  store.observeState(state(null, 10, null, 10));
  assert.equal(store.snapshot().current.generation, 11);
  assert.equal(store.snapshot().current.status, 'running');
  assert.equal(store.snapshot().lastSettled.generation, 10);
});

test('store retains at most three generation records, not an expanding history', () => {
  const store = createRefreshDiagnosticsStore();
  for (let generation = 1; generation <= 120; generation++) {
    store.observeState(state(generation));
    if (generation % 3 === 0) store.observe(report(generation, 'final', 'completed', generation));
    const snapshot = store.snapshot();
    assert.deepEqual(Object.keys(snapshot), ['current', 'lastSettled', 'lastCancelled']);
    assert.ok(new Set(Object.values(snapshot).filter(Boolean)).size <= 3);
    Object.values(snapshot).filter(Boolean).forEach(record => assert.deepEqual(Object.keys(record), RECORD_KEYS));
  }
  assert.equal(store.snapshot().current.generation, 120);
  assert.equal(store.snapshot().lastSettled.generation, 120);
  assert.equal(store.snapshot().lastCancelled.generation, 119);
  store.observe(report(1, 'final', 'cancelled', 999));
  assert.equal(store.snapshot().lastCancelled.generation, 119);
});

test('sanitizes fixed counter/provider/plan/skip fields and deep copies and freezes payload', () => {
  const store = createRefreshDiagnosticsStore();
  const input = report(3, 'resources_settled', 'running', 2);
  Object.assign(input, { code: '005844', name: 'PRIVATE', amount: 12345, token: 'PRIVATE', url: 'https://PRIVATE' });
  input.counters.name = 'PRIVATE';
  input.counters.providers.secret = 'PRIVATE';
  input.plan[0].code = 'PRIVATE';
  input.skipReasons.url = 'PRIVATE';
  store.observe(input);
  const snapshot = store.snapshot();
  const current = snapshot.current;
  assert.deepEqual(Object.keys(current), RECORD_KEYS);
  assert.deepEqual(Object.keys(current.counters), [...COUNTERS, 'providers']);
  assert.deepEqual(Object.keys(current.counters.providers), PROVIDERS);
  assert.equal(current.counters.providers.gold, 2);
  assert.equal(current.counters.providers['sinan-estimate-proxy'], null);
  assert.deepEqual(Object.keys(current.plan[0]), ['kind', 'cache', 'fetch', 'skip']);
  assert.deepEqual(Object.keys(current.skipReasons), ['market_ineligible', 'no_active_holdings']);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false);
  assertFrozen(snapshot);
  input.counters.requests = 999;
  input.plan[0].fetch = 999;
  input.skipReasons.market_ineligible = 999;
  assert.equal(current.counters.requests, 2);
  assert.equal(current.plan[0].fetch, 1);
  assert.equal(current.skipReasons.market_ineligible, 0);
  assert.throws(() => { current.counters.requests = 20; }, TypeError);
});

test('invalid/missing measurements remain null, while real zero is preserved', () => {
  const store = createRefreshDiagnosticsStore();
  const input = report(2);
  input.counters = { generation: 2, planned: 0, staged: -1, cacheHits: '0', deduped: 1.5,
    requests: Infinity, abortedRequests: NaN, failedRequests: Number.MAX_SAFE_INTEGER + 1,
    providers: { gold: 0, 'model-config': '3', 'sinan-estimate-proxy': -1 } };
  input.plan = [{ kind: 'nav', cache: 0, fetch: '1', skip: -1 }];
  input.skipReasons = { market_ineligible: 0, no_active_holdings: '0' };
  store.observe(input);
  const { counters, plan, skipReasons } = store.snapshot().current;
  assert.equal(counters.planned, 0);
  for (const key of COUNTERS.filter(key => !['generation', 'planned'].includes(key))) assert.equal(counters[key], null);
  assert.equal(counters.providers.gold, 0);
  assert.equal(counters.providers['model-config'], null);
  assert.deepEqual(plan, [{ kind: 'nav', cache: 0, fetch: null, skip: null }]);
  assert.deepEqual(skipReasons, { market_ineligible: 0, no_active_holdings: null });
  assert.equal(store.snapshot().current.observed, true);
  assert.equal(store.snapshot().current.status, 'running');
});

test('rejects mismatched counter generation and never coerces inputs', () => {
  const store = createRefreshDiagnosticsStore();
  let coercions = 0;
  const malicious = { valueOf() { coercions++; throw new Error('PRIVATE'); }, toString() { coercions++; return 'PRIVATE'; } };
  const input = report(2);
  input.counters.generation = 1;
  input.skipReasons.market_ineligible = malicious;
  store.observe(input);
  assert.equal(store.snapshot().current.counters, null);
  assert.equal(store.snapshot().current.skipReasons.market_ineligible, null);
  for (const generation of [0, -1, '2', null, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, malicious]) {
    store.observe({ ...report(9), generation });
    assert.equal(store.snapshot().current.generation, 2);
  }
  assert.equal(coercions, 0);
});

test('invalid or absent final counters do not promote an earlier started zero sample', () => {
  for (const counters of [null, undefined, { generation: 99, requests: 0 }]) {
    const store = createRefreshDiagnosticsStore();
    store.observe(report(1));
    store.observe({ ...report(1, 'final', 'completed'), counters });
    assert.equal(store.snapshot().current.status, 'completed');
    assert.equal(store.snapshot().current.observed, true);
    assert.equal(store.snapshot().current.counters, null);
  }
});

test('only bounded allowlisted kinds are kept, without duplicate or fabricated rows', () => {
  const store = createRefreshDiagnosticsStore();
  const input = report(1);
  input.plan = [
    { kind: 'gold', cache: 0, fetch: 2, skip: 0 },
    { kind: 'PRIVATE', cache: 999, fetch: 999, skip: 999 },
    { kind: 'nav', cache: 1, fetch: 0, skip: 0 },
    { kind: 'gold', cache: 999, fetch: 999, skip: 999 },
  ];
  store.observe(input);
  assert.deepEqual(store.snapshot().current.plan, [
    { kind: 'nav', cache: 1, fetch: 0, skip: 0 }, { kind: 'gold', cache: 0, fetch: 2, skip: 0 },
  ]);
  store.observe({ ...report(2), plan: Array(10000).fill({ kind: 'gold', fetch: 999 }) });
  assert.equal(store.snapshot().current.plan, null);
});

test('getters are not run and inherited properties or hostile proxies cannot leak payload', () => {
  const store = createRefreshDiagnosticsStore();
  let getterCalls = 0;
  const secretGetter = () => { getterCalls++; throw new Error('PRIVATE'); };
  const input = report(2);
  Object.defineProperty(input, 'url', { get: secretGetter });
  Object.defineProperty(input.counters, 'requests', { get: secretGetter });
  Object.defineProperty(input.counters.providers, 'gold', { get: secretGetter });
  Object.defineProperty(input.plan[0], 'fetch', { get: secretGetter });
  Object.defineProperty(input.skipReasons, 'market_ineligible', { get: secretGetter });
  store.observe(input);
  assert.equal(getterCalls, 0);
  assert.equal(store.snapshot().current.counters.requests, null);
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('PRIVATE'); },
    ownKeys() { throw new Error('PRIVATE'); }, get() { throw new Error('PRIVATE'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [proxy, revoked.proxy, null, undefined, [], 'PRIVATE']) {
    assert.doesNotThrow(() => store.observe(value));
    assert.doesNotThrow(() => store.observeState(value));
  }
  store.observe(Object.create(report(100)));
  assert.equal(store.snapshot().current.generation, 2);
  assert.equal(JSON.stringify(store.snapshot()).includes('PRIVATE'), false);
});

test('invalid headers and malformed lifecycle events cannot settle or replace records', () => {
  const store = createRefreshDiagnosticsStore();
  store.observe(report(2));
  const before = store.snapshot().current;
  for (const value of [
    { ...report(3), phase: 'PRIVATE' }, { ...report(3), status: 'PRIVATE' },
    { ...report(3), phase: 'final', status: 'running' },
    {}, { active: {} }, { active: null, currentGeneration: '2' },
  ]) {
    store.observe(value); store.observeState(value);
  }
  assert.strictEqual(store.snapshot().current, before);
});

test('production synchronous onStateChange preserves coalesced promise identity and final counts', async () => {
  const store = createRefreshDiagnosticsStore();
  const wait = deferred();
  const coordinator = new RefreshCoordinator({
    execute: async context => {
      store.observe(report(context.generation, 'started', 'running', 0));
      await wait.promise;
      store.observe(report(context.generation, 'final', 'completed', 2));
    },
    onStateChange: snapshot => store.observeState(snapshot),
  });
  const first = coordinator.request({ trigger: 'tick', coalesce: true });
  const coalesced = coordinator.request({ trigger: 'tick', coalesce: true });
  assert.strictEqual(first, coalesced);
  await Promise.resolve();
  assert.equal(store.snapshot().current.observed, true);
  wait.resolve();
  assert.equal((await first).status, 'completed');
  assert.equal(store.snapshot().current.counters.requests, 2);
  assert.equal(store.snapshot().current.status, 'completed');
  assert.strictEqual(store.snapshot().lastSettled, store.snapshot().current);
});

test('production superseded-before-execute and stop remain unobserved, not PASS with zero counts', async () => {
  const store = createRefreshDiagnosticsStore();
  let calls = 0;
  const coordinator = new RefreshCoordinator({ execute: () => { calls++; },
    onStateChange: snapshot => store.observeState(snapshot) });
  const first = coordinator.request();
  const second = coordinator.request();
  coordinator.stop();
  await Promise.all([first, second]);
  assert.equal(calls, 0);
  assert.equal(store.snapshot().current.generation, 2);
  assert.equal(store.snapshot().current.status, 'cancelled');
  assert.equal(store.snapshot().lastCancelled.generation, 2);
  assert.equal(store.snapshot().current.observed, false);
  assert.equal(store.snapshot().current.counters, null);
  // active:null/currentGeneration:null has no stop sequence. This API consumes
  // the coordinator's synchronous callbacks, not an asynchronously replayed bus.
});

test('production failure before scope start and stop-after-start have different observation evidence', async () => {
  const store = createRefreshDiagnosticsStore();
  const failing = new RefreshCoordinator({ execute: () => { throw new Error('PRIVATE'); },
    onStateChange: snapshot => store.observeState(snapshot) });
  await failing.request();
  assert.equal(store.snapshot().current.status, 'failed');
  assert.equal(store.snapshot().current.observed, false);
  assert.equal(store.snapshot().current.counters, null);
  const secondStore = createRefreshDiagnosticsStore();
  const wait = deferred();
  const stopped = new RefreshCoordinator({ execute: async context => {
    secondStore.observe(report(context.generation));
    await wait.promise;
    secondStore.observe(report(context.generation, 'resources_settled', 'cancelled', 1));
  }, onStateChange: snapshot => secondStore.observeState(snapshot) });
  const task = stopped.request();
  await Promise.resolve();
  stopped.stop();
  wait.resolve();
  await task;
  assert.equal(secondStore.snapshot().current.status, 'cancelled');
  assert.equal(secondStore.snapshot().current.observed, true);
  assert.equal(secondStore.snapshot().current.counters.requests, 1);
  assert.equal(JSON.stringify(store.snapshot()).includes('PRIVATE'), false);
});

test('synchronous onError retry records the explicitly failed prior generation, not a provisional cancellation', async () => {
  const store = createRefreshDiagnosticsStore();
  let coordinator, retry, atRetry;
  coordinator = new RefreshCoordinator({
    execute(context) { if (context.generation === 1) throw new Error('PRIVATE'); return null; },
    onStateChange(snapshot) {
      store.observeState(snapshot);
      if (snapshot.active?.generation === 2) atRetry = store.snapshot();
    },
    onError() { retry = coordinator.request({ trigger: 'synthetic retry' }); },
  });
  assert.equal((await coordinator.request()).status, 'failed');
  assert.equal((await retry).status, 'completed');
  assert.equal(atRetry.current.generation, 2);
  assert.equal(atRetry.current.status, 'running');
  assert.equal(atRetry.lastSettled?.generation, 1);
  assert.equal(atRetry.lastSettled?.status, 'failed');
  assert.equal(atRetry.lastCancelled, null);
  assert.equal(store.snapshot().lastCancelled, null);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE/);
});

const REASONS = ['fresh_cache', 'cache_miss', 'cache_metadata_invalid', 'cache_quality_unusable',
  'cache_expired', 'force_live', 'force_stable', 'market_ineligible', 'phase_pending', 'no_active_holdings'];

test('plan reason counts are an additive fixed DTO, copied and frozen without retaining unknown fields', () => {
  const store = createRefreshDiagnosticsStore();
  const input = report(1);
  input.planReasons = Object.fromEntries(REASONS.map((key, index) => [key, index]));
  input.planReasons.code = 'PRIVATE'; input.planReasons.payload = { token: 'PRIVATE' };
  store.observe(input);
  const result = store.snapshot().current;
  assert.deepEqual(Object.keys(result), [...RECORD_KEYS, 'planReasons']);
  assert.deepEqual(Object.keys(result.planReasons), REASONS);
  assert.deepEqual(result.planReasons, Object.fromEntries(REASONS.map((key, index) => [key, index])));
  assert.notStrictEqual(result.planReasons, input.planReasons);
  assertFrozen(store.snapshot());
  input.planReasons.fresh_cache = 999;
  assert.equal(result.planReasons.fresh_cache, 0);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE|payload|token/);
});

test('plan reasons preserve zero and null without coercion, getters, inherited values or unsafe identities', () => {
  const store = createRefreshDiagnosticsStore();
  let accesses = 0;
  const input = report(1);
  input.planReasons = Object.assign(Object.create({ force_stable: 4 }), {
    fresh_cache: 0, cache_miss: '0', cache_metadata_invalid: -1, cache_quality_unusable: 0.5,
    cache_expired: Infinity, force_live: Number.MAX_SAFE_INTEGER + 1,
    phase_pending: { valueOf() { accesses++; return 2; } }, no_active_holdings: 2,
  });
  Object.defineProperty(input.planReasons, 'market_ineligible', { get() { accesses++; throw Error('PRIVATE'); } });
  store.observe(input);
  assert.equal(accesses, 0);
  assert.deepEqual(store.snapshot().current.planReasons, { fresh_cache: 0, cache_miss: null,
    cache_metadata_invalid: null, cache_quality_unusable: null, cache_expired: null, force_live: null,
    force_stable: null, market_ineligible: null, phase_pending: null, no_active_holdings: 2 });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('PRIVATE'); },
    get() { accesses++; throw Error('PRIVATE'); }, ownKeys() { accesses++; throw Error('PRIVATE'); } });
  store.observe({ ...report(2), planReasons: proxy });
  assert.deepEqual(Object.values(store.snapshot().current.planReasons), REASONS.map(() => null));
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.doesNotThrow(() => store.observe({ ...report(3), planReasons: revoked.proxy }));
  assert.equal(Object.hasOwn(store.snapshot().current, 'planReasons'), false);
  assert.equal(accesses, 0);
});

test('plan reasons stay generation-local through provisional cancellation, late drain and phase rollback', () => {
  const store = createRefreshDiagnosticsStore();
  const reasons = Object.fromEntries(REASONS.map(key => [key, 0])); reasons.cache_miss = 2;
  store.observe({ ...report(1), planReasons: reasons });
  store.observeState(state(2));
  assert.deepEqual(store.snapshot().lastCancelled.planReasons, reasons);
  store.observe({ ...report(1, 'resources_settled', 'cancelled', 2) });
  assert.deepEqual(store.snapshot().lastCancelled.planReasons, reasons);
  const before = store.snapshot().lastCancelled;
  let calls = 0;
  const earlier = report(1);
  Object.defineProperty(earlier, 'planReasons', { get() { calls++; return reasons; } });
  store.observe(earlier);
  assert.strictEqual(store.snapshot().lastCancelled, before);
  assert.equal(calls, 0);
  assert.equal(Object.hasOwn(store.snapshot().current, 'planReasons'), false);
  assert.equal(new Set(Object.values(store.snapshot()).filter(Boolean)).size, 2);
});

const EXECUTION_SKIPS = ['estimate_claim_denied', 'holdings_claim_denied', 'holdings_probe_used',
  'model_claim_denied', 'model_probe_used'];
const executionCounts = (value = 0) => Object.fromEntries(EXECUTION_SKIPS.map(key => [key, value]));

test('execution skips are an optional fixed copied and frozen DTO without widening old record shapes', () => {
  const store = createRefreshDiagnosticsStore();
  store.observeState(state(1));
  assert.deepEqual(Object.keys(store.snapshot().current), RECORD_KEYS);
  store.observe(report(1));
  store.observeState(state(null, 1, null, 1));
  assert.deepEqual(Object.keys(store.snapshot().current), RECORD_KEYS);
  const input = { ...report(2), executionSkips: executionCounts() };
  input.executionSkips.code = 'PRIVATE'; input.executionSkips.payload = { token: 'PRIVATE' };
  Object.defineProperty(input.executionSkips, 'url', { get() { assert.fail('unknown fields must not be read'); } });
  store.observe(input);
  const record = store.snapshot().current;
  assert.deepEqual(Object.keys(record), [...RECORD_KEYS, 'executionSkips']);
  assert.deepEqual(Object.keys(record.executionSkips), EXECUTION_SKIPS);
  assert.deepEqual(record.executionSkips, executionCounts());
  assert.notStrictEqual(record.executionSkips, input.executionSkips);
  assertFrozen(store.snapshot());
  input.executionSkips.estimate_claim_denied = 999;
  assert.equal(record.executionSkips.estimate_claim_denied, 0);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE|payload|token|url/);
  store.observe({ ...report(3), executionSkips: {} });
  assert.deepEqual(store.snapshot().current.executionSkips, executionCounts(null));
});

test('execution skips preserve zero and reject non-safe measurements without coercing their values', () => {
  const store = createRefreshDiagnosticsStore();
  let coercions = 0, generation = 0;
  const hostile = { valueOf() { coercions++; return 0; }, toString() { coercions++; return '0'; } };
  for (const value of [null, undefined, '0', -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, hostile]) {
    for (const key of EXECUTION_SKIPS) {
      const values = executionCounts(); values[key] = value;
      store.observe({ ...report(++generation), executionSkips: values });
      assert.deepEqual(store.snapshot().current.executionSkips, { ...executionCounts(), [key]: null });
    }
  }
  assert.equal(coercions, 0);
});

test('execution skips ignore inherited and accessor values and contain hostile or revoked proxies', () => {
  const store = createRefreshDiagnosticsStore();
  let accesses = 0;
  const values = Object.assign(Object.create({ holdings_claim_denied: 7 }), executionCounts());
  delete values.holdings_claim_denied;
  Object.defineProperty(values, 'model_probe_used', { get() { accesses++; throw Error('PRIVATE'); } });
  store.observe({ ...report(1), executionSkips: values });
  assert.deepEqual(store.snapshot().current.executionSkips,
    { ...executionCounts(), holdings_claim_denied: null, model_probe_used: null });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('PRIVATE'); },
    get() { accesses++; throw Error('PRIVATE'); }, ownKeys() { accesses++; throw Error('PRIVATE'); } });
  store.observe({ ...report(2), executionSkips: proxy });
  assert.deepEqual(store.snapshot().current.executionSkips, executionCounts(null));
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const [index, value] of [revoked.proxy, null, undefined, [], 'PRIVATE'].entries()) {
    assert.doesNotThrow(() => store.observe({ ...report(index + 3), executionSkips: value }));
    assert.equal(Object.hasOwn(store.snapshot().current, 'executionSkips'), true);
    assert.equal(store.snapshot().current.executionSkips, null);
  }
  const accessor = report(8);
  Object.defineProperty(accessor, 'executionSkips', { get() { accesses++; return executionCounts(); } });
  store.observe(accessor);
  assert.equal(Object.hasOwn(store.snapshot().current, 'executionSkips'), false);
  const inherited = Object.assign(Object.create({ executionSkips: executionCounts() }), report(9));
  store.observe(inherited);
  assert.equal(Object.hasOwn(store.snapshot().current, 'executionSkips'), false);
  assert.equal(accesses, 0);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /PRIVATE/);
});

test('first own execution field opts in even if invalid and later missing samples remain null', () => {
  for (const value of [null, undefined, [], 'PRIVATE', 0]) {
    const store = createRefreshDiagnosticsStore();
    store.observe({ ...report(1), executionSkips: value });
    assert.deepEqual(Object.keys(store.snapshot().current), [...RECORD_KEYS, 'executionSkips']);
    assert.equal(store.snapshot().current.executionSkips, null);
    store.observe(report(1, 'resources_settled'));
    assert.equal(Object.hasOwn(store.snapshot().current, 'executionSkips'), true);
    assert.equal(store.snapshot().current.executionSkips, null);
  }
  const store = createRefreshDiagnosticsStore();
  store.observe({ ...report(1, 'resources_settled'), executionSkips: executionCounts(Number.MAX_SAFE_INTEGER) });
  assert.deepEqual(store.snapshot().current.executionSkips, executionCounts(Number.MAX_SAFE_INTEGER));
  store.observe({ ...report(1, 'final', 'completed'), executionSkips: executionCounts() });
  assert.deepEqual(store.snapshot().current.executionSkips, executionCounts());
  store.observe(report(1, 'final', 'completed'));
  assert.equal(store.snapshot().current.executionSkips, null);
});

test('started-only execution skips become unobserved at every lifecycle ending and late drain can qualify counts', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const store = createRefreshDiagnosticsStore();
    store.observe({ ...report(1), executionSkips: executionCounts() });
    store.observeState(state(null, status === 'completed' ? 1 : null, status === 'failed' ? 1 : null,
      status === 'completed' ? 1 : null));
    assert.equal(store.snapshot().current.status, status);
    assert.equal(store.snapshot().current.executionSkips, null);
    assert.equal(store.snapshot().current.counters, null);
    store.observe({ ...report(1, 'started', 'running'), executionSkips: executionCounts(99) });
    assert.equal(store.snapshot().current.executionSkips, null);
    store.observe({ ...report(1, 'resources_settled', 'running'), executionSkips: executionCounts(2) });
    const record = store.snapshot().current;
    assert.equal(record.status, status);
    assert.equal(record.phase, 'final');
    assert.deepEqual(record.executionSkips, executionCounts(2));
    assertFrozen(store.snapshot());
  }
});

test('terminal started reports cannot qualify execution zeros and accepted missing samples never inherit earlier counts', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const store = createRefreshDiagnosticsStore();
    store.observe({ ...report(1, 'started', status), executionSkips: executionCounts() });
    assert.equal(store.snapshot().current.executionSkips, null);
  }
  for (const value of [null, undefined, [], 'PRIVATE']) {
    const store = createRefreshDiagnosticsStore();
    store.observe({ ...report(1, 'resources_settled'), executionSkips: executionCounts(3) });
    const next = report(1, 'final', 'completed');
    if (value !== undefined) next.executionSkips = value;
    store.observe(next);
    assert.equal(Object.hasOwn(store.snapshot().current, 'executionSkips'), true);
    assert.equal(store.snapshot().current.executionSkips, null);
  }
  const store = createRefreshDiagnosticsStore();
  store.observe({ ...report(1), executionSkips: executionCounts() });
  store.observe(report(1, 'resources_settled'));
  assert.equal(store.snapshot().current.executionSkips, null);
});

test('execution skip history stays bounded and generation-local without reading phase rollback payloads', () => {
  const store = createRefreshDiagnosticsStore();
  store.observe({ ...report(1, 'resources_settled'), executionSkips: executionCounts(2) });
  store.observeState(state(2));
  assert.deepEqual(store.snapshot().lastCancelled.executionSkips, executionCounts(2));
  assert.equal(Object.hasOwn(store.snapshot().current, 'executionSkips'), false);
  store.observe({ ...report(1, 'final', 'cancelled'), executionSkips: executionCounts(4) });
  const before = store.snapshot().lastCancelled;
  const earlier = report(1, 'resources_settled', 'cancelled');
  Object.defineProperty(earlier, 'executionSkips', { get() { assert.fail('rollback payload must not be read'); } });
  store.observe(earlier);
  assert.strictEqual(store.snapshot().lastCancelled, before);
  for (let generation = 3; generation <= 80; generation++) {
    store.observe({ ...report(generation, 'final', generation % 2 ? 'completed' : 'cancelled'), executionSkips: executionCounts(generation) });
    assert.deepEqual(Object.keys(store.snapshot()), ['current', 'lastSettled', 'lastCancelled']);
    assert.ok(new Set(Object.values(store.snapshot()).filter(Boolean)).size <= 3);
  }
  const latest = store.snapshot().lastCancelled;
  store.observe({ ...report(1, 'final', 'cancelled'), executionSkips: executionCounts(999) });
  assert.strictEqual(store.snapshot().lastCancelled, latest);
});

test('real synchronous stop marks execution zeros unobserved until the executor drain report arrives', async () => {
  const store = createRefreshDiagnosticsStore();
  const pending = deferred();
  const coordinator = new RefreshCoordinator({
    onStateChange: snapshot => store.observeState(snapshot),
    execute: async context => {
      store.observe({ ...report(context.generation), executionSkips: executionCounts() });
      await pending.promise;
      store.observe({ ...report(context.generation, 'resources_settled', 'cancelled'), executionSkips: executionCounts(1) });
    },
  });
  const task = coordinator.request();
  await Promise.resolve();
  coordinator.stop();
  assert.equal(store.snapshot().current.executionSkips, null);
  pending.resolve();
  await task;
  assert.equal(store.snapshot().current.status, 'cancelled');
  assert.deepEqual(store.snapshot().current.executionSkips, executionCounts(1));
  assert.strictEqual(store.snapshot().current, store.snapshot().lastCancelled);
});
