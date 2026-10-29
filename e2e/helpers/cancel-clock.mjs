// Map a trusted DOM click to a conservative Node-clock interval. This bounds
// observed native Worker-close latency, not physical CPU/GPU/memory release.
// Chrome/Node monotonic clocks are assumed equal-rate over at most five seconds;
// 1 ms covers their combined quantization/precision/drift, not network delay.
export function boundObservedCancellation(input) {
  const names = ['nodeBeforeMs', 'nodeAfterMs', 'pageSampleMs', 'pageCancelMs',
    'sampleTimeOriginMs', 'cancelTimeOriginMs', 'invocationStartMs', 'invocationEndMs', 'closedNodeMs'];
  if (!input || names.some(name => typeof input[name] !== 'number' || !Number.isFinite(input[name]) || input[name] < 0)) {
    throw new Error('Invalid cancellation clock sample.');
  }
  const { nodeBeforeMs, nodeAfterMs, pageSampleMs, pageCancelMs, sampleTimeOriginMs,
    cancelTimeOriginMs, invocationStartMs, invocationEndMs, closedNodeMs } = input;
  const timingErrorBudgetMs = 1, roundTripMs = nodeAfterMs - nodeBeforeMs;
  if (roundTripMs < 0 || roundTripMs > 100 || nodeAfterMs > invocationStartMs
    || invocationStartMs > invocationEndMs || closedNodeMs < invocationStartMs
    || sampleTimeOriginMs !== cancelTimeOriginMs || pageCancelMs < pageSampleMs
    || pageCancelMs - pageSampleMs > 5000) throw new Error('Invalid cancellation clock order.');
  const delta = pageCancelMs - pageSampleMs;
  const calibratedLowerMs = nodeBeforeMs + delta - timingErrorBudgetMs;
  const calibratedUpperMs = nodeAfterMs + delta + timingErrorBudgetMs;
  const clickLowerMs = Math.max(invocationStartMs, calibratedLowerMs);
  const clickUpperMs = Math.min(invocationEndMs, calibratedUpperMs, closedNodeMs);
  if (clickLowerMs > clickUpperMs) throw new Error('Cancellation clocks do not overlap.');
  return Object.freeze({ timingErrorBudgetMs, roundTripMs, calibratedLowerMs, calibratedUpperMs,
    clickLowerMs, clickUpperMs, observedCloseLowerBoundMs: closedNodeMs - clickUpperMs,
    observedCloseUpperBoundMs: closedNodeMs - clickLowerMs,
    invocationToCloseMs: closedNodeMs - invocationStartMs });
}

// Explicit release acceptance: keep the original performance goal observable.
// A waived goal miss is never reported as PASS or as successful SLA acceptance.
export function observeNativeCloseLatency(observedUpperBoundMs) {
  if (typeof observedUpperBoundMs !== 'number' || !Number.isFinite(observedUpperBoundMs) || observedUpperBoundMs < 0) {
    throw new Error('Invalid native close observation.');
  }
  return Object.freeze({ goalMs: 2000, observedUpperBoundMs,
    verdict: observedUpperBoundMs <= 2000 ? 'PASS' : 'NOT_PASSED',
    releaseDecision: 'USER_WAIVED', enforcement: 'OBSERVED_NOT_ENFORCED' });
}
