import { nullableNumber, parseQuoteTimestamp } from './quote-contract.js';

export function indexQuoteStatus(observedAt, now = Date.now()) {
  const timestamp = parseQuoteTimestamp(observedAt);
  return timestamp != null && timestamp <= now && now - timestamp <= 10 * 60_000 ? 'current' : 'stale';
}

export function normalizeGoldQuote(data, now = Date.now()) {
  const latest = nullableNumber(data?.f43, { minimum: Number.MIN_VALUE });
  const previous = nullableNumber(data?.f60, { minimum: Number.MIN_VALUE });
  const price = latest ?? previous;
  if (price == null) return null;
  const seconds = nullableNumber(data?.f124, { minimum: 1, maximum: 8.64e12 });
  const observedAt = latest != null && seconds != null ? new Date(seconds * 1000).toISOString() : null;
  // f57 is an instrument code, never a closing price. A previous-close fallback
  // has neither a current timestamp nor a meaningful current-session return.
  const changePct = latest == null ? null : nullableNumber(data?.f170)
    ?? (previous == null ? null : (latest - previous) / previous * 100);
  return { name: '黄金9999', price, changePct, observedAt,
    status: latest == null ? 'stale' : indexQuoteStatus(observedAt, now), cached: false };
}
