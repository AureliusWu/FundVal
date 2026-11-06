import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOLDINGS_DEVICE_KEY, HOLDINGS_JOURNAL_KEY, HOLDINGS_PROJECTION_META_KEY,
  HOLDINGS_V1_COMPAT_KEY, HOLDINGS_V3_KEY, loadHoldingsRepository, withHoldingsLock,
} from '../js/storage/holdings-repository.js';

test('Android repository runs the durability adapter under the real lock and validates a full projection', async t => {
  const setGlobal = (name, value) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name]);
  };
  const data = new Map();
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  };
  const loaded = loadHoldingsRepository(storage, { generateDeviceId: () => 'device:synthetic-android' });
  assert.equal(loaded.ok, true);
  setGlobal('document', { documentElement: { dataset: { fundvalPlatform: 'android' } } });
  let locked = false, entered = false;
  const locks = { async request(name, options, callback) {
    assert.equal(name, 'fuyu_holdings_repository_v1');
    assert.equal(options.mode, 'exclusive');
    locked = true;
    try { return await callback({ name }); } finally { locked = false; }
  } };
  assert.equal((await withHoldingsLock(() => assert.fail('bridge absent'), { locks })).reason, 'android_storage_unavailable');
  setGlobal('FundValAndroid', { async withDurableHoldings(callback, validate) {
    assert.equal(locked, true);
    const checkpoint = Object.fromEntries([HOLDINGS_V3_KEY, HOLDINGS_V1_COMPAT_KEY, HOLDINGS_DEVICE_KEY,
      HOLDINGS_PROJECTION_META_KEY, HOLDINGS_JOURNAL_KEY].map(key => [key, storage.getItem(key)]));
    assert.equal(validate(checkpoint), true);
    assert.equal(validate({ ...checkpoint, [HOLDINGS_JOURNAL_KEY]: '{}' }), false);
    assert.equal(validate({ ...checkpoint, [HOLDINGS_V1_COMPAT_KEY]: '[{}]' }), false);
    assert.equal(validate({ ...checkpoint, [HOLDINGS_V3_KEY]: '{"schema":4,"holdings":[]}' }), false);
    entered = true;
    return callback();
  } });
  assert.deepEqual(await withHoldingsLock(() => ({ ok: true }), { locks }), { ok: true });
  assert.equal(entered, true);
  assert.equal(locked, false);
});
