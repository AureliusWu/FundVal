function abortControllerClass(value) {
  const Controller = value || globalThis.AbortController;
  if (typeof Controller !== 'function') throw new Error('AbortController is required for refresh coordination.');
  return Controller;
}

function clockValue(value) {
  const number = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

export function isRefreshAbort(error, signal) {
  return Boolean(signal?.aborted
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.aborted === true);
}

export function createRefreshGeneration({
  generation,
  trigger = 'unknown',
  startedAt = Date.now(),
  AbortControllerClass,
} = {}) {
  const number = Number(generation);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError('Refresh generation must be a positive safe integer.');
  const startedAtMs = clockValue(startedAt);
  const Controller = abortControllerClass(AbortControllerClass);
  const controller = new Controller();
  const metadata = Object.freeze({
    generation: number,
    requestId: `refresh-${number}-${startedAtMs}`,
    startedAt: new Date(startedAtMs).toISOString(),
    trigger: String(trigger || 'unknown').slice(0, 40),
  });

  return Object.freeze({
    ...metadata,
    signal: controller.signal,
    abort(reason = 'superseded') {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    get aborted() { return controller.signal.aborted; },
    get abortReason() { return controller.signal.reason || null; },
  });
}
