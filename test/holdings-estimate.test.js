import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHoldingsEstimate,
  calculateHoldingsEstimate,
  formatChinaQuoteTime,
  parseTencentQuoteTime,
} from '../js/holdings-estimate.js';

const NOW = Date.parse('2026-07-27T08:23:00Z');

test('calculates the disclosed top-holdings contribution from same-day quotes', () => {
  const ratios = [9.55, 9.19, 9.12, 9.08, 8.92, 8.69, 7.57, 7.44, 7.04, 6.87];
  const changes = [8.96, 2.13, 2.90, 2.88, 1.72, 3.27, 6.42, 0.11, 1.31, 2.34];
  const result = calculateHoldingsEstimate(ratios.map((ratio, index) => ({
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
  const result = calculateHoldingsEstimate(Array.from({ length: 10 }, () => ({
    ratio: 8,
    change: 2,
    quoteTime: '2026-07-24 15:00:00',
  })), { now: NOW });

  assert.equal(result.available, false);
  assert.equal(result.quoteCount, 0);
  assert.equal(result.change, null);
});

test('keeps an estimate unavailable when same-day quote coverage is too low', () => {
  const result = calculateHoldingsEstimate(Array.from({ length: 4 }, () => ({
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

test('does not replace a genuine current upstream estimate', () => {
  const fund = { est_kind: 'estimate', est_realtime: true, est_change: 1.2 };
  applyHoldingsEstimate(fund, { available: true, change: 2, coverage: 80, quoteCount: 10, sourceTime: '2026-07-27 14:00:00' });
  assert.equal(fund.est_change, 1.2);
  assert.equal(fund.est_kind, 'estimate');
});

test('normalizes Eastmoney and Tencent quote timestamps to China time', () => {
  assert.equal(formatChinaQuoteTime(1785139899), '2026-07-27 16:11:39');
  assert.equal(parseTencentQuoteTime('20260727161439'), '2026-07-27 16:14:39');
  assert.equal(parseTencentQuoteTime('bad'), '');
});
