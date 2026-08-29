import test from 'node:test';
import assert from 'node:assert/strict';
import { activeHoldingCodes, retainActiveFundData } from '../js/runtime/active-holdings.js';

test('canonical active holdings are the only authority for visible fund cards', () => {
  const holdings = [
    { code: '000001', shares: 0, deleted: false },
    { code: '000002', shares: 10, deleted: true },
    { fundCode: '000003', shares: 5, deletedAt: '2026-08-29T00:00:00Z' },
    { code: '000004', shares: 1, deleted: false },
  ];
  assert.deepEqual(activeHoldingCodes(holdings), ['000001', '000004'], 'zero-share watch items remain active');
  assert.deepEqual(retainActiveFundData(holdings, [
    { code: '000001', value: 1 },
    { code: '000002', value: 2 },
    { code: '000004', value: 4 },
    { code: '999999', value: 9 },
  ]), [
    { code: '000001', value: 1 },
    { code: '000004', value: 4 },
  ]);
});
