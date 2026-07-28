import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateHolding, chooseDisplayValue, normalizeFundEstimate } from '../js/calculator.js';

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
