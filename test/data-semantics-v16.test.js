import test from 'node:test';
import assert from 'node:assert/strict';
import { nullableNumber } from '../js/runtime/quote-contract.js';
import { buildFundQuoteCandidates, normalizeEstimateQuote, normalizeOfficialNavQuote, selectPreferredQuote } from '../js/runtime/quote-normalizer.js';
import { createQuotePresentation } from '../js/runtime/quote-presentation.js';
import { evaluateNotificationEligibility } from '../js/runtime/notification-policy.js';
import { applyHoldingsEstimate, calculateHoldingsEstimate, isCurrentHoldingsReport, latestOfficialNavBase } from '../js/holdings-estimate.js';

const NOW = Date.parse('2026-09-30T14:00:00+08:00');
const FETCHED = '2026-09-30T05:59:00.000Z';
const move = overrides => ({ nav: 3.2259, prevNav: 3.2037, date: '2026-09-29', prevDate: '2026-09-28', change: 0.692947529, ...overrides });
const live = overrides => ({
  fundCode: '005844', market: 'cn', valueKind: 'intraday_estimate',
  status: 'realtime', sourceId: 'sinan-estimate-proxy', sourceTier: 'primary',
  value: 1, baseNav: 1, changePct: 0, baseNavDate: '2026-09-29', targetDate: '2026-09-30',
  observedAt: '2026-09-30 13:59:00', fetchedAt: FETCHED, ...overrides,
});
const stocks = overrides => Array.from({ length: 10 }, (_, index) => ({
  code: String(600000 + index), name: `Synthetic stock ${index}`, market: 'cn',
  ratio: 8, change: 1, quoteTime: '2026-09-30 13:59:00', ...overrides,
}));

test('numeric grammar rejects malformed percentages, grouping and non-decimal coercion', () => {
  for (const input of ['1%2', '1%%', '1,2', ',12', '1,,000', '0x10', '0b10', '1 2', [], [1], {}, true, '', null]) {
    assert.equal(nullableNumber(input), null, `reject ${JSON.stringify(input)}`);
  }
  for (const [input, expected] of [['0%', 0], ['-3.25%', -3.25], ['1,234.50', 1234.5], ['1e-3', 0.001], [0, 0]]) {
    assert.equal(nullableNumber(input), expected);
  }
});

test('an old official NAV fallback retains its cache identity and original fetch timestamp', () => {
  const quote = normalizeOfficialNavQuote(move({
    sourceTier: 'cache', cacheState: 'stale', originalSource: 'eastmoney-official-nav',
    originalSourceTier: 'secondary', fetchedAt: '2026-09-29T10:00:00.000Z',
    cachedAt: Date.parse('2026-09-29T10:00:00.000Z'), expiresAt: Date.parse('2026-09-29T10:10:00.000Z'),
  }), { now: NOW, fetchedAt: FETCHED });
  assert.equal(quote.sourceTier, 'cache');
  assert.equal(quote.status, 'stale');
  assert.equal(quote.cacheState, 'stale');
  assert.equal(quote.originalSource, 'eastmoney-official-nav');
  assert.equal(quote.fetchedAt, '2026-09-29T10:00:00.000Z');
  assert.equal(quote.targetDate, '2026-09-29');
});

test('candidate enrichment cannot promote stale official cache above a noncached official source', () => {
  const source = normalizeOfficialNavQuote(move({ date: '2026-09-28', prevDate: '2026-09-24' }), { now: NOW });
  const candidates = buildFundQuoteCandidates({ source_quote: source, latest_nav_move: move({ sourceTier: 'cache', cacheState: 'stale' }) }, { now: NOW });
  const selected = selectPreferredQuote(candidates);
  assert.equal(selected.targetDate, '2026-09-28');
  assert.equal(selected.status, 'official');
});

test('explicit upstream stale official data is not silently normalized to successful official data', () => {
  const quote = normalizeEstimateQuote({
    code: '005844', kind: 'official_nav', status: 'stale', source: 'eastmoney_official_nav',
    value_nav: 3.2259, value_change: 0, base_nav: 3.2037,
    base_nav_date: '2026-09-28', value_date: '2026-09-29', source_time: '2026-09-29',
  }, { now: NOW });
  assert.equal(quote.status, 'stale');
});

test('canonical null is not replaced with a deprecated estimate alias', () => {
  const quote = normalizeEstimateQuote({
    code: '005844', kind: 'intraday_estimate', source: 'sinan-estimate-proxy',
    value_nav: null, est_nav: 9, estimate_change: null, est_change: 12,
    base_nav: 1, base_nav_date: '2026-09-29', value_date: '2026-09-30', source_time: '2026-09-30 13:59:00',
  }, { now: NOW });
  assert.equal(quote.value, null);
  assert.equal(quote.changePct, null);
  assert.equal(quote.status, 'unavailable');
});

test('presentation reports the official comparison interval even when target is today', () => {
  for (const date of ['2026-09-29', '2026-09-30']) {
    const quote = normalizeOfficialNavQuote(move({ date }), { now: NOW });
    const view = createQuotePresentation(quote, { now: NOW, shares: 100 });
    assert.equal(view.periodLabel, '最新正式净值变动');
    assert.match(view.periodDatesLabel, /2026-09-28/);
    assert.match(view.periodDatesLabel, new RegExp(date));
  }
});

test('notifications reject an unbound or different comparison day despite fresh observed/fetched clocks', () => {
  assert.equal(evaluateNotificationEligibility(live(), { now: NOW }).eligible, true);
  for (const overrides of [
    { targetDate: '2026-09-29' }, { targetDate: null }, { baseNavDate: null },
    { baseNavDate: '2026-09-28' }, { targetDate: '2026-10-01' },
    { sourceTier: 'cache', cacheState: 'fresh' },
  ]) {
    const result = evaluateNotificationEligibility(live(overrides), { now: NOW });
    assert.equal(result.eligible, false, `ineligible ${JSON.stringify(overrides)}`);
    assert.equal(typeof result.reason, 'string');
  }
});

test('holdings model rejects duplicate identity and total weights above 100 percent', () => {
  for (const [rows, reason] of [
    [stocks({ code: '600000' }), 'HOLDINGS_DUPLICATE_IDENTITY'],
    [stocks({ ratio: 11 }), 'HOLDINGS_TOTAL_RATIO_EXCEEDED'],
    [stocks({ ratio: null }), 'HOLDINGS_ROW_INVALID'],
    [stocks({ code: '' }), 'HOLDINGS_ROW_INVALID'],
  ]) {
    const result = calculateHoldingsEstimate(rows, { now: NOW, reportDate: '2026-06-30', requireCurrentReport: true });
    assert.equal(result.available, false);
    assert.equal(result.change, null);
    assert.ok(result.reasonCodes.includes(reason));
  }
});

test('holdings model keeps missing price moves distinct from a true zero', () => {
  const options = { now: NOW, reportDate: '2026-06-30', requireCurrentReport: true };
  const absent = calculateHoldingsEstimate(stocks({ change: null }), options);
  const zero = calculateHoldingsEstimate(stocks({ change: 0 }), options);
  assert.equal(absent.available, false);
  assert.equal(absent.change, null);
  assert.equal(zero.available, true);
  assert.equal(zero.change, 0);
});

test('holdings report rejects a nonexistent date and a future disclosure date', () => {
  assert.equal(isCurrentHoldingsReport('2026-02-30', Date.parse('2026-03-15T00:00:00+08:00')), false);
  assert.equal(isCurrentHoldingsReport('2026-10-01', NOW), false);
});

test('a stale official cache cannot become a newly calculated model NAV baseline', () => {
  const fund = {
    source_quote: { valueKind: 'official_nav', status: 'stale', sourceTier: 'cache', cacheState: 'stale', value: 9, officialNavDate: '2026-09-29' },
    latest_nav_move: move({ sourceTier: 'cache', cacheState: 'stale' }),
  };
  assert.equal(latestOfficialNavBase(fund), undefined);
});

test('the undisclosed portfolio is described as unknown rather than a zero contribution', () => {
  const fund = { latest_nav_move: { nav: 1, date: '2026-09-29' } };
  applyHoldingsEstimate(fund, { available: true, change: 1, coverage: 80, quoteCount: 10, sourceTime: '2026-09-30 13:59:00', reportDate: '2026-06-30' });
  assert.equal(fund.est_holdings_model, true);
  assert.doesNotMatch(fund.est_note, /按0贡献/);
  assert.match(fund.est_note, /未知|误差/);
});
