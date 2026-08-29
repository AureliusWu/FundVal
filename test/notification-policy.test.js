import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NOTIFICATION_MAX_AGE_MS,
  NOTIFICATION_REJECTION_REASONS,
  evaluateNotificationEligibility,
  isQuoteEligibleForNotification,
} from '../js/runtime/notification-policy.js';

const NOW = Date.parse('2026-08-25T14:30:00+08:00');

function quote(overrides = {}) {
  return {
    status: 'realtime',
    valueKind: 'intraday_estimate',
    changePct: 0,
    observedAt: '2026-08-25 14:29:00',
    fetchedAt: '2026-08-25T06:29:30.000Z',
    ...overrides,
  };
}

function reasonFor(candidate, options = {}) {
  return evaluateNotificationEligibility(candidate, { now: NOW, ...options }).reason;
}

test('accepts same-day realtime and delayed intraday estimates, including a real zero', () => {
  const realtime = evaluateNotificationEligibility(quote(), { now: NOW });
  const delayed = evaluateNotificationEligibility(quote({ status: 'delayed', changePct: -0.25 }), { now: NOW });

  assert.deepEqual(realtime, {
    eligible: true,
    reason: null,
    observedAgeMs: 60_000,
    fetchedAgeMs: 30_000,
    chinaDate: '2026-08-25',
  });
  assert.equal(delayed.eligible, true);
  assert.equal(isQuoteEligibleForNotification(quote(), { now: NOW }), true);
});

test('rejects every non-live status, including an unknown holdings status', () => {
  for (const status of ['official', 'model', 'stale', 'unavailable', 'holdings', null]) {
    assert.equal(
      reasonFor(quote({ status })),
      NOTIFICATION_REJECTION_REASONS.STATUS_NOT_ELIGIBLE,
      `status ${String(status)} must be rejected`,
    );
  }
});

test('rejects official, model, holdings and missing value kinds', () => {
  for (const valueKind of [
    'official_nav',
    'model_estimate',
    'holding_lookthrough_estimate',
    null,
  ]) {
    assert.equal(
      reasonFor(quote({ valueKind })),
      NOTIFICATION_REJECTION_REASONS.VALUE_KIND_NOT_ELIGIBLE,
      `valueKind ${String(valueKind)} must be rejected`,
    );
  }
});

test('requires a finite numeric changePct while preserving zero', () => {
  assert.equal(reasonFor(quote({ changePct: 0 })), null);
  for (const changePct of [null, undefined, NaN, Infinity, -Infinity, '0']) {
    assert.equal(
      reasonFor(quote({ changePct })),
      NOTIFICATION_REJECTION_REASONS.CHANGE_PCT_NOT_FINITE,
      `changePct ${String(changePct)} must be rejected`,
    );
  }
});

test('requires both observedAt and fetchedAt to be parseable timestamps', () => {
  for (const observedAt of [null, '', 'not-a-date', '2026-08-25']) {
    assert.equal(reasonFor(quote({ observedAt })), NOTIFICATION_REJECTION_REASONS.OBSERVED_AT_INVALID);
  }
  for (const fetchedAt of [null, '', 'not-a-date', '2026-08-25']) {
    assert.equal(reasonFor(quote({ fetchedAt })), NOTIFICATION_REJECTION_REASONS.FETCHED_AT_INVALID);
  }
});

test('uses the China calendar day for both timestamps', () => {
  const afterMidnight = Date.parse('2026-08-26T00:02:00+08:00');
  const priorDayObserved = quote({
    observedAt: '2026-08-25T15:59:59.000Z',
    fetchedAt: '2026-08-26T00:01:00+08:00',
  });
  const priorDayFetched = quote({
    observedAt: '2026-08-26T00:01:00+08:00',
    fetchedAt: '2026-08-25T15:59:59.000Z',
  });

  assert.equal(
    evaluateNotificationEligibility(priorDayObserved, { now: afterMidnight }).reason,
    NOTIFICATION_REJECTION_REASONS.OBSERVED_AT_CROSS_DAY,
  );
  assert.equal(
    evaluateNotificationEligibility(priorDayFetched, { now: afterMidnight }).reason,
    NOTIFICATION_REJECTION_REASONS.FETCHED_AT_CROSS_DAY,
  );
});

test('accepts the freshness boundary and rejects either expired timestamp', () => {
  const boundary = new Date(NOW - DEFAULT_NOTIFICATION_MAX_AGE_MS).toISOString();
  const expired = new Date(NOW - DEFAULT_NOTIFICATION_MAX_AGE_MS - 1).toISOString();

  assert.equal(reasonFor(quote({ observedAt: boundary, fetchedAt: boundary })), null);
  assert.equal(
    reasonFor(quote({ observedAt: expired })),
    NOTIFICATION_REJECTION_REASONS.OBSERVED_AT_EXPIRED,
  );
  assert.equal(
    reasonFor(quote({ fetchedAt: expired })),
    NOTIFICATION_REJECTION_REASONS.FETCHED_AT_EXPIRED,
  );
});

test('rejects timestamps beyond allowed future clock skew', () => {
  const future = new Date(NOW + 5 * 60 * 1000 + 1).toISOString();

  assert.equal(
    reasonFor(quote({ observedAt: future })),
    NOTIFICATION_REJECTION_REASONS.OBSERVED_AT_IN_FUTURE,
  );
  assert.equal(
    reasonFor(quote({ fetchedAt: future })),
    NOTIFICATION_REJECTION_REASONS.FETCHED_AT_IN_FUTURE,
  );
});

test('fails closed for invalid inputs and invalid freshness options', () => {
  assert.equal(reasonFor(null), NOTIFICATION_REJECTION_REASONS.INVALID_QUOTE);
  assert.equal(
    evaluateNotificationEligibility(quote(), { now: 'not-a-time' }).reason,
    NOTIFICATION_REJECTION_REASONS.INVALID_NOW,
  );
  assert.equal(
    reasonFor(quote(), { maxAgeMs: -1 }),
    NOTIFICATION_REJECTION_REASONS.INVALID_FRESHNESS_POLICY,
  );
  assert.equal(isQuoteEligibleForNotification(null, { now: NOW }), false);
});
