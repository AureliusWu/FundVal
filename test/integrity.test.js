import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendDiagnostic,
  collectOrphanNavCacheKeys,
  normalizeHoldings,
  reconcileFundCache,
  repairHoldingsState
} from '../js/integrity.js';

const NOW = '2026-07-15T04:00:00.000Z';

test('normalizes holdings and keeps the newest duplicate', () => {
  const result = normalizeHoldings([
    { code: '000001', name: '旧', shares: -1, updated_at: '2026-01-01T00:00:00Z' },
    { code: '000001', name: '新', shares: 2, updated_at: '2026-07-01T00:00:00Z' },
    { code: 'bad' }
  ], NOW);
  assert.deepEqual(result, [{
    code: '000001', name: '新', shares: 2, cost: 0,
    updated_at: '2026-07-01T00:00:00.000Z', deleted: false
  }]);
});

test('prefers tombstone when duplicate timestamps are equal', () => {
  const result = normalizeHoldings([
    { code: '000001', updated_at: NOW, deleted: false },
    { code: '000001', updated_at: NOW, deleted: true }
  ], NOW);
  assert.equal(result[0].deleted, true);
});

test('recovers corrupt primary holdings from latest backup', () => {
  const result = repairHoldingsState({
    primaryRaw: '{broken',
    latestBackupRaw: JSON.stringify({ holdings: [{ code: '000001', name: '恢复' }] }),
    previousBackupRaw: null,
    nowISO: NOW
  });
  assert.equal(result.recovered, true);
  assert.equal(result.source, 'latest_backup');
  assert.equal(result.holdings[0].name, '恢复');
});

test('removes deleted or unrelated funds from the persisted cache', () => {
  const result = reconcileFundCache(JSON.stringify({
    data: [{ code: '000001' }, { code: '000002' }],
    fetchedAt: 1000,
    expiresAt: 2000
  }), new Set(['000002']), 1500);
  assert.equal(result.remove, false);
  assert.deepEqual(result.cache.data, [{ code: '000002' }]);
});

test('rejects cache timestamps implausibly far in the future', () => {
  const result = reconcileFundCache({ data: [{ code: '000001' }], fetchedAt: 9999999 }, ['000001'], 1000, 100);
  assert.equal(result.remove, true);
});

test('finds only orphan per-fund cache keys', () => {
  assert.deepEqual(
    collectOrphanNavCacheKeys(['fuyu_nav_move_000001', 'fuyu_nav_move_000002', 'other'], ['000002']),
    ['fuyu_nav_move_000001']
  );
});

test('diagnostics redact tokens and retain a bounded history', () => {
  const raw = JSON.stringify([{ time: NOW, type: 'old', message: 'old', stack: '' }]);
  const result = appendDiagnostic(raw, { type: 'error', message: 'ghp_abcdefghijklmnopqrstuvwxyz1234' }, 1);
  assert.equal(result.length, 1);
  assert.match(result[0].message, /REDACTED_GITHUB_TOKEN/);
});
