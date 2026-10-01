import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHoldingsEstimate, latestOfficialNavBase } from '../js/holdings-estimate.js';
import { normalizeEstimateRow } from '../js/eastmoney-estimate.js';
import { createQuoteEnvelope } from '../js/runtime/quote-contract.js';
import {
  buildFundQuoteCandidates, normalizeCachedQuote, normalizeEstimateQuote,
  normalizeOfficialNavQuote, selectPreferredQuote,
} from '../js/runtime/quote-normalizer.js';
import { evaluateNotificationEligibility } from '../js/runtime/notification-policy.js';
import { marketClock } from '../js/runtime/market-clock.js';
import { createValuationPeriod } from '../js/runtime/valuation-period.js';
import { parseWorkerEnvelope } from '../js/runtime/worker-contract.js';
import {
  WORKER_FIXTURE_NOW as NOW, intradayRow, officialRow, qdiiRow, estimatesV2,
} from './fixtures/worker-contract-v16.js';

// Fixed-date synthetic data only. These tests perform no requests or writes.
const FETCHED = '2026-09-30T05:59:30.000Z';
const liveQuote = overrides => ({
  fundCode: '000002', fundName: 'Synthetic fund', market: 'cn', assetKind: 'fund',
  valueKind: 'intraday_estimate', value: 1.01, changePct: 1,
  baseNav: 1, baseNavDate: '2026-09-29', targetDate: '2026-09-30',
  sourceId: 'sinan-estimate-proxy', sourceTier: 'primary', status: 'realtime',
  observedAt: '2026-09-30T13:59:00+08:00', fetchedAt: FETCHED,
  reasonCodes: [], ...overrides,
});
const holdingsEstimate = () => ({
  available: true, change: 1, coverage: 60, quoteCount: 6,
  sourceTime: '2026-09-30 13:59:00', reportDate: '2026-06-30',
});

function nearly(actual, expected) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`);
}

test('v16 integration: stale provenance cannot be bypassed by raw NAV aliases in model composition', () => {
  const stale = { status: 'stale', sourceTier: 'cache', cacheState: 'stale' };
  const provenance = [
    { source_quote: { ...stale, valueKind: 'official_nav', value: 9, officialNavDate: '2026-09-29' } },
    { latest_nav_move: { ...stale, nav: 9, date: '2026-09-29' } },
    { source_quote: liveQuote({ ...stale, baseNav: 9 }) },
  ];
  for (const source of provenance) {
    const fund = {
      code: '000002', last_nav: 9, nav_date: '2026-09-29',
      est_kind: 'official_nav', est_nav: 9, value_date: '2026-09-29',
      est_time: '2026-09-29', ...source,
    };
    assert.equal(latestOfficialNavBase(fund), undefined);
    const before = structuredClone(fund);
    assert.equal(applyHoldingsEstimate(fund, holdingsEstimate()), fund);
    assert.deepEqual(fund, before, 'a stale source must not produce a newly modeled NAV');
  }
});

test('v16 integration: a valid quote base wins over bare NAV aliases and stale secondary enrichment', () => {
  const fund = {
    code: '000002', last_nav: 9, nav_date: '2026-09-29',
    source_quote: liveQuote({ status: 'delayed' }),
    latest_nav_move: { nav: 9, date: '2026-09-29', sourceTier: 'cache', cacheState: 'expired' },
  };
  assert.deepEqual(latestOfficialNavBase(fund), { nav: 1, date: '2026-09-29' });
  applyHoldingsEstimate(fund, holdingsEstimate());
  assert.equal(fund.est_holdings_model, true);
  assert.equal(fund.est_holdings_base_nav, 1);
  assert.equal(fund.est_holdings_base_date, '2026-09-29');
  nearly(fund.est_nav, 1.01);
});

test('v16 integration: direct cached realtime input without cache metadata fails closed across consumers', () => {
  const input = liveQuote({ sourceTier: 'cache', fetchedAt: null });
  const [quote] = buildFundQuoteCandidates({ source_quote: input }, { now: NOW });
  assert.equal(quote.sourceTier, 'cache');
  assert.equal(quote.sourceId, 'local-cache');
  assert.equal(quote.status, 'stale');
  assert.equal(quote.cacheState, null);
  assert.equal(quote.fetchedAt, null, 'an unknown acquisition time cannot become the current request time');
  assert.ok(quote.reasonCodes.includes('CACHE_METADATA_MISSING'));
  const period = createValuationPeriod(quote, { shares: 100, now: NOW });
  assert.equal(period.isTodayEstimate, false);
  assert.equal(period.periodKind, 'unavailable');
  assert.equal(period.profitAmount, null);
  assert.equal(evaluateNotificationEligibility(quote, { now: NOW }).eligible, false);
});

test('v16 integration: a cached raw estimate row cannot regain a primary realtime identity', () => {
  const input = intradayRow({
    source: 'sinan-estimate-proxy', sourceTier: 'cache', status: 'realtime',
    fetched_at: null, fetchedAt: null, originalSource: 'sinan-estimate-proxy',
    originalSourceTier: 'primary',
  });
  const quote = normalizeEstimateQuote(input, { now: NOW });
  assert.equal(quote.sourceTier, 'cache');
  assert.equal(quote.sourceId, 'local-cache');
  assert.equal(quote.status, 'stale');
  assert.equal(quote.fetchedAt, null);
  assert.equal(createValuationPeriod(quote, { shares: 100, now: NOW }).isTodayEstimate, false);
  assert.equal(evaluateNotificationEligibility(quote, { now: NOW }).eligible, false);
});

test('v16 integration: a fresh cache may retain its period but is never realtime or notification eligible', () => {
  const input = liveQuote({
    sourceTier: 'cache', cacheState: 'fresh', originalSource: 'sinan-estimate-proxy',
    originalSourceTier: 'primary', cachedAt: Date.parse(FETCHED), expiresAt: NOW + 60000,
  });
  const [quote] = buildFundQuoteCandidates({ source_quote: input }, { now: NOW });
  assert.equal(quote.status, 'delayed');
  assert.equal(quote.sourceTier, 'cache');
  assert.equal(quote.originalSource, 'sinan-estimate-proxy');
  assert.equal(quote.fetchedAt, FETCHED);
  const period = createValuationPeriod(quote, { shares: 100, now: NOW });
  assert.equal(period.isTodayEstimate, true);
  assert.equal(period.sourceStatus, 'cached_fresh');
  nearly(period.profitAmount, 1);
  assert.equal(evaluateNotificationEligibility(quote, { now: NOW }).eligible, false);
});

test('v16 integration: identical NAV values cannot deduplicate away a fresh source recovery', () => {
  const move = { nav: 1.01, prevNav: 1, date: '2026-09-29', prevDate: '2026-09-28', change: 1 };
  for (const cached of [false, true]) {
    const freshMove = cached ? {
      ...move, sourceTier: 'cache', cacheState: 'fresh', originalSource: 'eastmoney-official-nav',
      originalSourceTier: 'secondary', fetchedAt: FETCHED,
      cachedAt: Date.parse(FETCHED), expiresAt: NOW + 60000,
    } : move;
    const stale = {
      ...normalizeOfficialNavQuote(freshMove, { now: NOW }), status: 'stale',
      ...(cached ? { cacheState: 'stale', expiresAt: NOW - 1 } : {}),
    };
    const candidates = buildFundQuoteCandidates({ source_quote: stale, latest_nav_move: freshMove }, { now: NOW });
    const selected = selectPreferredQuote(candidates, {}, { now: NOW });
    assert.equal(selected.status, 'official', `fresh recovery must win, cached=${cached}`);
    assert.equal(selected.value, 1.01);
    assert.equal(selected.baseNav, 1);
    assert.equal(selected.targetDate, '2026-09-29');
    if (cached) assert.equal(selected.cacheState, 'fresh');
  }
});

test('v16 integration: an explicit expired cache timestamp cannot be overridden by a fresh flag', () => {
  const quote = normalizeCachedQuote(liveQuote(), {
    fresh: true, now: NOW, cachedAt: Date.parse(FETCHED), expiresAt: NOW - 1,
  });
  assert.equal(quote.status, 'stale');
  assert.equal(quote.cacheState, 'stale');
  assert.equal(quote.expiresAt, NOW - 1);
  assert.equal(quote.fetchedAt, FETCHED, 'expiry must not renew the acquisition time');
  const period = createValuationPeriod(quote, { shares: 100, now: NOW });
  assert.equal(period.sourceStatus, 'cached_stale');
  assert.equal(period.isTodayEstimate, false);
});

test('v16 integration: a held cache snapshot becomes stale at render time after its own expiry', () => {
  const quote = normalizeCachedQuote(liveQuote(), {
    fresh: true, now: NOW, cachedAt: Date.parse(FETCHED), expiresAt: NOW + 60000,
  });
  const snapshot = structuredClone(quote);
  const initially = createValuationPeriod(quote, { shares: 100, now: NOW });
  assert.equal(initially.sourceStatus, 'cached_fresh');
  assert.equal(initially.isTodayEstimate, true);
  const later = createValuationPeriod(quote, { shares: 100, now: NOW + 15 * 60000 });
  assert.equal(later.sourceStatus, 'cached_stale');
  assert.equal(later.periodKind, 'stale');
  assert.equal(later.isTodayEstimate, false);
  assert.equal(later.displayLabel, '旧区间变动');
  nearly(later.profitAmount, 1);
  assert.deepEqual(quote, snapshot, 'display-time expiry must not mutate or renew the retained quote');
});

test('v16 integration: an expired China exchange calendar cannot authorize a daily notification', () => {
  const now = Date.parse('2027-01-06T06:00:00Z');
  const quote = liveQuote({
    market: 'cn', status: 'delayed', baseNavDate: '2027-01-05', targetDate: '2027-01-06',
    observedAt: '2027-01-06T13:59:00+08:00', fetchedAt: '2027-01-06T05:59:30.000Z',
  });
  const clock = marketClock('cn', now);
  assert.equal(clock.calendarStatus, 'unverified');
  assert.equal(clock.isTradingDay, null);
  assert.equal(clock.marketState, 'unknown');
  assert.equal(evaluateNotificationEligibility(quote, { now }).eligible, false);
});

test('v16 integration: canonical null values cannot be restored from deprecated numeric aliases', () => {
  const quote = normalizeEstimateQuote({
    code: '000002', name: 'Synthetic fund', kind: 'intraday_estimate',
    source: 'sinan-estimate-proxy', value_nav: null, est_nav: 9,
    estimate_change: null, value_change: 9, est_change: 99,
    base_nav: 1, base_nav_date: '2026-09-29', value_date: '2026-09-30',
    source_time: '2026-09-30T13:59:00+08:00', fetched_at: FETCHED, est_realtime: true,
  }, { now: NOW });
  assert.equal(quote.value, null);
  assert.equal(quote.changePct, null);
  assert.equal(quote.status, 'unavailable');
  assert.equal(createValuationPeriod(quote, { shares: 100, now: NOW }).profitAmount, null);
  assert.equal(evaluateNotificationEligibility(quote, { now: NOW }).eligible, false);
});

test('v16 integration: canonical null period dates cannot be inferred from aliases or observation time', () => {
  const quote = normalizeEstimateQuote({
    code: '000002', name: 'Synthetic fund', kind: 'intraday_estimate',
    source: 'sinan-estimate-proxy', value_nav: 1.01, estimate_change: 1,
    base_nav: 1, base_nav_date: null, baseNavDate: '2026-09-29', nav_date: '2026-09-29',
    value_date: null, targetDate: '2026-09-30', target_nav_date: '2026-09-30',
    source_time: '2026-09-30T13:59:00+08:00', fetched_at: FETCHED, est_realtime: true,
  }, { now: NOW });
  assert.equal(quote.baseNavDate, null);
  assert.equal(quote.targetDate, null);
  const period = createValuationPeriod(quote, { shares: 100, now: NOW });
  assert.equal(period.isTodayEstimate, false);
  assert.equal(period.profitAmount, null);
  assert.equal(period.comparisonKey, null);
  assert.ok(period.reasonCodes.includes('PERIOD_UNBOUND'));
  assert.equal(evaluateNotificationEligibility(quote, { now: NOW }).eligible, false);
});

test('v16 integration: an older official NAV date cannot hide a future target or base date', () => {
  for (const overrides of [{ targetDate: '2026-10-01' }, { baseNavDate: '2026-10-01' }]) {
    const quote = createQuoteEnvelope(liveQuote({ officialNavDate: '2026-09-29', ...overrides }), { now: NOW });
    assert.equal(quote.status, 'stale');
    assert.ok(quote.reasonCodes.includes('SOURCE_DATE_IN_FUTURE'));
    const period = createValuationPeriod(quote, { shares: 100, now: NOW });
    assert.equal(period.periodKind, 'unavailable');
    assert.equal(period.isTodayEstimate, false);
    assert.equal(period.profitAmount, null);
    assert.equal(evaluateNotificationEligibility(quote, { now: NOW }).eligible, false);
  }
});

test('v16 integration: Worker parse and client normalization preserve the distinct estimate change including zero', () => {
  for (const change of [1, 0]) {
    const value = 1 + change / 100;
    const input = estimatesV2([intradayRow({
      value_nav: value, estimate_nav: value, est_nav: value,
      value_change: null, estimate_change: change, est_change: change,
    })]);
    const envelope = parseWorkerEnvelope(input, { endpoint: 'estimates', requestedCodes: ['000002'], now: NOW });
    const row = normalizeEstimateRow(envelope.items[0], {
      wireVersion: envelope.wireVersion, fetchedAt: envelope.fetchedAt, now: NOW,
    });
    assert.equal(row.status, 'ok');
    assert.equal(row.value_change, null);
    assert.equal(row.source_quote.changePct, change);
    assert.equal(row.source_quote.value, value);
    const [quote] = buildFundQuoteCandidates(row, { now: NOW });
    const period = createValuationPeriod(quote, { shares: 100, now: NOW });
    assert.equal(period.isTodayEstimate, true);
    nearly(period.profitAmount, change);
  }
});

test('v16 integration: stale Worker quality survives successful transport and cannot supply a model base', () => {
  const input = estimatesV2([officialRow({ status: 'stale' })], { status: 'degraded' });
  const envelope = parseWorkerEnvelope(input, { endpoint: 'estimates', requestedCodes: ['000001'], now: NOW });
  const row = normalizeEstimateRow(envelope.items[0], {
    wireVersion: envelope.wireVersion, fetchedAt: envelope.fetchedAt, now: NOW,
  });
  assert.equal(row.status, 'ok', 'successful transport is independent of source quality');
  assert.equal(row.source_status, 'stale');
  assert.equal(row.source_quote.status, 'stale');
  assert.equal(latestOfficialNavBase(row), undefined);
  const before = structuredClone(row);
  applyHoldingsEstimate(row, {
    ...holdingsEstimate(), sourceTime: '2026-09-30 13:59:00',
  });
  assert.deepEqual(row, before);
});

test('v16 integration: QDII canonical kind and model version survive every quote adapter without realtime promotion', () => {
  for (const target of ['2026-09-30', '2026-10-01']) {
    const input = estimatesV2([qdiiRow({ value_date: target, target_nav_date: target })]);
    const envelope = parseWorkerEnvelope(input, { endpoint: 'estimates', requestedCodes: ['000005'], now: NOW });
    const row = normalizeEstimateRow(envelope.items[0], {
      wireVersion: envelope.wireVersion, fetchedAt: envelope.fetchedAt, now: NOW,
    });
    assert.equal(row.kind, 'qdii_next_nav_estimate');
    assert.equal(row.source_time, '2026-09-30T13:59:00+08:00');
    assert.equal(row.source_quote.valueKind, 'model_estimate');
    assert.equal(row.source_quote.modelVersion, 'fixture-qdii-v1');
    assert.equal(row.source_quote.sourceTier, 'model');
    assert.equal(row.source_quote.targetDate, target);
    const [quote] = buildFundQuoteCandidates(row, { now: NOW });
    assert.equal(quote.valueKind, 'model_estimate');
    assert.equal(quote.modelVersion, 'fixture-qdii-v1');
    assert.notEqual(quote.status, 'realtime');
    assert.equal(evaluateNotificationEligibility(quote, { now: NOW }).eligible, false);
    if (target === '2026-10-01') {
      assert.equal(createValuationPeriod(quote, { shares: 100, now: NOW }).isTodayEstimate, false);
    }
  }
});
