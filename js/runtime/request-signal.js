function abortError(reason = 'Request aborted') {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const error = new Error(typeof reason === 'string' && reason ? reason : 'Request aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  error.aborted = true;
  return error;
}

function timeoutError(timeoutMs) {
  const error = new Error(`Request timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  error.code = 'REQUEST_TIMEOUT';
  error.timeoutMs = timeoutMs;
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

export function createRequestSignal(externalSignal, timeoutMs, AbortControllerClass = globalThis.AbortController) {
  if (typeof AbortControllerClass !== 'function') throw new Error('AbortController is required for request cancellation.');
  const controller = new AbortControllerClass();
  const duration = Number(timeoutMs);
  let timedOut = false;
  let timer = null;

  const abortFromCaller = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener?.('abort', abortFromCaller, { once: true });

  if (Number.isFinite(duration) && duration >= 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError(duration));
    }, duration);
  }

  return Object.freeze({
    signal: controller.signal,
    cleanup() {
      if (timer != null) clearTimeout(timer);
      externalSignal?.removeEventListener?.('abort', abortFromCaller);
    },
    normalizeError(error) {
      if (externalSignal?.aborted) return abortError(externalSignal.reason);
      if (timedOut) return timeoutError(duration);
      return error;
    },
  });
}
