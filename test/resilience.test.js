import test from 'node:test';
import assert from 'node:assert/strict';
import { runStartupIntegrityChecks } from '../js/resilience.js';

function memoryStorage(values = {}) {
  const data = new Map(Object.entries(values));
  return {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    key(index) { return [...data.keys()][index] ?? null; },
    get length() { return data.size; },
  };
}

test('startup integrity checks preserve semantically invalid holdings instead of overwriting them with zeroes', () => {
  const raw = JSON.stringify([{ code: '000001', name: '原始记录', shares: 'not-a-number', cost: 1 }]);
  const storage = memoryStorage({ fuyu_holdings_v1: raw });
  const result = runStartupIntegrityChecks(storage, Date.parse('2026-08-08T00:00:00Z'));

  assert.equal(result.recoverySource, 'legacy_corrupt');
  assert.equal(result.preservePrimary, true);
  assert.equal(result.transactionBlocked, true);
  assert.equal(storage.getItem('fuyu_holdings_v1'), raw);
  assert.equal(storage.getItem('fuyu_corrupt_holdings_last_v1'), raw);
});

test('startup recovers a corrupt legacy projection only through a verified repository backup', () => {
  const raw = '{broken';
  const storage = memoryStorage({
    fuyu_holdings_v1: raw,
    fuyu_backup_latest: JSON.stringify({
      created_at: '2026-08-01T00:00:00.000Z',
      holdings: [{
        code: '000002', name: '备份基金', shares: 2, cost: null,
        updated_at: '2026-08-01T00:00:00.000Z', deleted: false,
      }],
    }),
  });

  const result = runStartupIntegrityChecks(storage, Date.parse('2026-08-08T00:00:00Z'));

  assert.equal(result.recovered, true);
  assert.equal(result.recoverySource, 'legacy_backup_recovered');
  assert.equal(result.transactionBlocked, false);
  assert.ok(storage.getItem('fuyu_holdings_v3'));
  assert.equal(JSON.parse(storage.getItem('fuyu_holdings_v1'))[0].code, '000002');
});
