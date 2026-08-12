import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHoldingImportPlan,
  createHoldingImportPlan,
  screenshotCostTotal,
  suggestCostFromScreenshot,
  validateHoldingImportPlan,
} from '../js/holding-import-plan.js';

const existing = [
  { code: '000001', name: 'Old Fund', shares: 100, cost: 1.2, updated_at: '2026-08-01T00:00:00.000Z', deleted: false },
  { code: '000002', name: 'Keep Fund', shares: 50, cost: 2, updated_at: '2026-08-01T00:00:00.000Z', deleted: false },
];

test('a screenshot amount and profit can only suggest total cost after real shares are supplied', () => {
  const candidate = { holdingAmount: 1250, holdingProfit: 250 };
  assert.equal(screenshotCostTotal(candidate), 1000);
  assert.equal(suggestCostFromScreenshot(candidate, ''), null);
  assert.equal(suggestCostFromScreenshot(candidate, 400), 2.5);
});

test('missing OCR fields stay missing while a real zero remains zero', () => {
  const [row] = createHoldingImportPlan([{
    rawFundName: 'Incomplete fund',
    match: { status: 'matched', code: '000001', name: 'Incomplete fund' },
    holdingAmount: null,
    holdingProfit: '',
    holdingProfitRate: undefined,
    dailyProfit: 0,
  }], existing);
  assert.equal(row.holdingAmount, null);
  assert.equal(row.holdingProfit, null);
  assert.equal(row.holdingProfitRate, null);
  assert.equal(row.dailyProfit, 0);
  assert.equal(screenshotCostTotal(row), null);
});

test('unmatched OCR rows default to skip and never create a zero-share holding', () => {
  const [row] = createHoldingImportPlan([
    { rawFundName: 'Unknown fund', match: { status: 'needs_confirmation', candidates: [] }, holdingAmount: 100 },
  ], existing);
  assert.equal(row.action, 'skip');
  row.action = 'add';
  row.code = '123456';
  row.name = 'Confirmed fund';
  row.shares = '';
  row.cost = '1';
  const result = validateHoldingImportPlan([row]);
  assert.equal(result.ok, false);
});

test('explicitly selected matches update only confirmed rows and retain screenshot-external holdings', () => {
  const rows = createHoldingImportPlan([
    { rawFundName: 'Old Fund', match: { status: 'matched', code: '000001', name: 'Old Fund' }, holdingAmount: 350, holdingProfit: 50 },
    { rawFundName: 'New Fund', match: { status: 'matched', code: '000003', name: 'New Fund' }, holdingAmount: 840, holdingProfit: 40 },
    { rawFundName: 'Ignored Fund', match: { status: 'needs_confirmation', candidates: [] }, holdingAmount: 100 },
  ], existing);
  rows[0].shares = '200';
  rows[0].useScreenshotCost = true;
  rows[1].shares = '400';
  rows[1].useScreenshotCost = true;
  const result = applyHoldingImportPlan(existing, rows, '2026-08-09T00:00:00.000Z');
  assert.equal(result.ok, true);
  assert.equal(result.applied, 2);
  assert.deepEqual(result.holdings.map(item => item.code), ['000001', '000002', '000003']);
  assert.equal(result.holdings[0].shares, 200);
  assert.equal(result.holdings[0].cost, 1.5);
  assert.equal(result.holdings[1].shares, 50);
  assert.equal(result.holdings[2].cost, 2);
  assert.equal('holdingAmount' in result.holdings[2], false);
  assert.equal('holdingProfit' in result.holdings[2], false);
});

test('an OCR import can restore a tombstone only through an explicit confirmed row', () => {
  const deleted = [{ code: '000004', name: 'Deleted Fund', shares: 1, cost: 1, updated_at: '2026-08-01T00:00:00.000Z', deleted: true }];
  const [row] = createHoldingImportPlan([
    { rawFundName: 'Deleted Fund', match: { status: 'matched', code: '000004', name: 'Deleted Fund' } },
  ], deleted);
  row.action = 'add';
  row.shares = '20';
  row.cost = '3';
  const result = applyHoldingImportPlan(deleted, [row], '2026-08-09T00:00:00.000Z');
  assert.equal(result.holdings[0].deleted, false);
  assert.equal(result.holdings[0].shares, 20);
});
