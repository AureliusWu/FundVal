import { parseQuoteTimestamp } from './quote-contract.js';

const CHINA_TIME_ZONE = 'Asia/Shanghai';
const ELIGIBLE_STATUSES = new Set(['realtime', 'delayed']);

export const DEFAULT_NOTIFICATION_MAX_AGE_MS = 10 * 60 * 1000;
export const DEFAULT_NOTIFICATION_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const NOTIFICATION_REJECTION_REASONS = Object.freeze({
  INVALID_QUOTE: 'invalid_quote',
  INVALID_NOW: 'invalid_now',
  INVALID_FRESHNESS_POLICY: 'invalid_freshness_policy',
  STATUS_NOT_ELIGIBLE: 'status_not_eligible',
  VALUE_KIND_NOT_ELIGIBLE: 'value_kind_not_eligible',
  CHANGE_PCT_NOT_FINITE: 'change_pct_not_finite',
  OBSERVED_AT_INVALID: 'observed_at_invalid',
  FETCHED_AT_INVALID: 'fetched_at_invalid',
  OBSERVED_AT_CROSS_DAY: 'observed_at_cross_day',
  FETCHED_AT_CROSS_DAY: 'fetched_at_cross_day',
  OBSERVED_AT_IN_FUTURE: 'observed_at_in_future',
  FETCHED_AT_IN_FUTURE: 'fetched_at_in_future',
  OBSERVED_AT_EXPIRED: 'observed_at_expired',
  FETCHED_AT_EXPIRED: 'fetched_at_expired',
});

function instantMs(value) {
  const number = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(number) ? number : null;
}

function chinaDateKey(timestamp) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: CHINA_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(
      parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]),
    );
    return values.year && values.month && values.day
      ? `${values.year}-${values.month}-${values.day}`
      : null;
  } catch (_) {
    return null;
  }
}

function rejected(reason, details = {}) {
  return Object.freeze({ eligible: false, reason, ...details });
}

function eligible(details) {
  return Object.freeze({ eligible: true, reason: null, ...details });
}

function timestampRejection(label, timestamp, nowMs, today, maxAgeMs, maxFutureSkewMs) {
  const prefix = label === 'observedAt' ? 'OBSERVED_AT' : 'FETCHED_AT';
  if (timestamp == null) return NOTIFICATION_REJECTION_REASONS[`${prefix}_INVALID`];
  if (chinaDateKey(timestamp) !== today) return NOTIFICATION_REJECTION_REASONS[`${prefix}_CROSS_DAY`];
  const ageMs = nowMs - timestamp;
  if (ageMs < -maxFutureSkewMs) return NOTIFICATION_REJECTION_REASONS[`${prefix}_IN_FUTURE`];
  if (ageMs > maxAgeMs) return NOTIFICATION_REJECTION_REASONS[`${prefix}_EXPIRED`];
  return null;
}

/**
 * Evaluates whether a Quote may be included in the v15 daily notification.
 * The decision is fail-closed and depends only on the Quote and explicit time
 * inputs, so callers can safely evaluate the same snapshot before rendering.
 */
export function evaluateNotificationEligibility(quote, {
  now = Date.now(),
  maxAgeMs = DEFAULT_NOTIFICATION_MAX_AGE_MS,
  maxFutureSkewMs = DEFAULT_NOTIFICATION_FUTURE_SKEW_MS,
} = {}) {
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) {
    return rejected(NOTIFICATION_REJECTION_REASONS.INVALID_QUOTE);
  }

  const nowMs = instantMs(now);
  if (nowMs == null) return rejected(NOTIFICATION_REJECTION_REASONS.INVALID_NOW);
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0
    || !Number.isFinite(maxFutureSkewMs) || maxFutureSkewMs < 0) {
    return rejected(NOTIFICATION_REJECTION_REASONS.INVALID_FRESHNESS_POLICY);
  }
  if (!ELIGIBLE_STATUSES.has(quote.status)) {
    return rejected(NOTIFICATION_REJECTION_REASONS.STATUS_NOT_ELIGIBLE);
  }
  if (quote.valueKind !== 'intraday_estimate') {
    return rejected(NOTIFICATION_REJECTION_REASONS.VALUE_KIND_NOT_ELIGIBLE);
  }
  if (!Number.isFinite(quote.changePct)) {
    return rejected(NOTIFICATION_REJECTION_REASONS.CHANGE_PCT_NOT_FINITE);
  }

  const observedMs = parseQuoteTimestamp(quote.observedAt);
  const fetchedMs = parseQuoteTimestamp(quote.fetchedAt);
  const today = chinaDateKey(nowMs);
  if (!today) return rejected(NOTIFICATION_REJECTION_REASONS.INVALID_NOW);

  const observedReason = timestampRejection(
    'observedAt', observedMs, nowMs, today, maxAgeMs, maxFutureSkewMs,
  );
  if (observedReason) return rejected(observedReason);

  const fetchedReason = timestampRejection(
    'fetchedAt', fetchedMs, nowMs, today, maxAgeMs, maxFutureSkewMs,
  );
  if (fetchedReason) return rejected(fetchedReason);

  return eligible({
    observedAgeMs: Math.max(0, nowMs - observedMs),
    fetchedAgeMs: Math.max(0, nowMs - fetchedMs),
    chinaDate: today,
  });
}

export function isQuoteEligibleForNotification(quote, options) {
  return evaluateNotificationEligibility(quote, options).eligible;
}
