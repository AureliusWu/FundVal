import test from 'node:test';
import assert from 'node:assert/strict';
import { createValuationPeriod } from '../js/runtime/valuation-period.js';
import { marketClock } from '../js/runtime/market-clock.js';

const NOW = Date.parse('2026-09-30T05:24:00Z');
const QUOTE = Object.freeze({
  valueKind: 'intraday_estimate', value: 3.25, baseNav: 3.2,
  baseNavDate: '2026-09-29', targetDate: '2026-09-30',
  sourceId: 'sinan-estimate-proxy', sourceTier: 'primary', status: 'realtime',
  observedAt: '2026-09-30 13:24:00', fetchedAt: '2026-09-30T05:24:00Z',
  reasonCodes: [],
});

function period(overrides = {}, options = {}) {
  return createValuationPeriod({ ...QUOTE, ...overrides }, { shares: 100, now: NOW, ...options });
}

function near(actual, expected) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`);
}

test('v16 period binds the exact market interval and exposes a stable presentation contract', () => {
  const result = period();
  assert.deepEqual(Object.keys(result).sort(), [
    'baseDate', 'targetDate', 'periodKind', 'isTodayInChina', 'isTodayEstimate',
    'profitAmount', 'displayLabel', 'sourceStatus', 'reasonCodes', 'comparisonKey',
  ].sort());
  assert.equal(result.baseDate, '2026-09-29');
  assert.equal(result.targetDate, '2026-09-30');
  assert.equal(result.periodKind, 'intraday');
  assert.equal(result.isTodayInChina, true);
  assert.equal(result.isTodayEstimate, true);
  near(result.profitAmount, 5);
  assert.equal(result.displayLabel, '今日估算');
  assert.equal(result.sourceStatus, 'live');
  assert.equal(result.comparisonKey, 'intraday:2026-09-29:2026-09-30');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.reasonCodes));
});

test('v16 005844 latest published NAV is never relabeled as today by a new request', () => {
  const result = period({
    valueKind: 'official_nav', value: 3.2259, baseNav: 3.2037,
    baseNavDate: '2026-09-28', targetDate: '2026-09-29', status: 'official',
    sourceId: 'eastmoney-official-nav', sourceTier: 'secondary',
    observedAt: '2026-09-30 13:24:00',
  });
  assert.equal(result.periodKind, 'latest_official');
  assert.equal(result.isTodayInChina, false);
  assert.equal(result.isTodayEstimate, false);
  assert.equal(result.displayLabel, '最新正式净值变动');
  assert.equal(result.sourceStatus, 'official');
  near(result.profitAmount, 2.22);
});

test('v16 012920 QDII multi-day published NAV preserves its own interval', () => {
  const result = period({
    market: 'qdii', valueKind: 'official_nav', value: 3.7218, baseNav: 3.8463,
    baseNavDate: '2026-09-24', targetDate: '2026-09-28', status: 'official',
    sourceId: 'eastmoney-official-nav', sourceTier: 'secondary',
  });
  assert.equal(result.baseDate, '2026-09-24');
  assert.equal(result.targetDate, '2026-09-28');
  assert.equal(result.isTodayEstimate, false);
  assert.equal(result.displayLabel, '最新正式净值变动');
  near(result.profitAmount, -12.45);
});

test('v16 even a published official NAV dated today is not an intraday estimate', () => {
  const result = period({ valueKind: 'official_nav', status: 'official', sourceTier: 'secondary' });
  assert.equal(result.isTodayInChina, true);
  assert.equal(result.isTodayEstimate, false);
  assert.equal(result.periodKind, 'latest_official');
  assert.equal(result.displayLabel, '最新正式净值变动');
});

test('v16 China midnight, month/year boundaries, and host timezone do not change target dates', () => {
  for (const [now, base, target, today] of [
    ['2026-09-30T15:59:59.999Z', '2026-09-29', '2026-09-30', true],
    ['2026-09-30T16:00:00.000Z', '2026-09-29', '2026-09-30', false],
    ['2026-12-31T16:00:00.000Z', '2026-12-31', '2027-01-01', true],
    ['2027-02-28T16:00:00.000Z', '2027-02-26', '2027-03-01', true],
  ]) {
    const result = period({ baseNavDate: base, targetDate: target }, { now: Date.parse(now) });
    assert.equal(result.targetDate, target);
    assert.equal(result.isTodayInChina, today);
  }
});

test('v16 missing bound dates are not inferred from observedAt, fetchedAt or officialNavDate', () => {
  for (const overrides of [
    { targetDate: null, officialNavDate: '2026-09-30' },
    { targetDate: undefined },
    { baseNavDate: null },
  ]) {
    const result = period(overrides);
    assert.equal(result.profitAmount, null);
    assert.equal(result.isTodayEstimate, false);
    assert.equal(result.comparisonKey, null);
    assert.ok(result.reasonCodes.includes('PERIOD_UNBOUND'));
  }
  assert.equal(period({ targetDate: null }).targetDate, null);
});

test('v16 official single-point fallback stays explainable but has no manufactured profit', () => {
  const result = period({ valueKind: 'official_nav', status: 'official', baseNav: null, baseNavDate: null });
  assert.equal(result.periodKind, 'latest_official');
  assert.equal(result.displayLabel, '最新正式净值变动');
  assert.equal(result.profitAmount, null);
  assert.equal(result.comparisonKey, null);
  assert.equal(result.isTodayEstimate, false);
});

test('v16 Friday to Monday may be one conservative session but accumulated model gaps cannot be today', () => {
  const monday = Date.parse('2026-09-28T05:00:00Z');
  const single = period({
    valueKind: 'model_estimate', status: 'model', sourceTier: 'model',
    baseNavDate: '2026-09-25', targetDate: '2026-09-28',
  }, { now: monday });
  assert.equal(single.isTodayEstimate, true);
  assert.equal(single.sourceStatus, 'modeled');
  const multi = period({
    valueKind: 'model_estimate', status: 'model', sourceTier: 'model',
    baseNavDate: '2026-09-24', targetDate: '2026-09-28',
  }, { now: monday });
  assert.equal(multi.isTodayInChina, true);
  assert.equal(multi.isTodayEstimate, false);
  assert.equal(multi.periodKind, 'historical');
  assert.equal(multi.displayLabel, '历史区间变动');
  assert.ok(multi.reasonCodes.includes('PERIOD_NOT_SINGLE_SESSION'));
});

test('v16 a known mainland exchange holiday cannot be labeled as a today estimate', () => {
  const now = Date.parse('2026-10-01T05:24:00Z');
  const result = period({ market: 'cn', baseNavDate: '2026-09-30', targetDate: '2026-10-01' }, { now });
  assert.equal(result.isTodayInChina, true);
  assert.equal(result.isTodayEstimate, false);
  assert.equal(result.periodKind, 'historical');
  assert.equal(result.displayLabel, '历史区间变动');
  assert.ok(result.reasonCodes.includes('PERIOD_NOT_SINGLE_SESSION'));
  // The period layer must not infer cn from an absent/unknown market.
  const unknown = period({ baseNavDate: '2026-09-30', targetDate: '2026-10-01' }, { now });
  assert.equal(unknown.isTodayEstimate, true);
});

test('v16 an expired calendar is unverified, while an explicitly bound period does not invent trading-day proof', () => {
  const now = Date.parse('2027-01-04T05:24:00Z');
  const calendar = marketClock('cn', now);
  assert.equal(calendar.calendarStatus, 'unverified');
  assert.equal(calendar.calendarVersion, null);
  assert.equal(calendar.isTradingDay, null);
  const result = period({ market: 'cn', baseNavDate: '2027-01-01', targetDate: '2027-01-04' }, { now });
  assert.equal(result.isTodayInChina, true);
  assert.equal(result.isTodayEstimate, false);
  assert.equal(result.targetDate, '2027-01-04');
  assert.equal(Object.hasOwn(result, 'calendarStatus'), false);
});

test('v16 old intraday cache is recomputed at display time instead of preserving old today state', () => {
  const quote = { ...QUOTE, sourceTier: 'cache' };
  const original = createValuationPeriod(quote, { shares: 100, now: NOW, cacheState: 'fresh' });
  const later = createValuationPeriod(quote, {
    shares: 200, now: Date.parse('2026-10-01T01:30:00Z'), cacheState: 'stale',
  });
  assert.equal(original.isTodayEstimate, true);
  assert.equal(original.sourceStatus, 'cached_fresh');
  assert.equal(later.isTodayInChina, false);
  assert.equal(later.isTodayEstimate, false);
  assert.equal(later.periodKind, 'stale');
  assert.equal(later.displayLabel, '旧区间变动');
  assert.equal(later.sourceStatus, 'cached_stale');
  near(later.profitAmount, 10);
});

test('v16 stale and expired official caches never regain ordinary official identity', () => {
  for (const cacheState of ['stale', 'expired']) {
    const result = period({ valueKind: 'official_nav', status: 'official', sourceTier: 'cache' }, { cacheState });
    assert.equal(result.periodKind, 'stale');
    assert.equal(result.sourceStatus, 'cached_stale');
    assert.equal(result.displayLabel, '旧区间变动');
    assert.equal(result.isTodayEstimate, false);
    near(result.profitAmount, 5);
  }
  const staleSource = period({ status: 'stale' });
  assert.equal(staleSource.periodKind, 'stale');
  assert.equal(staleSource.isTodayEstimate, false);
});

test('v16 future, nonexistent and reversed intervals are unavailable rather than trusted dates', () => {
  for (const overrides of [
    { targetDate: '2026-10-01' },
    { baseNavDate: '2026-10-01', targetDate: '2026-10-02' },
    { targetDate: '2026-02-30' },
    { baseNavDate: '2026-02-30' },
    { baseNavDate: '2026-09-30', targetDate: '2026-09-30' },
    { baseNavDate: '2026-09-30', targetDate: '2026-09-29' },
  ]) {
    const result = period(overrides);
    assert.equal(result.profitAmount, null);
    assert.equal(result.isTodayEstimate, false);
    assert.equal(result.comparisonKey, null);
    assert.equal(result.periodKind, 'unavailable');
  }
});

test('v16 true zero profit is distinct from unknown values, invalid shares and overflow', () => {
  assert.equal(period({ value: 3.2 }).profitAmount, 0);
  for (const value of [null, undefined, NaN, Infinity, 0, false]) {
    assert.equal(period({ value }).profitAmount, null);
  }
  for (const baseNav of [null, undefined, NaN, Infinity, 0, -1, false]) {
    assert.equal(period({ baseNav }).profitAmount, null);
  }
  for (const shares of [null, undefined, NaN, Infinity, 0, -1, false, '100']) {
    assert.equal(period({}, { shares }).profitAmount, null);
  }
  assert.equal(period({ value: 1e308, baseNav: 1 }, { shares: 1e308 }).profitAmount, null);
});

test('v16 unknown quote enums and unknown cache state fail closed without a live label', () => {
  for (const overrides of [
    { valueKind: 'guessed_nav' }, { status: 'success' }, { status: 'unavailable' },
    { sourceTier: 'mystery' },
  ]) {
    const result = period(overrides);
    assert.equal(result.profitAmount, null);
    assert.equal(result.isTodayEstimate, false);
    assert.equal(result.periodKind, 'unavailable');
  }
  assert.equal(period({}, { cacheState: 'newest' }).periodKind, 'unavailable');
  assert.equal(period({ sourceTier: 'cache' }).periodKind, 'unavailable');
  assert.equal(period({}, { now: NaN }).periodKind, 'unavailable');
});

test('v16 an unheld fund still has an explainable market period but no fabricated holding profit', () => {
  const result = period({}, { shares: null });
  assert.equal(result.periodKind, 'intraday');
  assert.equal(result.isTodayEstimate, true);
  assert.equal(result.profitAmount, null);
});

test('v16 period validation reasons remain present even when upstream reasons fill their bound', () => {
  const result = period({ targetDate: null, reasonCodes: Array.from({ length: 30 }, (_, index) => `UPSTREAM_${index}`) });
  assert.ok(result.reasonCodes.includes('PERIOD_UNBOUND'));
  assert.ok(result.reasonCodes.length <= 20);
});

test('v16 incomparable official, historical and stale periods have distinct sort groups', () => {
  const today = period();
  const official = period({ valueKind: 'official_nav', status: 'official' });
  const older = period({ baseNavDate: '2026-09-28', targetDate: '2026-09-29' });
  const stale = period({ status: 'stale' });
  assert.equal(older.comparisonKey, 'historical:2026-09-28:2026-09-29');
  assert.equal(new Set([today, official, older, stale].map(item => item.comparisonKey)).size, 4);
});
