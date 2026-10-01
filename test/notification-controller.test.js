import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEligibleNotificationLines } from '../js/notifications/notification-controller.js';

const NOW = Date.parse('2026-08-25T14:30:00+08:00');

function quote(overrides = {}) {
  return {
    status: 'realtime', valueKind: 'intraday_estimate', changePct: 0,
    value: 1, baseNav: 1, baseNavDate: '2026-08-24', targetDate: '2026-08-25', sourceTier: 'primary',
    observedAt: '2026-08-25 14:29:00', fetchedAt: '2026-08-25T06:29:30.000Z',
    ...overrides,
  };
}

test('daily lines include only active holdings with same-day live intraday quotes', () => {
  const result = buildEligibleNotificationLines([
    { code: '000001' }, { code: '000002' }, { code: '000003', deleted: true },
  ], [
    { code: '000001', name: '测试基金一', quote: quote({ changePct: 0 }) },
    { code: '000002', name: '正式净值', quote: quote({ status: 'official', valueKind: 'official_nav', changePct: 1 }) },
    { code: '000003', name: '已删除基金', quote: quote({ changePct: 2 }) },
  ], { now: NOW });
  assert.deepEqual(result, { lines: ['测试基金一 +0.00%'], truncated: false, eligibleCount: 1 });
});

test('daily lines are bounded without turning an empty result into a misleading notification', () => {
  const holdings = Array.from({ length: 10 }, (_, index) => ({ code: String(index).padStart(6, '0') }));
  const funds = holdings.map((holding, index) => ({ code: holding.code, name: `基金${index}`, quote: quote({ changePct: index / 10 }) }));
  const result = buildEligibleNotificationLines(holdings, funds, { now: NOW, limit: 8 });
  assert.equal(result.lines.length, 8);
  assert.equal(result.truncated, true);
  assert.equal(result.eligibleCount, 10);
  assert.deepEqual(buildEligibleNotificationLines([], funds, { now: NOW }).lines, []);
});
