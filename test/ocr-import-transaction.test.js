import test from 'node:test';
import assert from 'node:assert/strict';
import { commitConfirmedImport } from '../js/ocr/import-transaction.js';
import {
  HOLDINGS_V3_KEY, loadHoldingsRepository, saveLegacyHoldingsTransaction,
} from '../js/storage/holdings-repository.js';

function fixture() {
  const values = new Map();
  let locked = false;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const locks = { async request(name, options, callback) {
    assert.equal(name, 'fuyu_holdings_repository_v1');
    assert.equal(options.mode, 'exclusive');
    assert.equal(locked, false);
    locked = true;
    try { return await callback({ name }); } finally { locked = false; }
  } };
  assert.equal(saveLegacyHoldingsTransaction(storage, [
    { code: '001001', name: '合成基金A', shares: 10, cost: 1, note: 'keep note' },
  ]).ok, true);
  const baseline = loadHoldingsRepository(storage).document;
  const rows = [{ id: 'synthetic-row', code: '001001', name: '合成基金A', shares: 20, cost: 1, action: 'update' }];
  return { storage, locks, baseline, rows, isLocked: () => locked };
}

for (const mutation of ['edit', 'delete']) {
  test(`OCR confirmation rejects a ${mutation} made while the preview was open`, async () => {
    const { storage, locks, baseline, rows } = fixture();
    const changed = loadHoldingsRepository(storage).legacy.map(item => ({
      ...item, ...(mutation === 'delete' ? { deleted: true } : { shares: 30 }),
    }));
    assert.equal(saveLegacyHoldingsTransaction(storage, changed).ok, true);
    const before = storage.getItem(HOLDINGS_V3_KEY);
    let saveHookCalls = 0;
    const result = await commitConfirmedImport(storage, rows, baseline, {
      locks, beforeSave() { saveHookCalls += 1; return true; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale_local_document');
    assert.equal(storage.getItem(HOLDINGS_V3_KEY), before);
    assert.equal(saveHookCalls, 0);
    if (mutation === 'delete') assert.ok(loadHoldingsRepository(storage).document.holdings[0].deletedAt);
  });
}

test('OCR confirmation preserves unrelated additions and skipped rows under the repository lock', async () => {
  const { storage, locks, baseline, rows, isLocked } = fixture();
  const current = loadHoldingsRepository(storage).legacy;
  assert.equal(saveLegacyHoldingsTransaction(storage, [...current,
    { code: '001002', name: '别处新增', shares: 99, cost: null },
  ]).ok, true);
  const result = await commitConfirmedImport(storage, [...rows,
    { code: '001002', name: '不应覆盖', shares: 1, action: 'skip' },
  ], baseline, { locks, beforeSave() { assert.equal(isLocked(), true); return true; } });
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1);
  const saved = loadHoldingsRepository(storage).legacy;
  assert.equal(saved.find(item => item.code === '001001').shares, 20);
  assert.equal(saved.find(item => item.code === '001001').note, 'keep note');
  assert.equal(saved.find(item => item.code === '001002').shares, 99);
  assert.equal(saved.find(item => item.code === '001002').cost, null);
});

test('OCR confirmation cannot revive a baseline tombstone or commit without a valid baseline', async () => {
  const { storage, locks, rows } = fixture();
  const changed = loadHoldingsRepository(storage).legacy.map(item => ({ ...item, deleted: true }));
  assert.equal(saveLegacyHoldingsTransaction(storage, changed).ok, true);
  const baseline = loadHoldingsRepository(storage).document;
  const before = storage.getItem(HOLDINGS_V3_KEY);
  for (const snapshot of [baseline, null]) {
    const result = await commitConfirmedImport(storage, rows, snapshot, { locks });
    assert.equal(result.ok, false);
    assert.equal(storage.getItem(HOLDINGS_V3_KEY), before);
  }
});

test('OCR confirmation fails closed when locks or the refresh flag cannot be saved', async () => {
  const { storage, locks, baseline, rows } = fixture();
  const before = storage.getItem(HOLDINGS_V3_KEY);
  const noLock = await commitConfirmedImport(storage, rows, baseline, { locks: null });
  assert.equal(noLock.reason, 'storage_lock_unavailable');
  const noFlag = await commitConfirmedImport(storage, rows, baseline, { locks, beforeSave: () => false });
  assert.equal(noFlag.reason, 'pending_flag_failed');
  assert.equal(storage.getItem(HOLDINGS_V3_KEY), before);
});
