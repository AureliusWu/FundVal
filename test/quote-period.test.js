import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeEstimateRow } from '../js/eastmoney-estimate.js';
import { calculateHolding, resolveQuoteBaseNav } from '../js/calculator.js';
import { createQuoteEnvelope, nextWeekdayDate } from '../js/runtime/quote-contract.js';
import { normalizeOfficialNavQuote, normalizeCachedQuote, normalizeHoldingLookthroughQuote, selectPreferredQuote } from '../js/runtime/quote-normalizer.js';
import { applyHoldingsEstimate, calculateHoldingsEstimate, latestOfficialNavBase } from '../js/holdings-estimate.js';
import { calculateOverseasEstimate, validateOverseasEstimatePeriod } from '../js/overseas-model.js';

const NOW = Date.parse('2026-09-07T14:00:00+08:00');
const official = (date, nav, previous, previousDate) => normalizeOfficialNavQuote({
  date, nav, prevNav: previous, prevDate: previousDate, change: (nav / previous - 1) * 100,
}, { now: NOW });

test('newer date-only official NAV wins regardless of candidate order and old proxy source name', () => {
  const older = normalizeEstimateRow({
    code: '000001', kind: 'official_nav', source: 'eastmoney_official_nav',
    value_nav: 1, value_change: -2, value_date: '2026-09-03', source_time: '2026-09-03',
    base_nav: 1.02, base_nav_date: '2026-09-02',
  }, { now: NOW }).source_quote;
  const newer = official('2026-09-04', 1.05, 1, '2026-09-03');
  for (const candidates of [[older, newer], [newer, older]]) {
    const quote = selectPreferredQuote(candidates);
    assert.equal(quote.value, 1.05);
    assert.equal(quote.targetDate, '2026-09-04');
    assert.equal(resolveQuoteBaseNav({ last_nav: 99, latest_nav_move: { prevNav: 100 } }, quote), 1);
    assert.ok(Math.abs(calculateHolding(100, 1, quote.value, quote.baseNav).todayProfit - 5) < 1e-10);
  }
});

test('same-date official enrichment supplies missing change and baseline instead of losing to lexical source order', () => {
  const incomplete = createQuoteEnvelope({
    valueKind: 'official_nav', value: 1.05, targetDate: '2026-09-04', officialNavDate: '2026-09-04',
    observedAt: '2026-09-04', status: 'official', sourceId: 'a-proxy', sourceTier: 'secondary',
  }, { now: NOW });
  const enriched = official('2026-09-04', 1.05, 1, '2026-09-03');
  assert.equal(selectPreferredQuote([incomplete, enriched]), enriched);
});

test('structured Worker value fields including zero are mapped together with the previous NAV date', () => {
  for (const change of [0, -3.34]) {
    const normalized = normalizeEstimateRow({
      code: '000001', kind: 'official_nav', status: 'latest_official',
      value_nav: 3.1234, value_change: change, value_date: '2026-09-04',
      base_nav: 3.2313, base_nav_date: '2026-09-03', nav_date: '2026-09-04',
      est_nav: null, est_change: null, estimate_change: null, source_time: '2026-09-04',
    }, { now: NOW });
    assert.equal(normalized.est_change, change);
    assert.equal(normalized.source_quote.changePct, change);
    assert.equal(normalized.source_quote.baseNav, 3.2313);
    assert.equal(normalized.source_quote.baseNavDate, '2026-09-03');
    assert.equal(normalized.nav_date, '2026-09-03');
    assert.equal(normalized.source_quote.targetDate, '2026-09-04');
  }
});

test('future official dates never outrank a valid published NAV, and invalid calendar dates are rejected', () => {
  const valid = official('2026-09-04', 1, 0.9, '2026-09-03');
  const future = official('2026-09-08', 2, 1, '2026-09-07');
  assert.equal(future.status, 'stale');
  assert.equal(selectPreferredQuote([future, valid]), valid);
  assert.equal(official('2026-02-30', 2, 1, '2026-02-27').officialNavDate, null);
  assert.equal(nextWeekdayDate('2026-09-04'), '2026-09-07');
});

test('legacy cached models without a bound period remain stale despite a new outer TTL', () => {
  const cached = normalizeCachedQuote({
    valueKind: 'model_estimate', value: 1.02, changePct: 2, observedAt: '2026-09-07 13:59:00',
    status: 'model', sourceId: 'market-model', sourceTier: 'model',
  }, { fresh: true, now: NOW });
  assert.equal(cached.status, 'stale');
  assert.ok(cached.reasonCodes.includes('MODEL_PERIOD_UNBOUND'));
  assert.equal(resolveQuoteBaseNav({ last_nav: 1 }, cached), null);
});

test('local holdings estimates reject same-session double counting and multi-session NAV gaps', () => {
  const estimate = { available: true, change: 2, sourceTime: '2026-09-07 13:59:00', coverage: 75, quoteCount: 10 };
  for (const date of ['2026-09-07', '2026-09-03', '']) {
    const fund = { latest_nav_move: { nav: 1, date }, est_realtime: false };
    applyHoldingsEstimate(fund, estimate);
    assert.equal(fund.est_holdings_model, undefined);
  }
  const fund = { latest_nav_move: { nav: 1, date: '2026-09-04' }, est_realtime: false };
  applyHoldingsEstimate(fund, estimate);
  const quote = normalizeHoldingLookthroughQuote(fund, { now: NOW });
  assert.equal(quote.status, 'model');
  assert.equal(quote.baseNav, 1);
  assert.equal(quote.baseNavDate, '2026-09-04');
  assert.equal(quote.targetDate, '2026-09-07');
  assert.equal(quote.coverage, 75);
});

test('newer primary official NAV prevents stale detail enrichment from becoming a false model baseline', () => {
  const fund = {
    latest_nav_move: { nav: 1, date: '2026-09-04' },
    source_quote: official('2026-09-07', 1.02, 1, '2026-09-04'),
    est_realtime: false,
  };
  applyHoldingsEstimate(fund, { available: true, change: 2, sourceTime: '2026-09-07 13:59:00', coverage: 75, quoteCount: 10 });
  assert.equal(fund.est_holdings_model, undefined);
});

test('missing holdings moves and future intraday ticks do not count as flat stocks', () => {
  for (const change of [null, undefined, '', ' ', true]) {
    const result = calculateHoldingsEstimate(Array.from({ length: 10 }, () => ({ ratio: 8, change, quoteTime: '2026-09-07 13:59:00' })), { now: NOW });
    assert.equal(result.available, false);
    assert.equal(result.quoteCount, 0);
  }
  const future = calculateHoldingsEstimate(Array.from({ length: 10 }, () => ({ ratio: 8, change: 1, quoteTime: '2026-09-07 14:00:01' })), { now: NOW });
  assert.equal(future.quoteCount, 0);
  const zero = calculateHoldingsEstimate(Array.from({ length: 10 }, () => ({ ratio: 8, change: 0, quoteTime: '2026-09-07 13:59:00' })), { now: NOW });
  assert.equal(zero.available, true);
  assert.equal(zero.change, 0);
});

test('overseas next-NAV guard uses the US exchange date, not China overnight date', () => {
  const model = { legs: [{ code: 'usQQQ', weight: 100 }], min_weight: 100 };
  const quotes = { usQQQ: { change: 1, time: '2026-09-08 04:00:00' } };
  const now = Date.parse('2026-09-08T09:00:00+08:00');
  assert.deepEqual(validateOverseasEstimatePeriod(model, quotes, '2026-09-04', { now }), { valid: true, targetDate: '2026-09-07', reason: '' });
  assert.equal(validateOverseasEstimatePeriod(model, quotes, '2026-09-07', { now }).valid, false, 'Sep 7 NAV already includes the Sep 7 US return');
  assert.equal(validateOverseasEstimatePeriod(model, quotes, '2026-09-03', { now }).valid, false, 'one daily return cannot bridge two sessions');
});

test('mixed-market session dates and unidentifiable market codes fail closed', () => {
  const now = Date.parse('2026-09-08T14:00:00+08:00');
  const quotes = { usQQQ: { change: 1, time: '2026-09-08 04:00:00' }, kr000660: { change: 2, time: '2026-09-08 13:59:00' } };
  const model = { min_weight: 50, legs: [{ code: 'usQQQ', weight: 50 }, { code: 'kr000660', weight: 50 }] };
  assert.equal(validateOverseasEstimatePeriod(model, quotes, '2026-09-04', { now }).valid, false);
  assert.equal(validateOverseasEstimatePeriod({ min_weight: 100, legs: [{ code: '000660', weight: 100 }] }, {
    '000660': { change: 1, time: '2026-09-08 13:59:00' },
  }, '2026-09-07', { now }).valid, false);
});

test('app overseas model binds to the newest official candidate and never double counts its session', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function applyOverseasModelEstimate('), source.indexOf('// ── 排序'));
  assert.ok(body.startsWith('function applyOverseasModelEstimate('));
  const now = Date.parse('2026-09-08T09:00:00+08:00');
  const model = { legs: [{ code: 'usQQQ', weight: 100 }], min_weight: 100 };
  const apply = new Function('chooseOverseasModel', 'calculateOverseasEstimate', 'validateOverseasEstimatePeriod',
    'latestOfficialNavBase', 'isUsableNav', 'fmt', `${body}\nreturn applyOverseasModelEstimate;`)(
    () => model, (m, q) => calculateOverseasEstimate(m, q, now),
    (m, q, date) => validateOverseasEstimatePeriod(m, q, date, { now }), latestOfficialNavBase,
    value => Number.isFinite(value) && value > 0, value => String(value),
  );
  const quotes = { usQQQ: { changePct: 1, sourceTime: '2026-09-08 04:00:00' } };
  const makeFund = (sourceDate, detailDate) => ({
    est_realtime: false, latest_nav_move: { nav: 1, date: detailDate, change: 2 },
    source_quote: { valueKind: 'official_nav', value: 2, officialNavDate: sourceDate },
  });
  const alreadyPublished = makeFund('2026-09-07', '2026-09-04');
  apply(alreadyPublished, quotes);
  assert.equal(alreadyPublished.est_model, undefined, 'Sep 7 source NAV already contains the return');
  const sourceWins = makeFund('2026-09-04', '2026-09-03');
  apply(sourceWins, quotes);
  assert.equal(sourceWins.est_model_base_nav, 2);
  assert.equal(sourceWins.est_model_base_date, '2026-09-04');
  assert.equal(sourceWins.est_model_target_date, '2026-09-07');
  assert.equal(sourceWins.est_nav, 2.02);
  const detailWins = makeFund('2026-09-03', '2026-09-04');
  apply(detailWins, quotes);
  assert.equal(detailWins.est_model_base_nav, 1);
  assert.equal(detailWins.est_nav, 1.01);
  const gap = makeFund('2026-09-03', '2026-09-02');
  apply(gap, quotes);
  assert.equal(gap.est_model, undefined, 'one return cannot bridge missing NAV sessions');
});
