import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHoldingsEstimate,
  calculateHoldingsEstimate,
  composeFundEnrichment,
  formatChinaQuoteTime,
  isCurrentHoldingsReport,
  normalizeTencentQuoteTime,
  parseTencentQuoteTime,
} from '../js/holdings-estimate.js';

const NOW = Date.parse('2026-07-27T08:23:00Z');

test('v16 exchange-local conversion rejects impossible source dates and times before Date rollover', () => {
  for (const value of ['20260230145900', '20260908245900', '20260908146000', '20260908145960']) {
    assert.equal(normalizeTencentQuoteTime(value, 'usQQQ'), '');
    assert.equal(normalizeTencentQuoteTime(value, 'jp285A'), '');
  }
});

test('calculates the disclosed top-holdings contribution from same-day quotes', () => {
  const ratios = [9.55, 9.19, 9.12, 9.08, 8.92, 8.69, 7.57, 7.44, 7.04, 6.87];
  const changes = [8.96, 2.13, 2.90, 2.88, 1.72, 3.27, 6.42, 0.11, 1.31, 2.34];
  const result = calculateHoldingsEstimate(ratios.map((ratio, index) => ({
    code: String(600001 + index), name: `合成股票${index + 1}`, market: 'cn',
    ratio,
    change: changes[index],
    quoteTime: '2026-07-27 16:14:00',
  })), { now: NOW });

  assert.equal(result.available, true);
  assert.equal(result.quoteCount, 10);
  assert.ok(Math.abs(result.coverage - 83.47) < 1e-9);
  assert.ok(Math.abs(result.change - 2.762158) < 1e-9);
  assert.equal(result.sourceTime, '2026-07-27 16:14:00');
});

test('rejects previous-trading-day quotes instead of presenting them as today', () => {
  const result = calculateHoldingsEstimate(Array.from({ length: 10 }, (_, index) => ({
    code: String(600001 + index), name: `合成股票${index + 1}`, market: 'cn',
    ratio: 8,
    change: 2,
    quoteTime: '2026-07-24 15:00:00',
  })), { now: NOW });

  assert.equal(result.available, false);
  assert.equal(result.quoteCount, 0);
  assert.equal(result.change, null);
});

test('keeps an estimate unavailable when same-day quote coverage is too low', () => {
  const result = calculateHoldingsEstimate(Array.from({ length: 4 }, (_, index) => ({
    code: String(600001 + index), name: `合成股票${index + 1}`, market: 'cn',
    ratio: 9,
    change: 2,
    quoteTime: '2026-07-27 14:30:00',
  })), { now: NOW });

  assert.equal(result.available, false);
  assert.match(result.reason, /覆盖不足/);
});

test('bases the holdings estimate on the latest official NAV without overwriting its date', () => {
  const fund = {
    est_kind: 'official_nav',
    est_realtime: false,
    last_nav: 3.3867,
    est_nav: 3.4823,
    nav_date: '2026-07-23',
    est_time: '2026-07-24',
    latest_nav_move: { nav: 3.4823, date: '2026-07-24' },
  };
  applyHoldingsEstimate(fund, {
    available: true,
    change: 2.762158,
    coverage: 83.47,
    quoteCount: 10,
    sourceTime: '2026-07-27 16:14:00',
  });

  assert.equal(fund.est_kind, 'holdings_model');
  assert.equal(fund.last_nav, 3.4823);
  assert.equal(fund.nav_date, '2026-07-24');
  assert.equal(fund.est_time, '2026-07-27 16:14:00');
  assert.ok(Math.abs(fund.est_nav - 3.578486628034) < 1e-9);
});

test('official NAV and holdings enrichment converge regardless of completion order', () => {
  const rawFund = {
    est_kind: 'official_nav',
    est_realtime: false,
    last_nav: 3.2,
    est_nav: 3.3,
    nav_date: '2026-08-27',
    est_time: '2026-08-28',
  };
  const officialNavMove = {
    prevNav: 3.3,
    nav: 3.5,
    prevDate: '2026-08-27',
    date: '2026-08-28',
    change: 6.060606,
  };
  const holdingsEstimate = {
    available: true,
    change: 2,
    coverage: 80,
    quoteCount: 10,
    sourceTime: '2026-08-31 14:30:00',
    reportDate: '2026-06-30',
  };

  function settle(order) {
    let move = null;
    let estimate = null;
    let snapshot = rawFund;
    order.forEach((source) => {
      if (source === 'official') move = officialNavMove;
      if (source === 'holdings') estimate = holdingsEstimate;
      snapshot = composeFundEnrichment(rawFund, {
        officialNavMove: move,
        holdingsEstimate: estimate,
      });
    });
    return snapshot;
  }

  const holdingsFirst = settle(['holdings', 'official']);
  const officialFirst = settle(['official', 'holdings']);
  assert.deepEqual(holdingsFirst, officialFirst);
  assert.equal(holdingsFirst.last_nav, 3.5);
  assert.equal(holdingsFirst.nav_date, '2026-08-28');
  assert.ok(Math.abs(holdingsFirst.est_nav - 3.57) < 1e-12);
  assert.equal(rawFund.latest_nav_move, undefined, 'primary quote snapshot must remain immutable');
});

test('does not replace a genuine current upstream estimate', () => {
  const fund = { est_kind: 'estimate', est_realtime: true, est_change: 1.2 };
  applyHoldingsEstimate(fund, { available: true, change: 2, coverage: 80, quoteCount: 10, sourceTime: '2026-07-27 14:00:00' });
  assert.equal(fund.est_change, 1.2);
  assert.equal(fund.est_kind, 'estimate');
});

test('normalizes Eastmoney and Tencent quote timestamps to China time', () => {
  assert.equal(formatChinaQuoteTime(1785139899), '2026-07-27 16:11:39');
  assert.equal(parseTencentQuoteTime('20260727161439'), '2026-07-27 16:14:39');
  assert.equal(normalizeTencentQuoteTime('20260727160001', 'usQQQ'), '2026-07-28 04:00:01');
  assert.equal(normalizeTencentQuoteTime('2026-07-27 16:00:01', 'usQQQ'), '2026-07-28 04:00:01');
  assert.equal(normalizeTencentQuoteTime('2026-01-27 16:00:01', 'usQQQ'), '2026-01-28 05:00:01');
  assert.equal(normalizeTencentQuoteTime('2026-08-24 14:00:13', 'kr000660'), '2026-08-24 13:00:13');
  assert.equal(normalizeTencentQuoteTime('2026-08-24 00:30:00', 'jp285A'), '2026-08-23 23:30:00');
  assert.equal(normalizeTencentQuoteTime('2026/08/07 16:08:40', 'r_hkHSTECH'), '2026-08-07 16:08:40');
  assert.equal(parseTencentQuoteTime('bad'), '');
});

test('requires a current disclosure date before using a top-holdings estimate in the live page', () => {
  const now = Date.parse('2026-08-08T08:00:00Z');
  assert.equal(isCurrentHoldingsReport('2026-06-30', now), true);
  assert.equal(isCurrentHoldingsReport('2025-12-31', now), false);
  const result = calculateHoldingsEstimate([], {
    now,
    reportDate: '2025-12-31',
    requireCurrentReport: true,
  });
  assert.equal(result.available, false);
  assert.match(result.reason, /披露日期/);
});
