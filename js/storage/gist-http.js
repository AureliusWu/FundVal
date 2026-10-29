const MAX_WAIT_MS = 86400000;
const PHASES = new Set(['get', 'patch', 'discovery', 'create']);
const CODES = new Set(['auth', 'permission', 'missing', 'conflict', 'rate_limit', 'unavailable', 'network', 'invalid_response', 'invalid_request']);
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// These DTOs intentionally never retain a response, Error, URL or header value.
export function gistFailure(code, { phase = 'get', status = null, retryAfterMs = 0 } = {}) {
  const safeCode = CODES.has(code) ? code : 'invalid_response';
  return {
    reason: `gist_${safeCode}`,
    code: safeCode,
    phase: PHASES.has(phase) ? phase : 'get',
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    retryable: ['rate_limit', 'unavailable', 'network'].includes(safeCode),
    retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(0, Math.min(MAX_WAIT_MS, Math.ceil(retryAfterMs))) : 0,
  };
}

function header(response, name) {
  try {
    const value = response?.headers?.get(name);
    return typeof value === 'string' && value.length <= 256 && !/[\r\n]/.test(value) ? value.trim() : '';
  } catch (_) { return ''; }
}

function clockMs(now) {
  try {
    const value = typeof now === 'function' ? now() : now;
    const time = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(time) && time >= 0 && time <= 8640000000000000) return time;
  } catch (_) { /* Invalid clocks must not leak caller exceptions. */ }
  return Date.now();
}

function decimalSeconds(value) {
  if (!/^\d+$/.test(value)) return null;
  const significant = value.replace(/^0+/, '') || '0';
  // Avoid overflow even for a bounded but very long decimal header.
  return significant.length > 15 ? Number.MAX_SAFE_INTEGER : Number(significant);
}

function retryWait(value, now) {
  const seconds = decimalSeconds(value);
  if (seconds !== null) return Math.min(MAX_WAIT_MS, seconds * 1000);
  if (!HTTP_DATE.test(value)) return 0;
  const time = Date.parse(value);
  // Round-trip prevents Date.parse from silently normalizing invalid dates.
  if (!Number.isFinite(time) || new Date(time).toUTCString() !== value) return 0;
  return Math.max(0, Math.min(MAX_WAIT_MS, time - now));
}

export function classifyGistHttpFailure(response, { phase = 'get', now = Date.now } = {}) {
  let status;
  try { status = response?.status; } catch (_) { return gistFailure('invalid_response', { phase }); }
  if (!Number.isInteger(status) || status < 100 || status > 599) return gistFailure('invalid_response', { phase });
  const retryAfter = header(response, 'retry-after');
  const remaining = header(response, 'x-ratelimit-remaining');
  let code = 'invalid_response';
  if (status === 401) code = 'auth';
  else if (status === 403) code = remaining === '0' || retryAfter ? 'rate_limit' : 'permission';
  else if (status === 404) code = 'missing';
  else if (status === 409) code = 'conflict';
  else if (status === 429) code = 'rate_limit';
  else if (status >= 500) code = 'unavailable';
  else if (status >= 400) code = 'invalid_request';
  const timestamp = clockMs(now);
  let wait = ['rate_limit', 'unavailable'].includes(code) ? retryWait(retryAfter, timestamp) : 0;
  if (code === 'rate_limit') {
    if (remaining === '0') {
      const reset = decimalSeconds(header(response, 'x-ratelimit-reset'));
      if (reset !== null) wait = Math.max(wait, Math.min(MAX_WAIT_MS, Math.max(0, reset * 1000 - timestamp)));
    }
    wait = Math.max(60000, wait);
  }
  return gistFailure(code, { phase, status, retryAfterMs: wait });
}
