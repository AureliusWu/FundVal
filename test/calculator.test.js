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

test('official NAV takes display priority', () => {
  assert.equal(chooseDisplayValue({ official: { nav: 2, change: 1 }, estimate: { nav: 3, change: 2 }, overseas: true }).kind, 'official');
});
