import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_HEALTH,
  canAttemptSource,
  claimSourceAttempt,
  createSourceRegistry,
  getSourceDescriptor,
  getSourceHealth,
  isAbortedSourceFailure,
  recordSourceFailure,
  recordSourcePartial,
  recordSourceSuccess,
  registerSource,
  releaseSourceAttempt,
  selectAvailableSources,
} from '../js/runtime/source-registry.js';

// Characterization of the pre-optimization public contract, not a new policy.
const SOURCE = 'synthetic-primary';
const AVAILABLE = '2026-09-29T10:00:00+08:00';
const AVAILABLE_MS = Date.parse(AVAILABLE);
const INITIAL = Object.freeze({
  status: SOURCE_HEALTH.HEALTHY,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastResponseMs: null,
  lastAvailableAt: null,
  degradationReason: null,
  cooldownUntil: null,
  halfOpenProbeActive: false,
  halfOpenProbeAt: null,
});

function descriptor(id = SOURCE, overrides = {}) {
  return {
    id, markets: ['cn'], capabilities: ['estimate', 'nav'], priority: 20,
    timeoutMs: 1000, freshnessPolicy: 'source-observed-time', requiresProxy: false,
    ...overrides,
  };
}

function registry(policy = { failureThreshold: 2, cooldownMs: 100 }) {
  return createSourceRegistry([descriptor()], policy);
}

function health(value) {
  return getSourceHealth(value, SOURCE);
}

function assertHealth(value, expected) {
  assert.deepEqual(health(value), { ...INITIAL, ...expected });
}

function states() {
  const initial = registry();
  const healthy = recordSourceSuccess(initial, SOURCE, { availableAt: AVAILABLE, responseMs: 40 }, 10);
  const degraded = recordSourceFailure(healthy, SOURCE, { reason: 'first' }, 20);
  const cooldown = recordSourceFailure(degraded, SOURCE, { reason: 'second' }, 30);
  const probe = claimSourceAttempt(cooldown, SOURCE, 130).registry;
  const unavailable = recordSourceFailure(healthy, SOURCE, { unavailable: true, reason: 'offline' }, 20);
  return { initial, healthy, degraded, cooldown, probe, unavailable };
}

test('success, partial and failure retain every health field through a complete recovery cycle', () => {
  const initial = registry();
  assertHealth(initial, {});
  const success = recordSourceSuccess(initial, SOURCE, { responseMs: 12, availableAt: AVAILABLE }, 10);
  assertHealth(success, { lastSuccessAt: 10, lastResponseMs: 12, lastAvailableAt: AVAILABLE });
  const partial = recordSourcePartial(success, SOURCE, { reason: '  partial_1_of_2  ', responseMs: 0 }, 20);
  assertHealth(partial, {
    status: SOURCE_HEALTH.DEGRADED, lastSuccessAt: 20, lastResponseMs: 0,
    lastAvailableAt: AVAILABLE, degradationReason: 'partial_1_of_2',
  });
  const firstFailure = recordSourceFailure(partial, SOURCE, { reason: 'timeout' }, 30);
  assertHealth(firstFailure, {
    status: SOURCE_HEALTH.DEGRADED, consecutiveFailures: 1, lastSuccessAt: 20,
    lastFailureAt: 30, lastResponseMs: 0, lastAvailableAt: AVAILABLE, degradationReason: 'timeout',
  });
  const cooldown = recordSourceFailure(firstFailure, SOURCE, { error: { code: 'HTTP_503' } }, 40);
  assertHealth(cooldown, {
    status: SOURCE_HEALTH.COOLDOWN, consecutiveFailures: 2, lastSuccessAt: 20,
    lastFailureAt: 40, lastResponseMs: 0, lastAvailableAt: AVAILABLE,
    degradationReason: 'HTTP_503', cooldownUntil: 140,
  });
  const probe = claimSourceAttempt(cooldown, SOURCE, 140).registry;
  assertHealth(probe, { ...health(cooldown), halfOpenProbeActive: true, halfOpenProbeAt: 140 });
  const failedProbe = recordSourceFailure(probe, SOURCE, {}, 141);
  assertHealth(failedProbe, {
    ...health(cooldown), consecutiveFailures: 3, lastFailureAt: 141,
    degradationReason: 'request_failed', cooldownUntil: 241,
  });
  const recovered = recordSourceSuccess(failedProbe, SOURCE, {}, 142);
  assertHealth(recovered, {
    lastSuccessAt: 142, lastFailureAt: 141, lastResponseMs: 0, lastAvailableAt: AVAILABLE,
  });
});

test('success and partial reset failures, cooldown and probes from every prior state', () => {
  for (const [label, previous] of Object.entries(states())) {
    for (const [kind, update] of [['success', recordSourceSuccess], ['partial', recordSourcePartial]]) {
      const next = update(previous, SOURCE, { now: 200, responseMs: 0, availableAt: AVAILABLE_MS, reason: ' coverage ' }, 999);
      assertHealth(next, {
        status: kind === 'success' ? SOURCE_HEALTH.HEALTHY : SOURCE_HEALTH.DEGRADED,
        lastSuccessAt: 200, lastFailureAt: health(previous).lastFailureAt,
        lastResponseMs: 0, lastAvailableAt: AVAILABLE_MS,
        degradationReason: kind === 'success' ? null : 'coverage',
      });
      assert.notStrictEqual(next, previous, `${label}/${kind} creates a snapshot`);
      assert.equal(canAttemptSource(next, SOURCE, 200), true);
    }
  }
});

test('ordinary and unavailable failures preserve response history and reset probes from every prior state', () => {
  for (const [label, previous] of Object.entries(states())) {
    for (const unavailable of [false, true]) {
      const snapshot = JSON.stringify(previous);
      const priorHealth = health(previous);
      const failures = priorHealth.consecutiveFailures + 1;
      const protectedSource = unavailable || priorHealth.status === SOURCE_HEALTH.UNAVAILABLE;
      const cooldown = !protectedSource && (priorHealth.status === SOURCE_HEALTH.COOLDOWN || failures >= 2);
      const next = recordSourceFailure(previous, SOURCE, { now: 200, unavailable, reason: ' failed ' }, 999);
      assertHealth(next, {
        status: protectedSource ? SOURCE_HEALTH.UNAVAILABLE : cooldown ? SOURCE_HEALTH.COOLDOWN : SOURCE_HEALTH.DEGRADED,
        consecutiveFailures: failures, lastSuccessAt: priorHealth.lastSuccessAt,
        lastFailureAt: 200, lastResponseMs: priorHealth.lastResponseMs,
        lastAvailableAt: priorHealth.lastAvailableAt, degradationReason: 'failed',
        cooldownUntil: cooldown ? 300 : null,
      });
      assert.equal(JSON.stringify(previous), snapshot, `${label}/${unavailable} leaves the prior snapshot intact`);
      assert.notStrictEqual(next, previous);
    }
  }
});

test('unavailable failures stay protected on ordinary subsequent failures but responses can restore them', () => {
  for (const unavailable of [
    { unavailable: true }, { status: ' UNAVAILABLE ' }, { code: ' source_unavailable ' },
    { error: { code: 'SOURCE_UNAVAILABLE' } },
  ]) {
    const previous = states().healthy;
    const next = recordSourceFailure(previous, SOURCE, { ...unavailable, reason: ' offline ', responseMs: 25 }, 50);
    assertHealth(next, {
      status: SOURCE_HEALTH.UNAVAILABLE, consecutiveFailures: 1, lastSuccessAt: 10,
      lastFailureAt: 50, lastResponseMs: 25, lastAvailableAt: AVAILABLE, degradationReason: 'offline',
    });
    const sticky = recordSourceFailure(next, SOURCE, { reason: 'timeout' }, 60);
    assertHealth(sticky, {
      ...health(next), consecutiveFailures: 2, lastFailureAt: 60, degradationReason: 'timeout',
    });
    assert.equal(canAttemptSource(sticky, SOURCE, 1_000_000), false);
    assert.deepEqual(selectAvailableSources(sticky, {}, 1_000_000), []);
    assert.strictEqual(claimSourceAttempt(sticky, SOURCE, 1_000_000).registry, sticky);
    assert.equal(health(recordSourceSuccess(sticky, SOURCE, {}, 61)).status, SOURCE_HEALTH.HEALTHY);
    // This is existing behavior: partial coverage restores usability, not healthy status.
    assert.equal(health(recordSourcePartial(sticky, SOURCE, {}, 61)).status, SOURCE_HEALTH.DEGRADED);
  }
});

test('lastAvailableAt stays monotonic across mixed timestamp representations and all update kinds', () => {
  for (const update of [recordSourceSuccess, recordSourcePartial, recordSourceFailure]) {
    const previous = recordSourceSuccess(registry(), SOURCE, { availableAt: AVAILABLE }, 10);
    const older = update(previous, SOURCE, { availableAt: AVAILABLE_MS - 1 }, 20);
    assert.equal(health(older).lastAvailableAt, AVAILABLE);
    const absent = update(older, SOURCE, {}, 21);
    assert.equal(health(absent).lastAvailableAt, AVAILABLE);
    const equal = update(absent, SOURCE, { availableAt: AVAILABLE_MS }, 22);
    assert.equal(health(equal).lastAvailableAt, AVAILABLE_MS, 'equal time keeps the new source representation');
    const newer = update(equal, SOURCE, { availableAt: ' 2026-09-29T10:01:00+08:00 ' }, 23);
    assert.equal(health(newer).lastAvailableAt, '2026-09-29T10:01:00+08:00');
  }
});

test('null availability falls back to quoteTime while empty availability suppresses that alias', () => {
  for (const update of [recordSourceSuccess, recordSourcePartial, recordSourceFailure]) {
    assert.equal(health(update(registry(), SOURCE, { availableAt: null, quoteTime: AVAILABLE }, 10)).lastAvailableAt, AVAILABLE);
    assert.equal(health(update(registry(), SOURCE, { availableAt: '', quoteTime: AVAILABLE }, 10)).lastAvailableAt, null);
    assert.equal(health(update(registry(), SOURCE, { availableAt: '   ', quoteTime: AVAILABLE }, 10)).lastAvailableAt, null);
    assert.equal(health(update(registry(), SOURCE, { availableAt: 0, quoteTime: AVAILABLE }, 10)).lastAvailableAt, 0);
  }
});

test('response metadata aliases stay lazy and invalid response time stops later property reads', () => {
  for (const update of [recordSourceSuccess, recordSourcePartial, recordSourceFailure]) {
    for (const availableAt of [AVAILABLE, undefined, null, '', '   ', 0]) {
      const reads = [];
      update(registry(), SOURCE, {
        get responseMs() { reads.push('responseMs'); return 0; },
        get availableAt() { reads.push('availableAt'); return availableAt; },
        get quoteTime() { reads.push('quoteTime'); return AVAILABLE; },
      }, 1);
      assert.deepEqual(reads, availableAt == null
        ? ['responseMs', 'availableAt', 'quoteTime']
        : ['responseMs', 'availableAt']);
    }
    assert.throws(() => update(registry(), SOURCE, {
      responseMs: -1,
      get availableAt() { throw new Error('availability must not be read'); },
      get quoteTime() { throw new Error('quoteTime must not be read'); },
      get status() { throw new Error('unavailability must not be read'); },
    }, 1), /Source responseMs/);
  }
});

test('missing/null/empty response times retain history and an actual zero replaces it', () => {
  for (const update of [recordSourceSuccess, recordSourcePartial, recordSourceFailure]) {
    const previous = recordSourceSuccess(registry(), SOURCE, { responseMs: 27 }, 10);
    for (const responseMs of [undefined, null, '']) {
      assert.equal(health(update(previous, SOURCE, { responseMs }, 20)).lastResponseMs, 27);
    }
    assert.equal(health(update(previous, SOURCE, { responseMs: 0 }, 20)).lastResponseMs, 0);
    assert.equal(health(update(registry(), SOURCE, {}, 20)).lastResponseMs, null);
  }
});

test('partial/failure reasons keep trimming, truncation, precedence and default behavior', () => {
  assert.equal(health(recordSourcePartial(registry(), SOURCE, {}, 10)).degradationReason, 'partial_coverage');
  assert.equal(health(recordSourcePartial(registry(), SOURCE, { reason: '   ' }, 10)).degradationReason, 'partial_coverage');
  for (const update of [recordSourcePartial, recordSourceFailure]) {
    assert.equal(health(update(registry(), SOURCE, { reason: ` ${'x'.repeat(170)} ` }, 10)).degradationReason, 'x'.repeat(160));
  }
  for (const [failure, reason] of [
    [{ reason: ' explicit ', code: 'CODE', name: 'NAME' }, 'explicit'],
    [{ reason: ' ', code: ' CODE ', name: 'NAME' }, 'CODE'],
    [{ error: { name: ' NAME ' } }, 'NAME'],
    [{}, 'request_failed'],
    [' string failure ', 'string failure'],
    [Object.assign(new Error('synthetic'), { code: 'CUSTOM' }), 'CUSTOM'],
  ]) {
    assert.equal(health(recordSourceFailure(registry(), SOURCE, failure, 10)).degradationReason, reason);
  }
});

test('cancellations return the identical registry before source/clock/response validation and do not release a probe', () => {
  const previous = states().probe;
  const snapshot = JSON.stringify(previous);
  for (const failure of [
    { aborted: true }, { name: 'AbortError' }, { code: 'ABORT_ERR' }, { reason: ' AbOrTeD ' },
    { error: { name: 'AbortError' } }, Object.assign(new Error('synthetic cancellation'), { name: 'AbortError' }),
  ]) {
    assert.equal(isAbortedSourceFailure(failure), true);
    const invalidDetails = failure instanceof Error ? failure : { ...failure, now: NaN, responseMs: -1, availableAt: 'invalid' };
    assert.strictEqual(recordSourceFailure(previous, 'missing', invalidDetails, NaN), previous);
    assert.strictEqual(recordSourceFailure(previous, SOURCE, invalidDetails, NaN), previous);
  }
  assert.equal(JSON.stringify(previous), snapshot);
  assert.equal(health(previous).halfOpenProbeActive, true);
  assert.throws(() => recordSourceFailure(null, SOURCE, { aborted: true }), /Expected a source registry/);
});

test('cooldown comparison is inclusive, reserves one probe and release preserves all other health fields', () => {
  const cooldown = states().cooldown;
  assert.equal(canAttemptSource(cooldown, SOURCE, 129.999), false);
  assert.equal(canAttemptSource(cooldown, SOURCE, 130), true);
  assert.equal(canAttemptSource(cooldown, SOURCE, 130.001), true);
  const denied = claimSourceAttempt(cooldown, SOURCE, 129.999);
  assert.deepEqual(denied, { registry: cooldown, allowed: false, halfOpen: false });
  assert.equal(Object.isFrozen(denied), true);
  const probe = claimSourceAttempt(cooldown, SOURCE, 130);
  assert.equal(probe.allowed, true);
  assert.equal(probe.halfOpen, true);
  assertHealth(probe.registry, { ...health(cooldown), halfOpenProbeActive: true, halfOpenProbeAt: 130 });
  for (const at of [130, 130.001, 1_000_000]) {
    assert.equal(canAttemptSource(probe.registry, SOURCE, at), false);
    assert.deepEqual(selectAvailableSources(probe.registry, {}, at), []);
    assert.strictEqual(claimSourceAttempt(probe.registry, SOURCE, at).registry, probe.registry);
  }
  const released = releaseSourceAttempt(probe.registry, SOURCE);
  assert.deepEqual(health(released), health(cooldown));
  assert.equal(canAttemptSource(released, SOURCE, 130), true);
  assert.strictEqual(releaseSourceAttempt(released, SOURCE), released);
  assert.strictEqual(releaseSourceAttempt(released, 'missing'), released);
});

test('zero-duration cooldown still requires a single half-open probe and failure resets its reservation', () => {
  const previous = recordSourceFailure(registry({ failureThreshold: 1, cooldownMs: 0 }), SOURCE, {}, 0);
  assertHealth(previous, {
    status: SOURCE_HEALTH.COOLDOWN, consecutiveFailures: 1, lastFailureAt: 0,
    degradationReason: 'request_failed', cooldownUntil: 0,
  });
  const probe = claimSourceAttempt(previous, SOURCE, 0);
  assert.equal(probe.halfOpen, true);
  assert.equal(canAttemptSource(probe.registry, SOURCE, 0), false);
  const retripped = recordSourceFailure(probe.registry, SOURCE, {}, 1);
  assertHealth(retripped, {
    status: SOURCE_HEALTH.COOLDOWN, consecutiveFailures: 2, lastFailureAt: 1,
    degradationReason: 'request_failed', cooldownUntil: 1,
  });
  assert.equal(canAttemptSource(retripped, SOURCE, 1), true);
});

test('claim and release keep frozen historical snapshots while non-cooldown attempts keep registry identity', () => {
  for (const previous of [states().initial, states().healthy, states().degraded]) {
    const attempt = claimSourceAttempt(previous, SOURCE, 200);
    assert.deepEqual(attempt, { registry: previous, allowed: true, halfOpen: false });
    assert.strictEqual(attempt.registry, previous);
    assert.equal(Object.isFrozen(attempt), true);
  }
  const previous = states().cooldown;
  const snapshot = JSON.stringify(previous);
  const probe = claimSourceAttempt(previous, SOURCE, 130);
  const probeSnapshot = JSON.stringify(probe.registry);
  const released = releaseSourceAttempt(probe.registry, SOURCE);
  assert.equal(Object.isFrozen(probe), true);
  assert.equal(Object.isFrozen(probe.registry), true);
  assert.equal(Object.isFrozen(health(probe.registry)), true);
  assert.equal(Object.isFrozen(released), true);
  assert.equal(Object.isFrozen(health(released)), true);
  assert.equal(JSON.stringify(previous), snapshot);
  assert.equal(JSON.stringify(probe.registry), probeSnapshot);
  assert.notStrictEqual(released, probe.registry);
  assert.strictEqual(getSourceDescriptor(released, SOURCE), getSourceDescriptor(previous, SOURCE));
});

test('all health updates create frozen private snapshots and preserve unrelated entry/descriptor identity', () => {
  const input = descriptor();
  const previous = createSourceRegistry([input, descriptor('synthetic-secondary')]);
  const snapshot = JSON.stringify(previous);
  input.markets.push('us');
  assert.deepEqual(getSourceDescriptor(previous, SOURCE).markets, ['cn']);
  for (const update of [recordSourceSuccess, recordSourcePartial, recordSourceFailure]) {
    const next = update(previous, SOURCE, { availableAt: AVAILABLE, responseMs: 0 }, 10);
    assert.notStrictEqual(next, previous);
    assert.notStrictEqual(next.sources[0], previous.sources[0]);
    assert.strictEqual(next.sources[1], previous.sources[1]);
    assert.strictEqual(next.sources[0].descriptor, previous.sources[0].descriptor);
    assert.equal(Object.isFrozen(next), true);
    assert.equal(Object.isFrozen(next.policy), true);
    assert.equal(Object.isFrozen(next.sources), true);
    assert.equal(Object.isFrozen(next.sources[0]), true);
    assert.equal(Object.isFrozen(health(next)), true);
    assert.throws(() => { health(next).status = 'mutated'; }, TypeError);
    assert.throws(() => { next.sources.push(previous.sources[1]); }, TypeError);
  }
  assert.equal(JSON.stringify(previous), snapshot);
});

test('canAttempt and unfiltered selection agree for every state, boundary and probe ownership', () => {
  for (const [label, value] of Object.entries(states())) {
    for (const at of [0, 129.999, 130, 130.001, 1_000_000]) {
      const selected = selectAvailableSources(value, {}, at);
      assert.equal(selected.some(item => item.id === SOURCE), canAttemptSource(value, SOURCE, at), `${label} at ${at}`);
      assert.equal(Object.isFrozen(selected), true);
    }
  }
  assert.equal(canAttemptSource(registry(), 'missing', NaN), false);
  assert.equal(getSourceHealth(registry(), 'missing'), null);
  assert.equal(getSourceDescriptor(registry(), 'missing'), null);
});

test('selection retains market/capability/proxy filters, capability precedence and deterministic priority', () => {
  const value = createSourceRegistry([
    descriptor('b-primary', { requiresProxy: true }), descriptor('a-primary'),
    descriptor('nav-only', { priority: 5, capabilities: ['nav'] }),
    descriptor('us-only', { priority: 100, markets: ['us'] }),
  ]);
  assert.deepEqual(selectAvailableSources(value, { market: ' cn ', capability: 'estimate' }, 1).map(item => item.id), ['a-primary', 'b-primary']);
  assert.deepEqual(selectAvailableSources(value, { market: 'cn', capabilities: ['nav'], proxyAvailable: false }, 1).map(item => item.id), ['a-primary', 'nav-only']);
  assert.deepEqual(selectAvailableSources(value, { market: 'cn', capability: 'estimate', capabilities: ['missing'] }, 1).map(item => item.id), ['a-primary', 'b-primary']);
  assert.deepEqual(selectAvailableSources(value, { market: 'hk' }, 1), []);
});

test('response validation preserves registry, clock, source, responseMs and availableAt exception order', () => {
  for (const update of [recordSourceSuccess, recordSourcePartial, recordSourceFailure]) {
    assert.throws(() => update(null, 'missing', { now: NaN, responseMs: -1, availableAt: 'invalid' }), /Expected a source registry/);
    assert.throws(() => update(registry(), 'missing', { now: NaN, responseMs: -1, availableAt: 'invalid' }), /Source clock/);
    assert.throws(() => update(registry(), 'missing', { now: 0, responseMs: -1, availableAt: 'invalid' }), /Unknown source: missing\./);
    assert.throws(() => update(registry(), SOURCE, { now: 0, responseMs: -1, availableAt: 'invalid' }), /Source responseMs/);
    assert.throws(() => update(registry(), SOURCE, { now: 0, responseMs: 0, availableAt: 'invalid' }), /Source availableAt/);
    const original = registry();
    assert.throws(() => update(original, SOURCE, { responseMs: Infinity }), TypeError);
    assertHealth(original, {});
  }
  assert.throws(() => claimSourceAttempt(registry(), 'missing', NaN), /Source clock/);
  assert.equal(claimSourceAttempt(registry(), 'missing', 0).allowed, false);
  assert.throws(() => selectAvailableSources(null, [], NaN), /Expected a source registry/);
  assert.throws(() => selectAvailableSources(registry(), [], NaN), /Source selection criteria/);
  assert.throws(() => selectAvailableSources(registry(), { now: NaN, capabilities: 'invalid' }), /Source clock/);
  assert.throws(() => selectAvailableSources(registry(), { now: 0, capabilities: 'invalid' }), /capabilities must be an array/);
});

test('health entry points preserve exact error names and messages at each validation boundary', () => {
  const value = registry();
  for (const update of [recordSourceSuccess, recordSourcePartial, recordSourceFailure]) {
    for (const [input, sourceId, details, name, message] of [
      [null, 'missing', { now: NaN }, 'TypeError', 'Expected a source registry created by createSourceRegistry.'],
      [value, 'missing', { now: NaN }, 'TypeError', 'Source clock must be a finite number no smaller than 0.'],
      [value, 'missing', { now: 0 }, 'RangeError', 'Unknown source: missing.'],
      [value, SOURCE, { responseMs: -1 }, 'TypeError', 'Source responseMs must be a finite number no smaller than 0.'],
      [value, SOURCE, { availableAt: 'invalid' }, 'TypeError', 'Source availableAt must be a valid timestamp.'],
      [value, SOURCE, { availableAt: -1 }, 'TypeError', 'Source availableAt must be a finite number no smaller than 0.'],
    ]) {
      assert.throws(() => update(input, sourceId, details), { name, message });
    }
  }
  assert.throws(() => canAttemptSource(value, SOURCE, NaN), {
    name: 'TypeError', message: 'Source clock must be a finite number no smaller than 0.',
  });
  assert.equal(canAttemptSource(value, 'missing', NaN), false, 'unknown source still short-circuits clock validation');
  assert.throws(() => claimSourceAttempt(value, 'missing', NaN), {
    name: 'TypeError', message: 'Source clock must be a finite number no smaller than 0.',
  });
});

test('success does not read reason and partial reads reason only after response/timestamp validation', () => {
  const reads = [];
  const details = {
    get responseMs() { reads.push('responseMs'); return 0; },
    get availableAt() { reads.push('availableAt'); return AVAILABLE; },
    get reason() { reads.push('reason'); return 'coverage'; },
  };
  recordSourceSuccess(registry(), SOURCE, details, 1);
  assert.deepEqual(reads, ['responseMs', 'availableAt']);
  reads.length = 0;
  recordSourcePartial(registry(), SOURCE, details, 1);
  assert.deepEqual(reads, ['responseMs', 'availableAt', 'reason']);
  reads.length = 0;
  assert.throws(() => recordSourcePartial(registry(), SOURCE, {
    get responseMs() { reads.push('responseMs'); return -1; },
    get reason() { throw new Error('reason must not be read'); },
  }, 1), /Source responseMs/);
  assert.deepEqual(reads, ['responseMs']);
  assert.throws(() => recordSourcePartial(registry(), SOURCE, {
    responseMs: 0, availableAt: 'invalid',
    get reason() { throw new Error('reason must not be read'); },
  }, 1), /Source availableAt/);
});

test('failure preserves abort/metadata/unavailable/reason property observation order', () => {
  for (const previous of [states().healthy, states().unavailable]) {
    for (const unavailable of [false, true]) {
      const reads = [];
      const details = Object.fromEntries([]);
      for (const [key, value] of [
        ['name', 'SyntheticError'], ['code', 'CUSTOM'], ['reason', 'coverage'], ['aborted', false],
        ['now', 1], ['responseMs', 0], ['availableAt', AVAILABLE], ['status', 'failed'], ['unavailable', unavailable],
      ]) {
        Object.defineProperty(details, key, { get() { reads.push(key); return value; } });
      }
      recordSourceFailure(previous, SOURCE, details);
      assert.deepEqual(reads, [
        'name', 'code', 'reason', 'aborted', 'now', 'responseMs', 'availableAt',
        'status', 'code', 'unavailable', 'reason',
      ]);
    }
  }
});

test('unavailable failure branches keep previous-status short circuits before copying health', () => {
  for (const [previous, unavailable, expectedStatusReads] of [
    [states().healthy, false, 3],
    [states().healthy, true, 1],
    [states().unavailable, false, 2],
    [states().unavailable, true, 1],
  ]) {
    let statusReads = 0;
    const previousHealth = new Proxy(health(previous), {
      get(target, key) {
        if (key === 'status') statusReads += 1;
        return target[key];
      },
    });
    const observed = { ...previous, sources: [{ ...previous.sources[0], health: previousHealth }] };
    recordSourceFailure(observed, SOURCE, { unavailable, reason: 'failure' }, 100);
    assert.equal(statusReads, expectedStatusReads);
  }
});

test('descriptor/policy validation and legacy numeric conversion remain unchanged', () => {
  assert.throws(() => createSourceRegistry(null, null), /Source descriptors must be an array/);
  assert.throws(() => createSourceRegistry([], null), /Source health policy must be an object/);
  assert.throws(() => createSourceRegistry([descriptor('', { requiresProxy: 'yes' })]), /requiresProxy must be boolean/);
  assert.throws(() => registerSource(registry(), descriptor(SOURCE, { timeoutMs: -1 })), /Source timeoutMs/);
  assert.throws(() => createSourceRegistry([], { failureThreshold: 0 }), /Source failureThreshold/);
  assert.throws(() => createSourceRegistry([], { cooldownMs: 0.5 }), /Source cooldownMs/);
  const converted = recordSourceSuccess(registry(), SOURCE, { now: false, responseMs: false, availableAt: false });
  assertHealth(converted, { lastSuccessAt: 0, lastResponseMs: 0, lastAvailableAt: 0 });
  assertHealth(recordSourceSuccess(registry(), SOURCE, ['ignored'], 2.5), { lastSuccessAt: 2.5 });
});
