import test from 'node:test';
import assert from 'node:assert/strict';
import { commitHoldingEdit } from '../js/runtime/holding-edit.js';
import { loadHoldingsRepository, HOLDINGS_V3_KEY } from '../js/storage/holdings-repository.js';

const locks = { request: async (_name, _options, callback) => callback({ name: 'test' }) };
const options = { locks, now: '2026-09-22T00:00:00Z' };
function storageFixture() {
  const data = new Map();
  let fail = false;
  return {
    data, set fail(value) { fail = value; },
    getItem: key => data.get(key) ?? null,
    setItem(key, value) { if (fail && key.includes('backup')) throw new Error('quota'); data.set(key, String(value)); },
    removeItem: key => data.delete(key),
  };
}
async function seed(storage) {
  const result = await commitHoldingEdit(storage, { code: '005844', baseline: null, operation: 'add', values: { name: '测试', shares: 10, cost: null, note: '保留备注' } }, options);
  assert.equal(result.ok, true);
  return result;
}

test('failed save leaves original document, input and note unchanged', async () => {
  const storage = storageFixture();
  const original = await seed(storage);
  const raw = storage.getItem(HOLDINGS_V3_KEY);
  const values = { shares: 99, cost: 1.2 };
  storage.fail = true;
  const result = await commitHoldingEdit(storage, { code: '005844', baseline: original.document.holdings[0], operation: 'edit', values }, options);
  assert.equal(result.ok, false);
  assert.equal(storage.getItem(HOLDINGS_V3_KEY), raw);
  assert.equal(original.legacy[0].shares, 10);
  assert.deepEqual(values, { shares: 99, cost: 1.2 });
});

test('a form opened before another tab edits or deletes cannot overwrite/restore it', async () => {
  for (const operation of ['edit', 'delete']) {
    const storage = storageFixture();
    const original = await seed(storage);
    const baseline = original.document.holdings[0];
    const external = await commitHoldingEdit(storage, { code: '005844', baseline, operation, values: { shares: 20 } }, options);
    assert.equal(external.ok, true);
    const stale = await commitHoldingEdit(storage, { code: '005844', baseline, operation: 'edit', values: { shares: 99 } }, options);
    assert.equal(stale.reason, 'edit_conflict');
    assert.equal(storage.getItem(HOLDINGS_V3_KEY), JSON.stringify(external.document));
  }
});

test('editing one record preserves an unrelated concurrent addition and notes', async () => {
  const storage = storageFixture();
  const original = await seed(storage);
  assert.equal((await commitHoldingEdit(storage, { code: '001001', baseline: null, operation: 'add', values: { shares: 3, cost: 1 } }, options)).ok, true);
  const result = await commitHoldingEdit(storage, { code: '005844', baseline: original.document.holdings[0], operation: 'edit', values: { shares: 20 } }, options);
  assert.equal(result.ok, true);
  assert.equal(result.legacy.find(row => row.code === '001001').shares, 3);
  assert.equal(result.legacy.find(row => row.code === '005844').note, '保留备注');
});

test('missing origin lock and cancelled refresh never write holdings', async () => {
  const storage = storageFixture();
  const original = await seed(storage);
  const raw = storage.getItem(HOLDINGS_V3_KEY);
  const edit = { code: '005844', baseline: original.document.holdings[0], operation: 'name', values: { name: '新名' } };
  assert.equal((await commitHoldingEdit(storage, edit, { ...options, locks: null })).reason, 'storage_lock_unavailable');
  assert.equal((await commitHoldingEdit(storage, { ...edit, signal: AbortSignal.abort() }, options)).reason, 'edit_cancelled');
  assert.equal(storage.getItem(HOLDINGS_V3_KEY), raw);
  assert.equal(loadHoldingsRepository(storage).legacy[0].name, '测试');
});
