// M1 red contract, explicitly run now and required to join npm test at M5.
// This is not a passing gate or a skipped test; OCR implementation is scheduled
// after M2/M3/M4. No screenshot, OCR raw text or personal holding is included.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHoldingImportPlan, createHoldingImportPlan, validateHoldingImportPlan } from '../js/holding-import-plan.js';

const original = [{ code: '000001', name: 'Synthetic original', shares: 100, cost: 1, deleted: false, updated_at: '2026-09-01T00:00:00.000Z' }];
const candidates = [
  { rawFundName: 'Synthetic original', match: { status: 'matched', code: '000001', name: 'Synthetic changed' }, holdingAmount: 120, holdingProfit: 20 },
  { rawFundName: 'Synthetic new', match: { status: 'matched', code: '000002', name: 'Synthetic new' }, holdingAmount: 200, holdingProfit: 0 },
];

test('a non-importable layout defaults all matched rows including existing holdings to skip', () => {
  const rows = createHoldingImportPlan(candidates, original, { importable: false });
  assert.deepEqual(rows.map(row => row.action), ['skip', 'skip']);
  assert.ok(rows.every(row => row.requiresExplicitEnable === true));
  const result = applyHoldingImportPlan(original, rows, '2026-09-30T00:00:00.000Z');
  assert.equal(result.ok, true);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.holdings, original);
});

test('changing an identity or action alone does not bypass explicit row activation', () => {
  const [row] = createHoldingImportPlan(candidates, original, { importable: false });
  row.action = 'update';
  row.shares = '200';
  const validation = validateHoldingImportPlan([row]);
  assert.equal(validation.ok, false);
  const result = applyHoldingImportPlan(original, [row]);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.holdings, original);
});
