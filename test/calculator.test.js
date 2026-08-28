import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateHolding, chooseDisplayValue, normalizeFundEstimate, resolveQuoteBaseNav } from '../js/calculator.js';

test('normalizes an estimate without converting missing values to zero', () => {
  const result = normalizeFundEstimate({ dwjz: '1.0000', gsz: '', gszzl: '' });
  assert.equal(result.lastNav, 1);
  assert.equal(result.nav, null);
  assert.equal(result.change, null);
});

test('calculates holding profit consistently', () => {
  const result = calculateHolding(100, 1.2, 1.3, 1.25);
  assert.equal(result.value, 130);
  assert.ok(Math.abs(result.todayProfit - 5) < 1e-10);
  assert.equal(result.totalProfit, 10);
});

test('keeps cumulative profit unknown when cost is missing without hiding daily profit', () => {
  for (const cost of [null, undefined, '', '   ']) {
    const result = calculateHolding(100, cost, 1.3, 1.25);
    assert.equal(result.value, 130);
    assert.ok(Math.abs(result.todayProfit - 5) < 1e-10);
    assert.equal(result.totalProfit, null);
    assert.equal(result.totalProfitRate, null);
  }
});

test('treats explicit zero cost as known while leaving its return rate undefined', () => {
  const result = calculateHolding(100, 0, 1.3, 1.25);
  assert.equal(result.value, 130);
  assert.ok(Math.abs(result.todayProfit - 5) < 1e-10);
  assert.equal(result.totalProfit, 130);
  assert.equal(result.totalProfitRate, null);
});

test('does not silently convert invalid negative cost into zero cost', () => {
  const result = calculateHolding(100, -1, 1.3, 1.25);
  assert.ok(Math.abs(result.todayProfit - 5) < 1e-10);
  assert.equal(result.totalProfit, null);
  assert.equal(result.totalProfitRate, null);
});

test('binds calculations to the base NAV that belongs to the selected quote', () => {
  const fund = {
    last_nav: 4,
    est_model_base_nav: 4.1,
    latest_nav_move: { nav: 4.1, prevNav: 4.05 },
  };
  assert.equal(resolveQuoteBaseNav(fund, { valueKind: 'model_estimate' }), 4.1);
  assert.equal(resolveQuoteBaseNav(fund, { valueKind: 'official_nav' }), 4.05);
  assert.equal(resolveQuoteBaseNav(fund, { valueKind: 'intraday_estimate' }), 4);
  assert.equal(resolveQuoteBaseNav({}, { valueKind: 'model_estimate' }), null);
});

test('current next-NAV overseas model takes display priority while official NAV remains available separately', () => {
  assert.equal(chooseDisplayValue({
    official: { nav: 2, change: 1 },
    estimate: { nav: 3, change: 2, kind: 'overseas_model', stale: false },
    overseas: true,
  }).kind, 'model');
});

test('stale overseas model falls back to latest published NAV move', () => {
  assert.equal(chooseDisplayValue({
    official: { nav: 2, change: 1 },
    estimate: { nav: 3, change: 2, kind: 'overseas_model', stale: true },
    overseas: true,
  }).kind, 'official');
});

test('official NAV fallback is not mislabeled as an estimate', () => {
  const result = chooseDisplayValue({
    estimate: { nav: 1.02, change: 2, kind: 'official_nav' },
    overseas: false,
  });
  assert.deepEqual(result, { nav: 1.02, change: 2, kind: 'official', label: '净', stale: false });
});
