import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationResourceScope } from '../js/runtime/generation-resource-scope.js';
import { RefreshCoordinator } from '../js/runtime/refresh-coordinator.js';
import { createRefreshPlan } from '../js/runtime/refresh-plan.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const resource = (key, extra = {}) => Object.freeze({ key, action: 'fetch', cacheExpiresAt: null, ...extra });
const plan = (...resources) => Object.freeze({ generation: 1, resources: Object.freeze(resources) });
function harness(resources, initialNow = 1000) {
  let current = true, now = initialNow;
  const controller = new AbortController();
  const context = { generation: 1, signal: controller.signal, isCurrent: () => current,
    commit: operation => current && !controller.signal.aborted ? { committed: true, value: operation() } : { committed: false } };
  return { scope: createGenerationResourceScope({ context, plan: plan(...resources), now: () => now }),
    advance: time => { now = time; }, stop: () => { current = false; controller.abort(); } };
}

test('M3 resource consumers share one acquisition including a failed result', async () => {
  const { scope } = harness([resource('nav:005844')]);
  let calls = 0;
  const pending = deferred();
  const load = () => scope.dispatch('eastmoney-official-nav', () => { calls++; return pending.promise; });
  const first = scope.acquire('nav:005844', load), second = scope.acquire('nav:005844', load);
  assert.equal(first, second);
  await Promise.resolve();
  pending.reject(new Error('synthetic outage'));
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'rejected');
  await assert.rejects(scope.acquire('nav:005844', load));
  assert.equal(calls, 1);
  assert.equal(scope.snapshot().deduped, 2);
  assert.equal(scope.snapshot().requests, 1);
});

test('M3 a cache hit preserves acquisition metadata and rechecks expiry at consumption', async () => {
  const h = harness([resource('nav:005844', { action: 'cache', cacheExpiresAt: 1001 })]);
  const cached = { value: 1, fetchedAt: 900, expiresAt: 1001 };
  let loads = 0;
  assert.deepEqual(await h.scope.acquire('nav:005844', () => { loads++; }, { cachedValue: cached, validateCache: value => value.value === 1 }), cached);
  assert.equal(loads, 0);
  assert.equal(h.scope.snapshot().cacheHits, 1);
  assert.deepEqual(cached, { value: 1, fetchedAt: 900, expiresAt: 1001 });
  const expired = harness([resource('nav:005844', { action: 'cache', cacheExpiresAt: 1001 })]);
  expired.advance(1001);
  assert.equal(await expired.scope.acquire('nav:005844', () => 2, { cachedValue: cached, validateCache: () => true }), 2);
  assert.equal(expired.scope.snapshot().cacheHits, 0);
});

test('M3 invalid cached payload cannot prevent the scheduled acquisition', async () => {
  const { scope } = harness([resource('nav:005844', { action: 'cache', cacheExpiresAt: 2000 })]);
  assert.equal(await scope.acquire('nav:005844', () => 3, { cachedValue: { value: null }, validateCache: () => false }), 3);
  assert.equal(scope.snapshot().cacheHits, 0);
  const other = harness([resource('nav:005844', { action: 'cache', cacheExpiresAt: 2000 })]);
  assert.equal(await other.scope.acquire('nav:005844', () => 4, { cachedValue: {}, validateCache: () => { throw new Error('invalid'); } }), 4);
});

test('M3 the scope snapshots planned policies without freezing or trusting mutable caller objects', async () => {
  const item = { key: 'nav:005844', action: 'skip', cacheExpiresAt: null };
  const { scope } = harness([item]);
  item.action = 'fetch';
  let calls = 0;
  assert.equal(await scope.acquire('nav:005844', () => { calls++; }), null);
  assert.equal(calls, 0);
  assert.equal(Object.isFrozen(item), false);
  assert.throws(() => harness([{ key: 'nav:005844', action: 'invented' }]), TypeError);
});

test('M3 staging is private and final aggregate persistence attempts exactly once', async () => {
  const { scope } = harness([resource('nav:005844'), resource('holdings:005844')]);
  const source = { nav: 2, dates: ['2026-09-29', '2026-09-30'] };
  await scope.acquire('nav:005844', () => source);
  assert.equal(scope.stageCache('nav:005844', source, value => value.nav > 0), true);
  source.nav = 999;
  const disclosure = { items: [{ code: '688361' }] };
  await scope.acquire('holdings:005844', () => disclosure);
  scope.stageCache('holdings:005844', disclosure, () => true);
  let writes = 0;
  const options = { storage: { setItem(key, value) { writes++; assert.equal(key, 'fuyu_funds_cache_v1'); assert.equal(JSON.parse(value)['nav:005844'].nav, 2); } },
    serialize: entries => { assert.ok(Object.isFrozen(entries['nav:005844'].dates)); return JSON.stringify(entries); } };
  assert.equal(scope.flushCache(options), true);
  assert.equal(scope.flushCache(options), false);
  assert.equal(writes, 1);
  assert.equal(scope.snapshot().cacheWrites, 1);
  assert.equal(scope.stageCache('nav:005844', { nav: 3 }, () => true), false);
});

test('M3 failed persistence, invalid staging and empty generations cannot renew cache', async () => {
  const { scope } = harness([resource('nav:005844')]);
  await scope.acquire('nav:005844', () => ({ nav: 2 }));
  assert.equal(scope.stageCache('nav:005844', { nav: 2 }, () => false), false);
  assert.equal(scope.stageCache('nav:005844', { nav: 2 }), false);
  let writes = 0;
  const options = { storage: { setItem() { writes++; return false; } }, serialize: JSON.stringify };
  assert.equal(scope.flushCache(options), false);
  assert.equal(writes, 0);
  assert.equal(scope.stageCache('nav:005844', { nav: 2 }, () => true), true);
  assert.equal(scope.flushCache(options), false);
  assert.equal(scope.flushCache(options), false);
  assert.equal(writes, 1);
  assert.equal(scope.snapshot().writeAttempts, 1);
  assert.equal(scope.snapshot().cacheWrites, 0);
});

test('M3 aborted queued resources never dispatch or persist', async () => {
  const h = harness([resource('nav:005844')]);
  let loads = 0, writes = 0;
  const task = h.scope.acquire('nav:005844', () => { loads++; return 2; });
  h.stop();
  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(h.scope.stageCache('nav:005844', { nav: 2 }, () => true), false);
  assert.equal(h.scope.flushCache({ storage: { setItem() { writes++; } }, serialize: JSON.stringify }), false);
  assert.equal(loads, 0);
  assert.equal(writes, 0);
});

test('M3 only fixed providers and planned keys enter diagnostics or execution', async () => {
  const { scope } = harness([resource('nav:005844')]);
  await assert.rejects(scope.dispatch('https://invalid/?token=secret', () => 1), TypeError);
  assert.throws(() => scope.acquire('url:secret', () => 1), TypeError);
  assert.equal(scope.stageCache('url:secret', {}, () => true), false);
  assert.doesNotMatch(JSON.stringify(scope.snapshot()), /token|secret|http/);
});

test('M3 every primary/stable planner provider is accepted by the actual scope transport boundary', async () => {
  const actualPlan = createRefreshPlan({ generation: 1, now: 1000, forceLive: true,
    activeHoldings: [{ code: '005844', name: '测试混合基金' }] });
  const controller = new AbortController();
  const scope = createGenerationResourceScope({ context: { generation: 1, signal: controller.signal,
    isCurrent: () => true, commit: operation => ({ committed: true, value: operation() }) }, plan: actualPlan });
  for (const item of actualPlan.resources) {
    assert.equal(await scope.dispatch(item.provider, () => 1), 1);
  }
  assert.equal(scope.snapshot().requests, actualPlan.resources.length);
});

test('M3 cancellation after fulfillment never returns an old deduplicated value', async () => {
  const h = harness([resource('nav:005844')]);
  assert.equal(await h.scope.acquire('nav:005844', () => 1), 1);
  h.stop();
  await assert.rejects(h.scope.acquire('nav:005844', () => 2), { name: 'AbortError' });
});

test('M3 skip, cache hit and never-acquired resources cannot stage or renew persistence', async () => {
  for (const action of ['skip', 'cache', 'fetch']) {
    const { scope } = harness([resource('nav:005844', { action, cacheExpiresAt: 2000 })]);
    if (action !== 'fetch') await scope.acquire('nav:005844', () => ({ nav: 2 }), { cachedValue: { nav: 2 }, validateCache: () => true });
    assert.equal(scope.stageCache('nav:005844', { nav: 2 }, () => true), false);
    let writes = 0;
    assert.equal(scope.flushCache({ storage: { setItem() { writes++; } }, serialize: JSON.stringify }), false);
    assert.equal(writes, 0);
  }
});

test('M3 validators are synchronous and rejected thenables cannot become unhandled rejections', async () => {
  const { scope } = harness([resource('nav:005844', { action: 'cache', cacheExpiresAt: 2000 })]);
  let asyncCalls = 0;
  const asynchronous = async () => { asyncCalls++; throw new Error('must not invoke'); };
  assert.deepEqual(await scope.acquire('nav:005844', () => ({ nav: 2 }), { cachedValue: {}, validateCache: asynchronous }), { nav: 2 });
  assert.equal(scope.stageCache('nav:005844', { nav: 2 }, asynchronous), false);
  assert.equal(scope.stageCache('nav:005844', { nav: 2 }, () => Promise.reject(new Error('synthetic validator rejection'))), false);
  const other = harness([resource('nav:005844', { action: 'cache', cacheExpiresAt: 2000 })]);
  assert.equal(await other.scope.acquire('nav:005844', () => 3, { cachedValue: {}, validateCache: () => Promise.reject(new Error('synthetic cache rejection')) }), 3);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(asyncCalls, 0);
});

test('M3 persistence owns Storage.setItem; async serializers cannot schedule a late cache write', async () => {
  for (const serialize of [async () => { throw new Error('must not invoke'); },
    () => Promise.reject(new Error('synthetic serializer failure'))]) {
    const h = harness([resource('nav:005844')]);
    await h.scope.acquire('nav:005844', () => ({ nav: 2 }));
    h.scope.stageCache('nav:005844', { nav: 2 }, () => true);
    let writes = 0;
    assert.equal(h.scope.flushCache({ storage: { setItem() { writes++; } }, serialize }), false);
    h.stop();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(writes, 0);
    assert.equal(h.scope.snapshot().writeAttempts, 0);
  }
});

test('M3 real coordinator replacement isolates resources and blocks late UI/cache writes', async () => {
  const old = deferred(), scopes = [], events = [];
  const coordinator = new RefreshCoordinator({ execute: async context => {
    const scope = createGenerationResourceScope({ context, plan: { generation: context.generation, resources: [resource('nav:005844')] }, now: () => 1000 });
    scopes.push(scope);
    const value = await scope.acquire('nav:005844', () => scope.dispatch('eastmoney-official-nav', () => context.generation === 1 ? old.promise : 2));
    scope.stageCache('nav:005844', { nav: value }, () => true);
    scope.commitUi(() => events.push(`ui:${value}`));
    scope.flushCache({ storage: { setItem() { events.push(`cache:${value}`); } }, serialize: JSON.stringify });
  } });
  const first = coordinator.request({ trigger: 'startup' });
  await new Promise(resolve => setTimeout(resolve, 0));
  const second = coordinator.request({ trigger: 'manual' });
  assert.equal((await second).status, 'completed');
  old.resolve(1);
  assert.equal((await first).status, 'aborted');
  assert.deepEqual(events, ['ui:2', 'cache:2']);
  assert.equal(scopes[0].snapshot().requests, 1);
  assert.equal(scopes[1].snapshot().requests, 1);
  assert.equal(scopes[0].snapshot().cacheWrites, 0);
});
