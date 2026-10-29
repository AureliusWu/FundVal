import test from 'node:test';
import assert from 'node:assert/strict';
import { boundObservedCancellation } from '../e2e/helpers/cancel-clock.mjs';

const sample = (extra = {}) => ({ nodeBeforeMs: 1000, nodeAfterMs: 1010, pageSampleMs: 100,
  pageCancelMs: 200, sampleTimeOriginMs: 42, cancelTimeOriginMs: 42,
  invocationStartMs: 1011, invocationEndMs: 1120, closedNodeMs: 3099, ...extra });

test('trusted-click conservative upper preserves the exact 2000 ms boundary', () => {
  const result = boundObservedCancellation(sample());
  assert.equal(result.calibratedLowerMs, 1099); assert.equal(result.calibratedUpperMs, 1111);
  assert.equal(result.observedCloseUpperBoundMs, 2000);
  assert.equal(result.observedCloseUpperBoundMs <= 2000, true);
  assert.equal(boundObservedCancellation(sample({ closedNodeMs: 3099.001 })).observedCloseUpperBoundMs <= 2000, false);
  assert.ok(Object.isFrozen(result));
});
test('actionability remains raw diagnostic but is not the actual click start', () => {
  const result = boundObservedCancellation(sample({ pageCancelMs: 300, invocationEndMs: 1250, closedNodeMs: 3150 }));
  assert.equal(result.invocationToCloseMs, 2139); assert.equal(result.observedCloseUpperBoundMs, 1951);
  assert.equal(boundObservedCancellation(sample({ pageCancelMs: 300, invocationEndMs: 1250, closedNodeMs: 3200 })).observedCloseUpperBoundMs, 2001);
});
test('every missing, nonnumeric, nonfinite or negative clock fails closed', () => {
  for (const name of Object.keys(sample())) for (const value of [undefined, null, false, '', '1', NaN, Infinity, -1]) {
    assert.throws(() => boundObservedCancellation(sample({ [name]: value })));
  }
});
test('reversed, stale or overly wide clock samples fail closed', () => {
  for (const extra of [{ nodeAfterMs: 999 }, { nodeAfterMs: 1101 }, { invocationStartMs: 1009 },
    { invocationEndMs: 1010 }, { pageCancelMs: 99 }, { pageCancelMs: 5100.001 }, { closedNodeMs: 1000 }]) {
    assert.throws(() => boundObservedCancellation(sample(extra)));
  }
});
test('a new document or a disjoint mapped click cannot obtain a pass', () => {
  assert.throws(() => boundObservedCancellation(sample({ cancelTimeOriginMs: 43 })));
  assert.throws(() => boundObservedCancellation(sample({ pageCancelMs: 500 })));
});
test('known invocation bounds may tighten calibration without becoming optimistic', () => {
  const result = boundObservedCancellation(sample({ pageCancelMs: 110, invocationStartMs: 1011, invocationEndMs: 1015 }));
  assert.equal(result.clickLowerMs, 1011); assert.equal(result.clickUpperMs, 1015);
  assert.equal(result.observedCloseUpperBoundMs, 2088);
});
