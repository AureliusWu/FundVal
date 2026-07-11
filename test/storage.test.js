import test from 'node:test';
import assert from 'node:assert/strict';
import { getCached, makeCloudPayload, parseCloudPayload, setCached } from '../js/storage.js';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('reads legacy cloud arrays and writes schema 2', () => {
  assert.equal(parseCloudPayload([{ code: '000001' }]).schema, 1);
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
