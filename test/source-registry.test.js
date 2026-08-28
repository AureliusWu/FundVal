import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_SOURCE_REGISTRY,
  SOURCE_HEALTH,
  canAttemptSource,
  claimSourceAttempt,
  createSourceRegistry,
  getSourceDescriptor,
  getSourceHealth,
  recordSourceFailure,
  recordSourceSuccess,
  releaseSourceAttempt,
  registerSource,
  selectAvailableSources,
} from '../js/runtime/source-registry.js';

function descriptor(id, overrides = {}) {
  return {
    id,
    markets: ['cn'],
    capabilities: ['estimate'],
    priority: 10,
    timeoutMs: 4_000,
    freshnessPolicy: 'intraday',
    requiresProxy: false,
    ...overrides,
  };
}

test('registers controlled immutable source descriptors without changing caller input', () => {
  const input = descriptor('primary', { markets: ['cn', 'cn'], capabilities: ['estimate', 'estimate'] });
  const registry = createSourceRegistry([input], { failureThreshold: 2, cooldownMs: 100 });
  input.markets.push('hk');
  input.capabilities.push('holdings');

  const registered = getSourceDescriptor(registry, 'primary');
  assert.deepEqual(registered.markets, ['cn']);
  assert.deepEqual(registered.capabilities, ['estimate']);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registered), true);
  assert.throws(() => registerSource(registry, descriptor('primary')), /already registered/);
  assert.throws(() => createSourceRegistry([descriptor('bad', { markets: [] })]), /markets must not be empty/);
  assert.throws(() => createSourceRegistry([descriptor('bad', { requiresProxy: 'yes' })]), /requiresProxy must be boolean/);
});

test('accepts the declared production registry including its zero-timeout cache source', () => {
  const registry = createSourceRegistry(DATA_SOURCE_REGISTRY);
  assert.equal(getSourceDescriptor(registry, 'local-cache').timeoutMs, 0);
  assert.equal(getSourceDescriptor(registry, 'local-cache').sourceTier, 'cache');
});

test('selects only matching currently-attemptable descriptors in priority order', () => {
  const registry = createSourceRegistry([
    descriptor('slow-primary', { priority: 20, requiresProxy: true }),
    descriptor('fast-secondary', { priority: 5, capabilities: ['estimate', 'nav'] }),
    descriptor('hk-only', { priority: 1, markets: ['hk'] }),
  ]);

  assert.deepEqual(
    selectAvailableSources(registry, { market: 'cn', capability: 'estimate', proxyAvailable: false }, 10).map(item => item.id),
    ['fast-secondary']
  );
  assert.deepEqual(
    selectAvailableSources(registry, { market: 'cn', capability: 'estimate', proxyAvailable: true }, 10).map(item => item.id),
    ['slow-primary', 'fast-secondary']
  );
  assert.deepEqual(
    selectAvailableSources(registry, { market: 'cn', capabilities: ['estimate', 'nav'], proxyAvailable: true }, 10).map(item => item.id),
    ['fast-secondary']
  );
  assert.deepEqual(
    selectAvailableSources(registry, { market: 'hk' }, 10).map(item => item.id),
    ['hk-only']
  );
});

test('enters cooldown after repeated failure and permits exactly one claimed half-open probe', () => {
  const original = createSourceRegistry([descriptor('primary')], { failureThreshold: 2, cooldownMs: 100 });
  const degraded = recordSourceFailure(original, 'primary', { reason: 'timeout', responseMs: 4_000 }, 10);
  const cooldown = recordSourceFailure(degraded, 'primary', { reason: 'http_503' }, 20);

  assert.equal(getSourceHealth(original, 'primary').status, SOURCE_HEALTH.HEALTHY);
  assert.equal(getSourceHealth(degraded, 'primary').status, SOURCE_HEALTH.DEGRADED);
  assert.equal(getSourceHealth(cooldown, 'primary').status, SOURCE_HEALTH.COOLDOWN);
  assert.equal(getSourceHealth(cooldown, 'primary').cooldownUntil, 120);
  assert.equal(canAttemptSource(cooldown, 'primary', 119), false);
  assert.equal(canAttemptSource(cooldown, 'primary', 120), true);

  const probe = claimSourceAttempt(cooldown, 'primary', 120);
  assert.equal(probe.allowed, true);
  assert.equal(probe.halfOpen, true);
  assert.equal(canAttemptSource(probe.registry, 'primary', 120), false);
  assert.equal(claimSourceAttempt(probe.registry, 'primary', 120).allowed, false);

  const recovered = recordSourceSuccess(probe.registry, 'primary', {
    responseMs: 35,
    availableAt: '2026-08-25T09:30:00+08:00',
  }, 121);
  assert.deepEqual(getSourceHealth(recovered, 'primary'), {
    status: SOURCE_HEALTH.HEALTHY,
    consecutiveFailures: 0,
    lastSuccessAt: 121,
    lastFailureAt: 20,
    lastResponseMs: 35,
    lastAvailableAt: '2026-08-25T09:30:00+08:00',
    degradationReason: null,
    cooldownUntil: null,
    halfOpenProbeActive: false,
    halfOpenProbeAt: null,
  });
});

test('failed half-open probe restarts cooldown and aborted work leaves health untouched', () => {
  let registry = createSourceRegistry([descriptor('primary')], { failureThreshold: 1, cooldownMs: 50 });
  registry = recordSourceFailure(registry, 'primary', { reason: 'timeout' }, 0);
  registry = claimSourceAttempt(registry, 'primary', 50).registry;
  const retripped = recordSourceFailure(registry, 'primary', { reason: 'timeout' }, 55);
  assert.equal(getSourceHealth(retripped, 'primary').status, SOURCE_HEALTH.COOLDOWN);
  assert.equal(getSourceHealth(retripped, 'primary').cooldownUntil, 105);
  assert.equal(getSourceHealth(retripped, 'primary').consecutiveFailures, 2);

  assert.strictEqual(recordSourceFailure(retripped, 'primary', { name: 'AbortError' }, 60), retripped);
  assert.strictEqual(recordSourceFailure(retripped, 'primary', { aborted: true }, 60), retripped);
  assert.strictEqual(recordSourceFailure(retripped, 'primary', { reason: 'aborted' }, 60), retripped);
});

test('explicitly unavailable sources are excluded until a success restores them', () => {
  const initial = createSourceRegistry([descriptor('primary')]);
  const unavailable = recordSourceFailure(initial, 'primary', {
    unavailable: true,
    code: 'SOURCE_UNAVAILABLE',
    responseMs: 12,
  }, 20);
  assert.equal(getSourceHealth(unavailable, 'primary').status, SOURCE_HEALTH.UNAVAILABLE);
  assert.equal(canAttemptSource(unavailable, 'primary', 10_000), false);
  assert.deepEqual(selectAvailableSources(unavailable, { market: 'cn' }, 10_000), []);

  const recovered = recordSourceSuccess(unavailable, 'primary', {}, 10_001);
  assert.equal(getSourceHealth(recovered, 'primary').status, SOURCE_HEALTH.HEALTHY);
  assert.equal(canAttemptSource(recovered, 'primary', 10_001), true);
});

test('a cancelled half-open probe is released without counting a failure', () => {
  let registry = createSourceRegistry([descriptor('primary')], { failureThreshold: 1, cooldownMs: 50 });
  registry = recordSourceFailure(registry, 'primary', { reason: 'timeout' }, 0);
  registry = claimSourceAttempt(registry, 'primary', 50).registry;
  assert.equal(canAttemptSource(registry, 'primary', 50), false);

  const released = releaseSourceAttempt(registry, 'primary');
  assert.equal(getSourceHealth(released, 'primary').consecutiveFailures, 1);
  assert.equal(getSourceHealth(released, 'primary').halfOpenProbeActive, false);
  assert.equal(canAttemptSource(released, 'primary', 50), true);
});

test('older availability timestamps never move source health backwards', () => {
  let registry = createSourceRegistry([descriptor('primary')]);
  registry = recordSourceSuccess(registry, 'primary', { availableAt: '2026-08-25T10:00:00+08:00' }, 10);
  registry = recordSourceSuccess(registry, 'primary', { availableAt: '2026-08-25T09:00:00+08:00' }, 20);
  assert.equal(getSourceHealth(registry, 'primary').lastAvailableAt, '2026-08-25T10:00:00+08:00');
});
