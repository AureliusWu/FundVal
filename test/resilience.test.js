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

  assert.equal(result.recoverySource, 'semantic_invalid');
  assert.equal(result.preservePrimary, true);
  assert.equal(storage.getItem('fuyu_holdings_v1'), raw);
  assert.equal(storage.getItem('fuyu_corrupt_holdings_last_v1'), raw);
});
