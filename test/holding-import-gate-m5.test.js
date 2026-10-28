import test from 'node:test';
import assert from 'node:assert/strict';
import * as plan from '../js/holding-import-plan.js';
import { commitConfirmedImport } from '../js/ocr/import-transaction.js';
import { loadHoldingsRepository, saveLegacyHoldingsTransaction } from '../js/storage/holdings-repository.js';

const existing = [{ code: '000001', name: 'Original', shares: 100, cost: null, deleted: false,
  updated_at: '2026-09-01T00:00:00.000Z', note: 'preserved' },
{ code: '000003', name: 'External', shares: 3, cost: 0, deleted: false }];
const candidate = (code = '000001', overrides = {}) => ({ rawFundName: 'Confirmed', semanticReliable: true,
  match: { status: 'matched', strategy: 'code', code, name: 'Confirmed' }, warnings: [], ...overrides });
const create = (row = candidate(), options = { importable: true }) => plan.createHoldingImportPlan([row], existing, options)[0];
const enabled = row => plan.setHoldingImportRowEnabled(row, true);

for (const importable of [undefined, false, null, 0, 'true']) test('layout ' + String(importable) + ' defaults existing and new matched rows to skip', () => {
  const rows = plan.createHoldingImportPlan([candidate(), candidate('000002')], existing, { importable });
  assert.deepEqual(rows.map(row => row.action), ['skip', 'skip']);
  assert.ok(rows.every(row => row.requiresExplicitEnable && row.explicitlyEnabled === false));
  const result = plan.applyHoldingImportPlan(existing, rows);
  assert.equal(result.applied, 0); assert.deepEqual(result.holdings, existing);
});

test('omitted layout context is not treated as trusted', () => {
  assert.equal(plan.createHoldingImportPlan([candidate()], existing)[0].action, 'skip');
});

for (const [name, value] of [
  ['unknown row geometry', candidate('000001', { semanticReliable: undefined })],
  ['false row geometry', candidate('000001', { semanticReliable: false })],
  ['fuzzy identity', candidate('000001', { match: { status: 'matched', strategy: 'fuzzy', code: '000001', name: 'Confirmed' } })],
  ['unknown identity strategy', candidate('000001', { match: { status: 'matched', code: '000001', name: 'Confirmed' } })],
  ['ambiguous A/C identity', candidate('000001', { match: { status: 'needs_confirmation', strategy: 'exact_name_ambiguous', candidates: [] } })],
  ['structured identity uncertainty', candidate('000001', { risks: { identityUncertain: true } })],
  ['structured share-class uncertainty', candidate('000001', { risks: { shareClassUncertain: true } })],
  ['structured numeric ambiguity', candidate('000001', { risks: { numericAmbiguous: true } })],
  ['structured sign uncertainty', candidate('000001', { risks: { signUncertain: true } })],
  ['unmatched row', candidate('000001', { match: { status: 'unmatched' } })],
]) test(name + ' cannot automatically reuse existing shares', () => {
  const row = create(value); assert.equal(row.action, 'skip'); assert.equal(row.requiresExplicitEnable, true);
  row.action = 'update'; row.code = '000001'; row.shares = '200';
  assert.equal(plan.validateHoldingImportPlan([row]).ok, false);
  const result = plan.applyHoldingImportPlan(existing, [row]); assert.equal(result.applied, 0); assert.deepEqual(result.holdings, existing);
});

test('trusted exact rows retain normal defaults while warning text cannot grant or revoke policy', () => {
  assert.equal(create().action, 'update'); assert.equal(create(candidate('000002')).action, 'add');
  assert.equal(create(candidate('000001', { warnings: ['ambiguous fuzzy missing header'] })).requiresExplicitEnable, false);
  assert.equal(create(candidate('000001', { risks: { identityUncertain: true }, warnings: [] })).action, 'skip');
});

test('explicit row enable is a pure code-and-name-bound grant, not global acknowledgement or field edits', () => {
  const row = create(candidate(), { importable: false });
  row.action = 'update'; row.shares = '200'; row.globalAcknowledgement = true;
  assert.equal(plan.validateHoldingImportPlan([row]).ok, false);
  const approved = enabled(row); assert.notEqual(approved, row); assert.equal(row.explicitlyEnabled, false);
  assert.equal(plan.validateHoldingImportPlan([approved]).ok, true);
  for (const field of ['code', 'name']) {
    const changed = { ...approved, [field]: field === 'code' ? '000002' : 'Different identity' };
    assert.equal(plan.validateHoldingImportPlan([changed]).ok, false, field);
  }
  assert.equal(plan.validateHoldingImportPlan([{ ...approved, shares: '250', cost: '0' }]).ok, true);
});

test('a trusted row changed to a different identity also requires a fresh explicit grant', () => {
  const row = create(); row.name = 'Different identity';
  assert.equal(plan.validateHoldingImportPlan([row]).ok, false);
  assert.equal(plan.validateHoldingImportPlan([enabled(row)]).ok, true);
});

test('revoking row enable cannot be bypassed by assigning update again', () => {
  const approved = enabled(create(candidate(), { importable: false }));
  const revoked = plan.setHoldingImportRowEnabled(approved, false); revoked.action = 'update';
  assert.equal(plan.validateHoldingImportPlan([revoked]).ok, false);
});

test('enable respects explicit skip and never supplies missing or zero real shares', () => {
  const row = create(candidate('000002'), { importable: false });
  for (const shares of ['', '0', -1, null]) assert.equal(plan.validateHoldingImportPlan([{ ...enabled(row), shares }]).ok, false);
  assert.equal(enabled({ ...row, explicitSkip: true }).action, 'skip');
});

test('enabled confirmation preserves null/zero, opt-in cost, external rows/order/notes and excludes gate metadata', () => {
  const rows = [enabled(create(candidate('000001', { holdingAmount: 120, holdingProfit: 20 }), { importable: false })),
    enabled(create(candidate('000002', { holdingAmount: 200, holdingProfit: 0 }), { importable: false }))];
  rows[0].shares = '200'; rows[1].shares = '100'; rows[1].useScreenshotCost = true;
  const result = plan.applyHoldingImportPlan(existing, rows, '2026-10-25T00:00:00.000Z');
  assert.equal(result.ok, true); assert.equal(result.applied, 2);
  assert.deepEqual(result.holdings.map(row => row.code), ['000001', '000003', '000002']);
  assert.equal(result.holdings[0].cost, null); assert.equal(result.holdings[0].note, 'preserved');
  assert.equal(result.holdings[1].cost, 0); assert.equal(result.holdings[2].cost, 2);
  assert.doesNotMatch(JSON.stringify(result.holdings), /requiresExplicitEnable|explicitlyEnabled|approvedIdentity|riskReasons/);
});

test('unknown actions are not an alternative write authorization', () => {
  const row = create(); row.action = 'unexpected'; assert.equal(plan.validateHoldingImportPlan([row]).ok, false);
});

test('raw rows and missing policy fields fail closed instead of interpreting unknown as safe', () => {
  const raw = { code: '000001', name: 'Confirmed', shares: '200', cost: '', action: 'update' };
  const variants = [raw, ...['requiresExplicitEnable', 'riskReasons', 'sourceIdentity'].map(key => {
    const value = create(); delete value[key]; return value;
  })];
  for (const value of variants) {
    assert.equal(plan.validateHoldingImportPlan([value]).ok, false);
    assert.equal(plan.applyHoldingImportPlan(existing, [value]).applied, 0);
    assert.equal(plan.validateHoldingImportPlan([enabled(value)]).ok, true);
  }
  const risky = create(candidate(), { importable: false }); delete risky.requiresExplicitEnable;
  risky.action = 'update';
  assert.equal(plan.validateHoldingImportPlan([risky]).ok, false);
});

test('the actual locked commit rejects an action-only bypass before any save hook', async () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  // Existing-row baseline isolates policy validation from unrelated seed writes.
  assert.equal(saveLegacyHoldingsTransaction(storage, [existing[0]]).ok, true);
  const baseline = loadHoldingsRepository(storage).document;
  const row = create(candidate(), { importable: false }); row.action = 'update'; row.shares = '200';
  let saveCalls = 0;
  const result = await commitConfirmedImport(storage, [row], baseline, {
    locks: { request: async (name, options, callback) => callback({ name }) }, beforeSave() { saveCalls++; return true; },
  });
  assert.equal(result.ok, false); assert.equal(saveCalls, 0);
  assert.equal(loadHoldingsRepository(storage).legacy[0].shares, 100);
});

test('an explicitly enabled risk row commits real shares and zero cost under the actual lock', async () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  assert.equal(saveLegacyHoldingsTransaction(storage, [existing[0]]).ok, true);
  const baseline = loadHoldingsRepository(storage).document;
  const pending = create(candidate('000002'), { importable: false }); pending.shares = '25'; pending.cost = '0';
  const row = enabled(pending);
  let locked = false, saveCalls = 0;
  const result = await commitConfirmedImport(storage, [row], baseline, {
    locks: { request: async (name, options, callback) => {
      assert.equal(options.mode, 'exclusive'); locked = true;
      try { return await callback({ name }); } finally { locked = false; }
    } }, beforeSave() { assert.equal(locked, true); saveCalls++; return true; },
  });
  assert.equal(result.ok, true); assert.equal(result.applied, 1); assert.equal(saveCalls, 1);
  const saved = loadHoldingsRepository(storage).legacy;
  assert.deepEqual(saved.map(item => item.code), ['000001', '000002']);
  assert.equal(saved[0].shares, 100); assert.equal(saved[0].cost, null); assert.equal(saved[0].note, 'preserved');
  assert.equal(saved[1].shares, 25); assert.equal(saved[1].cost, 0);
  assert.doesNotMatch(JSON.stringify(saved), /requiresExplicitEnable|explicitlyEnabled|approvedIdentity|riskReasons/);
});
