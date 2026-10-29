import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshPlan, createRuntimeRefreshPlan } from '../js/runtime/refresh-plan.js';
import { TTL } from '../js/config.js';
import { createGenerationResourceScope } from '../js/runtime/generation-resource-scope.js';
import { RefreshCoordinator } from '../js/runtime/refresh-coordinator.js';
import { claimSourceAttempt, getSourceHealth, listDataSources, recordSourceFailure } from '../js/runtime/source-registry.js';

const NOW = Date.parse('2026-09-30T06:00:00Z');
const HOLDING = { code: '005844', name: 'Synthetic 混合基金', shares: 0, cost: null };
const REASONS = ['fresh_cache', 'cache_miss', 'cache_metadata_invalid', 'cache_quality_unusable',
  'cache_expired', 'force_live', 'force_stable', 'market_ineligible', 'phase_pending', 'no_active_holdings'];
const zeros = () => Object.fromEntries(REASONS.map(reason => [reason, 0]));
const fresh = () => ({ validated: true, fetchedAt: NOW - 100, cachedAt: NOW - 50,
  expiresAt: NOW + 1000, sourceTier: 'cache', status: 'current', cacheState: 'fresh' });
const input = extras => ({ generation: 1, now: NOW, activeHoldings: [HOLDING], forceLive: false, ...extras });
const tick = () => new Promise(resolve => setImmediate(resolve));

function observe(options) {
  const reports = [];
  const plan = createRuntimeRefreshPlan(options, reasons => { reports.push(reasons); });
  assert.equal(reports.length, 1, 'One successful planning pass emits one aggregate, not per-resource events.');
  const reasons = reports[0];
  assert.deepEqual(Object.keys(reasons), REASONS);
  assert.equal(Object.isFrozen(reasons), true);
  assert.equal(Object.values(reasons).reduce((sum, count) => sum + count, 0), plan.resources.length);
  return { plan, reasons };
}

test('private optional observer reports all fixed cache reasons from the original precedence and canonical TTL', () => {
  const cases = [
    [undefined, 'cache_miss'],
    [{}, 'cache_metadata_invalid'],
    [{ ...fresh(), validated: false }, 'cache_metadata_invalid'],
    [{ ...fresh(), cachedAt: NOW + 1 }, 'cache_metadata_invalid'],
    [{ ...fresh(), status: 'stale' }, 'cache_quality_unusable'],
    [{ ...fresh(), sourceTier: 'unknown' }, 'cache_quality_unusable'],
    [{ ...fresh(), cacheState: 'stale', expiresAt: NOW }, 'cache_quality_unusable'],
    [{ ...fresh(), expiresAt: NOW }, 'cache_expired'],
    [{ ...fresh(), fetchedAt: NOW - TTL.OFFICIAL_NAV, cachedAt: NOW - TTL.OFFICIAL_NAV,
      expiresAt: NOW + TTL.FUND_META }, 'cache_expired'],
    [fresh(), 'fresh_cache'],
  ];
  for (const [meta, reason] of cases) {
    const cacheIndex = meta === undefined ? {} : { [`nav:${HOLDING.code}`]: meta };
    const { plan, reasons } = observe(input({ cacheIndex }));
    const expected = { ...zeros(), cache_miss: 5, phase_pending: 2 };
    expected[reason]++;
    assert.deepEqual(reasons, expected, reason);
    assert.deepEqual(plan, createRuntimeRefreshPlan(input({ cacheIndex })));
  }
  const inherited = Object.create({ [`nav:${HOLDING.code}`]: fresh() });
  assert.equal(observe(input({ cacheIndex: inherited })).reasons.cache_miss, 6);
});

test('force, market skip and phase placeholders remain plan decisions rather than claimed network outcomes', () => {
  assert.deepEqual(observe(input()).reasons, { ...zeros(), cache_miss: 6, phase_pending: 2 });
  assert.deepEqual(observe(input({ forceLive: true })).reasons,
    { ...zeros(), cache_miss: 3, force_live: 3, phase_pending: 2 });
  assert.deepEqual(observe(input({ trigger: 'diagnostic', forceLive: true, forceStable: [`nav:${HOLDING.code}`] })).reasons,
    { ...zeros(), cache_miss: 2, force_live: 3, force_stable: 1, phase_pending: 2 });
  assert.deepEqual(observe(input({ trigger: 'manual', forceStable: [`nav:${HOLDING.code}`] })).reasons,
    { ...zeros(), cache_miss: 6, phase_pending: 2 });
  assert.deepEqual(observe(input({ activeHoldings: [{ ...HOLDING, name: 'Synthetic QDII' }],
    trigger: 'diagnostic', forceStable: [`holdings:${HOLDING.code}`] })).reasons,
    { ...zeros(), cache_miss: 5, market_ineligible: 1, phase_pending: 2 });
  for (const activeHoldings of [[], [{ ...HOLDING, deleted: true }], [{ ...HOLDING, deletedAt: NOW }]]) {
    assert.deepEqual(observe(input({ activeHoldings })).reasons,
      { ...zeros(), cache_miss: 2, no_active_holdings: 2 });
  }
  const many = Array.from({ length: 51 }, (_, index) => ({ ...HOLDING, code: String(index + 1).padStart(6, '0') }));
  assert.deepEqual(observe(input({ activeHoldings: many })).reasons,
    { ...zeros(), cache_miss: 157, phase_pending: 2 });
});

test('aggregate matches independent public reasons without changing either plan presentation or leaking identities', () => {
  const options = input({ cacheIndex: { [`nav:${HOLDING.code}`]: fresh() }, trigger: 'diagnostic',
    forceStable: [`meta:${HOLDING.code}`], forceLive: true });
  const { plan, reasons } = observe(options);
  const expected = zeros();
  for (const resource of createRefreshPlan(options).resources) expected[resource.reason]++;
  assert.deepEqual(reasons, expected);
  assert.deepEqual(Object.keys(plan), ['generation', 'activeCodes', 'resources']);
  assert.deepEqual(plan, createRuntimeRefreshPlan(options));
  for (const resource of plan.resources) assert.equal(Object.hasOwn(resource, 'reason'), false);
  assert.doesNotMatch(JSON.stringify(reasons), /005844|Synthetic|shares|cost|payload|source_quote|AU9999/);
  assert.throws(() => { reasons.cache_miss = 999; }, TypeError);
  let publicCalls = 0;
  createRefreshPlan(options, () => { publicCalls++; });
  assert.equal(publicCalls, 0, 'The public factory contract does not gain an observation callback.');
});

test('optional observation preserves first-argument and changing cache getter traces and sentinel identity', () => {
  const sentinel = Object.freeze({ synthetic: 'input sentinel' });
  const values = { validated: [true], fetchedAt: [NOW - 100, NOW - 90],
    cachedAt: [NOW - 50, NOW - 40, NOW - 30, NOW - 20, NOW - 10],
    expiresAt: [NOW + 1000, NOW + 900, NOW + 800, NOW + 700],
    sourceTier: ['cache'], status: ['current'], cacheState: ['fresh'] };
  function traced(trace, fail) {
    const reads = {}, meta = {};
    for (const [key, list] of Object.entries(values)) Object.defineProperty(meta, key, { enumerable: true, get() {
      const number = reads[key] = (reads[key] || 0) + 1;
      const event = `cache.${key}:${number}`;
      trace.push(event);
      if (event === fail) throw sentinel;
      return list[Math.min(number - 1, list.length - 1)];
    } });
    const supplied = { generation: 1, trigger: 'manual', now: NOW, activeHoldings: [HOLDING],
      cacheIndex: { [`nav:${HOLDING.code}`]: meta }, forceLive: true, forceStable: [] };
    const result = {};
    for (const [key, value] of Object.entries(supplied)) Object.defineProperty(result, key, { enumerable: true, get() {
      const event = `input.${key}`;
      trace.push(event);
      if (event === fail) throw sentinel;
      return value;
    } });
    return result;
  }
  const plainTrace = [], observedTrace = [];
  const plain = createRuntimeRefreshPlan(traced(plainTrace));
  const observed = observe(traced(observedTrace));
  assert.deepEqual(observed.plan, plain);
  assert.deepEqual(observedTrace, plainTrace);
  assert.deepEqual(plainTrace.slice(0, 7), ['input.generation', 'input.trigger', 'input.now', 'input.activeHoldings',
    'input.cacheIndex', 'input.forceLive', 'input.forceStable']);
  assert.equal(plain.resources.find(row => row.kind === 'nav').cacheExpiresAt, NOW + 700);
  for (const event of plainTrace) {
    const a = [], b = [];
    let calls = 0;
    assert.throws(() => createRuntimeRefreshPlan(traced(a, event)), error => error === sentinel);
    assert.throws(() => createRuntimeRefreshPlan(traced(b, event), () => { calls++; }), error => error === sentinel);
    assert.deepEqual(a, b);
    assert.equal(calls, 0, 'A failed input read cannot emit a partially completed aggregate.');
  }
});

test('observer does not introduce wall-clock calls, cache rereads, or force/skip cache inspection', () => {
  const oldNow = Date.now;
  Date.now = () => { throw new Error('forbidden wall clock'); };
  try {
    const traces = [];
    const options = input({ activeHoldings: [{ ...HOLDING, name: 'Synthetic QDII' }], forceLive: true,
      cacheIndex: new Proxy({}, { getOwnPropertyDescriptor(_target, key) { traces.push(key); return undefined; } }) });
    const observed = observe(options);
    assert.deepEqual(traces, [`nav:${HOLDING.code}`, `meta:${HOLDING.code}`]);
    assert.deepEqual(observed.reasons, { ...zeros(), cache_miss: 2, force_live: 3,
      market_ineligible: 1, phase_pending: 2 });
  } finally { Date.now = oldNow; }
});

test('nonfunction observer is ignored without widening the default private return', () => {
  const expected = createRuntimeRefreshPlan(input());
  for (const observer of [undefined, null, 0, 'PRIVATE', {}]) {
    assert.deepEqual(createRuntimeRefreshPlan(input(), observer), expected);
  }
});

test('real scope rechecks expiry at consumption without rewriting the earlier fresh-cache planning reason', async () => {
  let clock = NOW, cacheChecks = 0, providerCalls = 0;
  const cachedValue = { synthetic: 'old cache' };
  const coordinator = new RefreshCoordinator({ now: () => clock,
    async execute(context) {
      const { plan, reasons } = observe(input({ generation: context.generation,
        cacheIndex: { [`nav:${HOLDING.code}`]: fresh() } }));
      const before = JSON.stringify(reasons);
      const scope = createGenerationResourceScope({ context, plan, now: () => clock });
      clock = NOW + 1000;
      const value = await scope.acquire(`nav:${HOLDING.code}`,
        () => scope.dispatch('eastmoney-official-nav', async () => { providerCalls++; return { synthetic: 'new acquisition' }; }),
        { cachedValue, validateCache() { cacheChecks++; return true; } });
      assert.equal(JSON.stringify(reasons), before);
      return { value, reasons, counters: scope.snapshot() };
    },
  });
  const outcome = await coordinator.request({ trigger: 'manual' });
  assert.equal(outcome.status, 'completed');
  const { value, reasons, counters } = outcome.result;
  assert.deepEqual(value, { synthetic: 'new acquisition' });
  assert.deepEqual(reasons, { ...zeros(), fresh_cache: 1, cache_miss: 5, phase_pending: 2 });
  assert.equal(cacheChecks, 0, 'Expired cache must not enter the cache payload validator.');
  assert.equal(providerCalls, 1);
  assert.equal(counters.cacheHits, 0);
  assert.equal(counters.requests, 1);
  assert.equal(counters.providers['eastmoney-official-nav'], 1);
  assert.deepEqual(cachedValue, { synthetic: 'old cache' });
});

test('real source claims can deny cooldown, unavailable or occupied half-open work without fabricating plan reasons', async () => {
  const source = 'quarterly-holdings-model';
  for (const mode of ['cooldown', 'unavailable', 'half_open_occupied']) {
    let clock = NOW, gate = null, providerCalls = 0;
    const coordinator = new RefreshCoordinator({ now: () => clock, sources: listDataSources(),
      sourceHealthPolicy: { failureThreshold: 1, cooldownMs: 10 },
      async execute(context) {
        const { plan, reasons } = observe(input({ generation: context.generation, now: clock }));
        const before = JSON.stringify(reasons);
        const scope = createGenerationResourceScope({ context, plan, now: () => clock });
        const value = await scope.acquire(`holdings:${HOLDING.code}`, async () => {
          gate = context.claimSourceAttempt(source);
          if (!gate.allowed) return null;
          return scope.dispatch('sinan-holdings-proxy', async () => { providerCalls++; return { synthetic: 'unreachable' }; });
        });
        assert.equal(JSON.stringify(reasons), before);
        return { value, reasons, counters: scope.snapshot() };
      },
    });
    coordinator.registry = recordSourceFailure(coordinator.registry, source,
      { reason: 'synthetic gate fixture', unavailable: mode === 'unavailable' }, NOW - 1);
    if (mode === 'half_open_occupied') {
      clock = NOW + 9;
      const probe = claimSourceAttempt(coordinator.registry, source, clock);
      assert.equal(probe.allowed, true);
      assert.equal(probe.halfOpen, true);
      coordinator.registry = probe.registry;
    }
    const health = getSourceHealth(coordinator.registry, source);
    assert.equal(health.status, mode === 'unavailable' ? 'unavailable' : 'cooldown');
    assert.equal(health.halfOpenProbeActive, mode === 'half_open_occupied');
    const outcome = await coordinator.request({ trigger: 'manual' });
    assert.equal(outcome.status, 'completed');
    assert.equal(gate.allowed, false);
    assert.equal(outcome.result.value, null);
    assert.equal(outcome.result.counters.requests, 0);
    assert.equal(providerCalls, 0);
    assert.deepEqual(outcome.result.reasons, { ...zeros(), cache_miss: 6, phase_pending: 2 });
    assert.equal(Object.hasOwn(outcome.result.reasons, 'source_cooldown'), false);
    assert.deepEqual(getSourceHealth(coordinator.registry, source), health, 'Denied work is not a new source failure.');
  }
});

for (const kind of ['throw', 'rejected_promise', 'throwing_then_getter']) {
  test(`plan observer ${kind} cannot fail planning or create an unhandled rejection`, async () => {
    const unhandled = [], listener = error => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
      let calls = 0;
      const expected = createRuntimeRefreshPlan(input());
      const actual = createRuntimeRefreshPlan(input(), reasons => {
        calls++;
        assert.equal(Object.isFrozen(reasons), true);
        if (kind === 'throw') throw new Error('synthetic observer');
        if (kind === 'rejected_promise') return Promise.reject(new Error('synthetic observer'));
        return Object.defineProperty({}, 'then', { get() { throw new Error('synthetic observer'); } });
      });
      assert.equal(calls, 1);
      assert.deepEqual(actual, expected);
      await tick(); await tick();
      assert.deepEqual(unhandled, []);
    } finally { process.off('unhandledRejection', listener); }
  });
}
