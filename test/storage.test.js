import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backupHoldings,
  getCached,
  makeCloudPayload,
  parseCloudPayload,
  safeSetItem,
  setCached
} from '../js/storage.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };
}

test('reads legacy cloud arrays and future-compatible schema payloads', () => {
  assert.equal(parseCloudPayload([{ code: '000001' }]).schema, 1);
  assert.equal(parseCloudPayload({ schema: 3, holdings: [] }).schema, 3);
  const payload = makeCloudPayload([{ code: '000001' }], 'device');
  assert.equal(payload.schema, 2);
  assert.equal(payload.device_id, 'device');
});

test('cache exposes freshness without hiding stale data', () => {
  const storage = memoryStorage();
  setCached('x', { value: 1 }, 100, 'test', storage, 1000);
  assert.equal(getCached('x', 100, storage, 1050).fresh, true);
  assert.equal(getCached('x', 100, storage, 1200).fresh, false);
});

test('storage write failures are contained', () => {
  const storage = { setItem() { throw new Error('quota'); } };
  assert.equal(safeSetItem('x', '1', storage), false);
  assert.equal(setCached('x', {}, 100, 'test', storage, 1000), null);
  assert.equal(backupHoldings([], storage), false);
});
