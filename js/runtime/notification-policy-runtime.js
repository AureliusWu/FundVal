// Internal boolean-only projection. Full public notification-policy API remains unchanged.
import { parseQuoteTimestamp } from './quote-contract.js';
import { chinaDateKey } from './market-clock.js';
import { createValuationPeriod } from './valuation-period.js';

const ELIGIBLE_STATUSES = new Set(['realtime', 'delayed']);
const DEFAULT_NOTIFICATION_MAX_AGE_MS = 10 * 60 * 1000;
const DEFAULT_NOTIFICATION_FUTURE_SKEW_MS = 5 * 60 * 1000;

function instantMs(value) {
  const number = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampRejected(timestamp, nowMs, today, maxAgeMs, maxFutureSkewMs) {
  if (timestamp == null) return true;
  if (chinaDateKey(timestamp) !== today) return true;
  const ageMs = nowMs - timestamp;
  if (ageMs < -maxFutureSkewMs) return true;
  if (ageMs > maxAgeMs) return true;
  return false;
}

export function isQuoteEligibleForNotification(quote, {
  now = Date.now(),
  maxAgeMs = DEFAULT_NOTIFICATION_MAX_AGE_MS,
  maxFutureSkewMs = DEFAULT_NOTIFICATION_FUTURE_SKEW_MS,
} = {}) {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) {
    return false;
  }

  const nowMs = instantMs(now);
  if (nowMs == null) return false;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0
    || !Number.isFinite(maxFutureSkewMs) || maxFutureSkewMs < 0) {
    return false;
  }
  if (!ELIGIBLE_STATUSES.has(quote.status)) {
    return false;
  }
  if (quote.valueKind !== 'intraday_estimate') {
    return false;
  }
  if (!Number.isFinite(quote.changePct)) {
    return false;
  }

  const observedMs = parseQuoteTimestamp(quote.observedAt);
  const fetchedMs = parseQuoteTimestamp(quote.fetchedAt);
  const today = chinaDateKey(nowMs);
  if (!today) return false;

  const observedReason = timestampRejected(
    observedMs, nowMs, today, maxAgeMs, maxFutureSkewMs,
  );
  if (observedReason) return false;

  const fetchedReason = timestampRejected(
    fetchedMs, nowMs, today, maxAgeMs, maxFutureSkewMs,
  );
  if (fetchedReason) return false;
  if (quote.sourceTier === 'cache' || quote.cacheState != null) return false;
  if (!createValuationPeriod(quote, { now: nowMs }).isTodayEstimate) return false;

  return true;
}
