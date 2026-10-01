import test from 'node:test';
import assert from 'node:assert/strict';
import { holdingQuoteAmounts } from '../js/runtime/holding-quote-amounts.js';

const now = Date.parse('2026-09-30T06:00:00Z');
const quote = Object.freeze({ valueKind: 'official_nav', status: 'official', sourceTier: 'secondary',
  value: 3.2259, baseNav: 3.2037, baseNavDate: '2026-09-28', targetDate: '2026-09-29' });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10);

test('v16 current holdings, not cached shares or a pending refresh, own all displayed amounts', () => {
  const original = holdingQuoteAmounts(quote, { shares: 100, cost: 3 }, now);
  const edited = holdingQuoteAmounts(quote, { shares: 200, cost: 3.1 }, now);
  near(original.today_profit, 2.22);
  near(edited.today_profit, 4.44);
  near(edited.curr_value, 645.18);
  near(edited.total_profit, 25.18);
  near(edited.total_profit_rate, 25.18 / 620 * 100);
  assert.equal(edited.period.isTodayEstimate, false);
  assert.equal(edited.period.displayLabel, '最新正式净值变动');
  assert.deepEqual(quote, { valueKind: 'official_nav', status: 'official', sourceTier: 'secondary',
    value: 3.2259, baseNav: 3.2037, baseNavDate: '2026-09-28', targetDate: '2026-09-29' });
});

test('v16 watch-only, missing quote and unknown cost preserve missing semantics', () => {
  const watch = holdingQuoteAmounts(quote, { shares: 0, cost: null }, now);
  assert.equal(watch.curr_value, 0);
  assert.equal(watch.today_profit, null);
  assert.equal(watch.total_profit, null);
  assert.equal(holdingQuoteAmounts(quote, { shares: 100, cost: null }, now).total_profit, null);
  assert.equal(holdingQuoteAmounts(null, { shares: 100, cost: 3 }, now).curr_value, null);
});
