// Pure, allowlisted UI/retry policy. Never include canonical holdings hashes,
// exception messages, credentials, URLs or provider bodies in these models.
export function syncOutcome(result, pending = false) {
  const readFirst = result?.writeUnknown === true || result?.patched === true || result?.patchAcknowledged === true;
  if (result?.ok === true) return {
    state: result.remoteVerified === true && result.pending !== true && !pending ? 'verified' : 'pending',
    code: result.pending === true || pending ? 'pending' : result.remoteVerified === true ? 'verified' : 'verification_required',
    retryable: false, retryAfterMs: 0, readFirst: false,
  };
  let code = 'validation';
  const reason = result?.reason;
  if (reason === 'remote_schema_future') code = 'newer_schema';
  else if (reason === 'remote_schema_upgrade_required') code = 'upgrade_required';
  else if (['local_snapshot_unstable', 'local_persist_unstable', 'remote_readback_mismatch', 'remote_target_readback_mismatch', 'holdings_conflict'].includes(reason)) code = 'conflict';
  else if (['cloud_pull_failed', 'cloud_push_failed', 'remote_read_failed', 'remote_patch_failed', 'remote_readback_failed'].includes(reason)) code = 'network';
  else {
    const http = /^(?:remote_(?:patch_|create_)?http_)(\d{3})$/.exec(typeof reason === 'string' ? reason : '');
    const status = http ? Number(http[1]) : 0;
    code = status === 401 ? 'auth' : status === 403 ? 'permission' : status === 404 ? 'missing'
      : status === 409 ? 'conflict' : status === 429 ? 'rate_limit' : status >= 500 && status <= 599 ? 'unavailable' : code;
  }
  const failure = result?.failure;
  if (['auth', 'permission', 'missing', 'conflict', 'rate_limit', 'unavailable', 'network', 'invalid_response', 'invalid_request'].includes(failure?.code)) code = failure.code;
  const retryAfterMs = Number.isFinite(failure?.retryAfterMs) && failure.retryAfterMs >= 0 && failure.retryAfterMs <= 86400000
    ? failure.retryAfterMs : 0;
  return {
    state: code === 'newer_schema' ? 'readonly' : code === 'conflict' ? 'conflict' : code === 'upgrade_required' ? 'pending' : 'failed',
    code, retryable: ['rate_limit', 'unavailable', 'network'].includes(code),
    retryAfterMs: code === 'rate_limit' ? Math.max(60000, retryAfterMs) : retryAfterMs,
    readFirst,
  };
}

export function syncRetry({ attempt = 0, now = Date.now(), random = Math.random, retryAfterMs = 0 } = {}) {
  const count = Number.isInteger(attempt) && attempt >= 0 ? attempt : 8;
  if (count >= 8 || !Number.isFinite(now) || now < 0) return { exhausted: true, delayMs: 0, retryAt: null };
  let sample;
  try { sample = random(); } catch (_) { sample = 0.5; }
  if (!Number.isFinite(sample)) sample = 0.5;
  const minimum = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 86400000 ? retryAfterMs : 0;
  const delayMs = Math.max(minimum, Math.round(Math.min(300000, 2000 * 2 ** count) * (0.5 + Math.max(0, Math.min(1, sample)) * 0.5)));
  return { exhausted: false, delayMs, retryAt: now + delayMs };
}
