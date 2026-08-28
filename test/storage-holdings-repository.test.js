import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalHoldingsDocument,
  normalizeHoldingsDocumentV3,
  stableHoldingId,
} from '../js/storage/holdings-schema.js';
import {
  HOLDINGS_BACKUP_LATEST_KEY,
  HOLDINGS_DEVICE_KEY,
  HOLDINGS_JOURNAL_KEY,
  HOLDINGS_PROJECTION_META_KEY,
  HOLDINGS_V1_COMPAT_KEY,
  HOLDINGS_V3_KEY,
  getOrCreateDeviceId,
  loadHoldingsRepository,
  persistHoldingsDocument,
  reconcileLegacyHoldings,
  recoverPendingRepositoryTransaction,
  saveLegacyHoldingsTransaction,
} from '../js/storage/holdings-repository.js';

const T0 = '2026-08-20T00:00:00.000Z';
const T1 = '2026-08-21T00:00:00.000Z';
const T2 = '2026-08-22T00:00:00.000Z';

function memoryStorage(initial = {}, hooks = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    values,
    getItem(key) {
      if (hooks.getItem) return hooks.getItem({ key, values });
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (hooks.setItem) return hooks.setItem({ key, value: String(value), values });
      values.set(key, String(value));
    },
    removeItem(key) {
      if (hooks.removeItem) return hooks.removeItem({ key, values });
      values.delete(key);
    },
  };
}

function holding(code, overrides = {}) {
  return {
    id: stableHoldingId(code),
    fundCode: code,
    fundName: `基金${code}`,
    shares: 10,
    costNav: 1.25,
    createdAt: T0,
    updatedAt: T1,
    deletedAt: null,
    revision: 1,
    deviceId: 'device:test',
    note: null,
    ...overrides,
  };
}

function document(holdings, overrides = {}) {
  return normalizeHoldingsDocumentV3({
    schema: 3,
    updatedAt: T2,
    deviceId: 'device:test',
    holdings,
    ...overrides,
  });
}

test('device id is generated once, persisted, and reused', () => {
  const storage = memoryStorage();
  let calls = 0;
  const generate = () => {
    calls += 1;
    return 'device:stable';
  };

  assert.equal(getOrCreateDeviceId(storage, generate), 'device:stable');
  assert.equal(getOrCreateDeviceId(storage, generate), 'device:stable');
  assert.equal(storage.getItem(HOLDINGS_DEVICE_KEY), 'device:stable');
  assert.equal(calls, 1);
});

test('persistence backs up prior state and verifies V3 and V1 readback', () => {
  const priorV3 = canonicalHoldingsDocument(document([holding('001001', { shares: 1 })]));
  const priorV1 = JSON.stringify([{ code: '001001', name: '旧值', shares: 1, cost: 1 }]);
  const storage = memoryStorage({
    [HOLDINGS_V3_KEY]: priorV3,
    [HOLDINGS_V1_COMPAT_KEY]: priorV1,
  });
  const next = document([holding('001001', { shares: 2, revision: 2, updatedAt: T2 })]);

  const result = persistHoldingsDocument(storage, next, { now: T2 });
  assert.equal(result.ok, true);
  assert.equal(storage.getItem(HOLDINGS_V3_KEY), canonicalHoldingsDocument(next));
  assert.deepEqual(JSON.parse(storage.getItem(HOLDINGS_V1_COMPAT_KEY)), result.legacy);

  const backup = JSON.parse(storage.getItem(HOLDINGS_BACKUP_LATEST_KEY));
  assert.equal(backup.createdAt, T2);
  assert.equal(backup.v3Raw, priorV3);
  assert.equal(backup.v1Raw, priorV1);
});

test('backup failure causes zero canonical writes', () => {
  const priorV3 = canonicalHoldingsDocument(document([holding('001101')]));
  const priorV1 = JSON.stringify([{ code: '001101', name: '旧值', shares: 10, cost: 1.25 }]);
  let canonicalWrites = 0;
  const storage = memoryStorage({
    [HOLDINGS_V3_KEY]: priorV3,
    [HOLDINGS_V1_COMPAT_KEY]: priorV1,
  }, {
    setItem({ key, value, values }) {
      if (key === HOLDINGS_BACKUP_LATEST_KEY) throw new Error('disk full');
      if (key === HOLDINGS_V3_KEY || key === HOLDINGS_V1_COMPAT_KEY) canonicalWrites += 1;
      values.set(key, value);
    },
  });

  const result = persistHoldingsDocument(storage, document([
    holding('001101', { shares: 99, revision: 2, updatedAt: T2 }),
  ]), { now: T2 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'backup_failed');
  assert.equal(canonicalWrites, 0);
  assert.equal(storage.getItem(HOLDINGS_V3_KEY), priorV3);
  assert.equal(storage.getItem(HOLDINGS_V1_COMPAT_KEY), priorV1);
});

test('V3 readback corruption rolls both canonical keys back to their prior values', () => {
  const priorV3 = canonicalHoldingsDocument(document([holding('001201')]));
  const priorV1 = JSON.stringify([{ code: '001201', name: '旧值', shares: 10, cost: 1.25 }]);
  let v3Written = false;
  let readsAfterWrite = 0;
  const storage = memoryStorage({
    [HOLDINGS_V3_KEY]: priorV3,
    [HOLDINGS_V1_COMPAT_KEY]: priorV1,
  }, {
    setItem({ key, value, values }) {
      values.set(key, value);
      if (key === HOLDINGS_V3_KEY && value !== priorV3) {
        v3Written = true;
        readsAfterWrite = 0;
      }
    },
    getItem({ key, values }) {
      if (key === HOLDINGS_V3_KEY && v3Written) {
        readsAfterWrite += 1;
        if (readsAfterWrite === 2) return '{corrupt-after-write';
      }
      return values.get(key) ?? null;
    },
  });

  const result = persistHoldingsDocument(storage, document([
    holding('001201', { shares: 20, revision: 2, updatedAt: T2 }),
  ]), { now: T2 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'v3_readback_failed');
  assert.equal(storage.values.get(HOLDINGS_V3_KEY), priorV3);
  assert.equal(storage.values.get(HOLDINGS_V1_COMPAT_KEY), priorV1);
});

test('V1 compatibility write failure rolls a verified V3 write back', () => {
  const priorV3 = canonicalHoldingsDocument(document([holding('001301')]));
  const priorV1 = JSON.stringify([{ code: '001301', name: '旧值', shares: 10, cost: 1.25 }]);
  let blockCompat = true;
  const storage = memoryStorage({
    [HOLDINGS_V3_KEY]: priorV3,
    [HOLDINGS_V1_COMPAT_KEY]: priorV1,
  }, {
    setItem({ key, value, values }) {
      if (key === HOLDINGS_V1_COMPAT_KEY && blockCompat && value !== priorV1) return;
      values.set(key, value);
    },
  });

  const result = persistHoldingsDocument(storage, document([
    holding('001301', { shares: 30, revision: 2, updatedAt: T2 }),
  ]), { now: T2 });
  blockCompat = false;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'v1_compat_write_failed');
  assert.equal(storage.getItem(HOLDINGS_V3_KEY), priorV3);
  assert.equal(storage.getItem(HOLDINGS_V1_COMPAT_KEY), priorV1);
});

test('loading an old V1 array migrates it once and persists strict V3', () => {
  const storage = memoryStorage({
    [HOLDINGS_V1_COMPAT_KEY]: JSON.stringify([
      { code: '001401', name: '旧持仓', shares: 8, updated_at: T1 },
      { code: '001402', name: '零成本', shares: 0, cost: 0, updated_at: T1 },
    ]),
  });

  const first = loadHoldingsRepository(storage, {
    generateDeviceId: () => 'device:migrated',
    now: T2,
  });
  assert.equal(first.ok, true);
  assert.equal(first.reason, 'legacy_migrated');
  assert.equal(first.migrated, true);
  assert.equal(first.document.deviceId, 'device:migrated');
  assert.equal(first.document.holdings.find(item => item.fundCode === '001401').costNav, null);
  assert.equal(first.document.holdings.find(item => item.fundCode === '001402').costNav, 0);
  assert.ok(storage.getItem(HOLDINGS_V3_KEY));

  const second = loadHoldingsRepository(storage, {
    generateDeviceId: () => { throw new Error('must reuse persisted id'); },
    now: T2,
  });
  assert.equal(second.ok, true);
  assert.equal(second.reason, 'v3');
  assert.equal(second.migrated, false);
  assert.equal(canonicalHoldingsDocument(second.document), canonicalHoldingsDocument(first.document));
});

test('re-adding a tombstoned holding clears deletion and increments revision', () => {
  const tombstone = holding('001501', {
    shares: 5,
    revision: 3,
    updatedAt: T1,
    deletedAt: T1,
  });
  const current = document([tombstone], { updatedAt: T1 });

  const reconciled = reconcileLegacyHoldings([
    {
      code: '001501',
      name: tombstone.fundName,
      shares: 5,
      cost: 1.25,
      updated_at: T2,
      deleted: false,
    },
  ], current, { deviceId: 'device:test', now: T2, allowRestoreCodes: ['001501'] });

  assert.equal(reconciled.holdings[0].deletedAt, null);
  assert.equal(reconciled.holdings[0].revision, 4);
  assert.equal(reconciled.holdings[0].updatedAt, T2);
});

test('save transaction preserves current records absent from the submitted legacy array', () => {
  const current = document([
    holding('001601'),
    holding('001602'),
  ]);
  const storage = memoryStorage({
    [HOLDINGS_DEVICE_KEY]: 'device:test',
    [HOLDINGS_V3_KEY]: canonicalHoldingsDocument(current),
    [HOLDINGS_V1_COMPAT_KEY]: JSON.stringify([]),
  });

  const result = saveLegacyHoldingsTransaction(storage, [
    { code: '001601', name: '已编辑', shares: 11, cost: 1.25, updated_at: T2 },
  ], { now: T2 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.document.holdings.map(item => item.fundCode), ['001601', '001602']);
  assert.equal(result.document.holdings.find(item => item.fundCode === '001602').deletedAt, null);
});

test('a stale OCR-style legacy snapshot cannot overwrite a newer local record', () => {
  const initial = document([holding('001651')], { updatedAt: T1 });
  const storage = memoryStorage({ [HOLDINGS_DEVICE_KEY]: 'device:test' });
  assert.equal(persistHoldingsDocument(storage, initial, { now: T1 }).ok, true);

  const newer = document([holding('001651', {
    shares: 20,
    revision: 2,
    updatedAt: T2,
  })], { updatedAt: T2 });
  assert.equal(persistHoldingsDocument(storage, newer, {
    now: T2,
    expectedDocument: initial,
  }).ok, true);

  const staleImport = saveLegacyHoldingsTransaction(storage, [
    { code: '001651', name: '基金001651', shares: 10, cost: 1.25, updated_at: T1 },
  ], {
    now: T2,
    expectedDocument: initial,
  });

  assert.equal(staleImport.ok, false);
  assert.equal(staleImport.reason, 'stale_local_document');
  assert.equal(JSON.parse(storage.getItem(HOLDINGS_V3_KEY)).holdings[0].shares, 20);
});

test('a prepared partial journal rolls back only values owned by that transaction', () => {
  const storage = memoryStorage();
  const prior = document([holding('001701')]);
  const saved = persistHoldingsDocument(storage, prior, { now: T1 });
  assert.equal(saved.ok, true);
  const previous = {
    v3Raw: storage.getItem(HOLDINGS_V3_KEY),
    v1Raw: storage.getItem(HOLDINGS_V1_COMPAT_KEY),
    projectionMetaRaw: storage.getItem(HOLDINGS_PROJECTION_META_KEY),
  };
  const nextDocument = document([holding('001701', { shares: 20, revision: 2, updatedAt: T2 })]);
  const nextV3 = canonicalHoldingsDocument(nextDocument);
  const nextV1 = JSON.stringify([{
    code: '001701', name: '基金001701', shares: 20, cost: 1.25,
    updated_at: T2, deleted: false,
  }]);
  const nextMeta = JSON.stringify({ version: 1, v3Canonical: nextV3, v1Raw: nextV1 });
  storage.setItem(HOLDINGS_JOURNAL_KEY, JSON.stringify({
    version: 1,
    state: 'prepared',
    previous,
    next: { v3Raw: nextV3, v1Raw: nextV1, projectionMetaRaw: nextMeta },
  }));
  storage.setItem(HOLDINGS_V3_KEY, nextV3);

  assert.deepEqual(recoverPendingRepositoryTransaction(storage), { ok: true, state: 'rolled_back' });
  assert.equal(storage.getItem(HOLDINGS_V3_KEY), previous.v3Raw);
  assert.equal(storage.getItem(HOLDINGS_V1_COMPAT_KEY), previous.v1Raw);
  assert.equal(storage.getItem(HOLDINGS_JOURNAL_KEY), null);
});

test('journal recovery never rolls a foreign concurrent value back', () => {
  const storage = memoryStorage({
    [HOLDINGS_JOURNAL_KEY]: JSON.stringify({
      version: 1,
      state: 'prepared',
      previous: { v3Raw: 'old-v3', v1Raw: 'old-v1', projectionMetaRaw: null },
      next: { v3Raw: 'next-v3', v1Raw: 'next-v1', projectionMetaRaw: 'next-meta' },
    }),
    [HOLDINGS_V3_KEY]: 'foreign-v3',
    [HOLDINGS_V1_COMPAT_KEY]: 'next-v1',
    [HOLDINGS_PROJECTION_META_KEY]: 'next-meta',
  });

  const result = recoverPendingRepositoryTransaction(storage);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'concurrent_change_detected');
  assert.equal(storage.getItem(HOLDINGS_V3_KEY), 'foreign-v3');
  assert.ok(storage.getItem(HOLDINGS_JOURNAL_KEY));
});

test('a newer old-tab projection edit is reconciled once into a higher V3 revision', () => {
  const storage = memoryStorage({ [HOLDINGS_DEVICE_KEY]: 'device:test' });
  const current = document([holding('001801', { revision: 4, updatedAt: T1 })], { updatedAt: T1 });
  assert.equal(persistHoldingsDocument(storage, current, { now: T1 }).ok, true);
  storage.setItem(HOLDINGS_V1_COMPAT_KEY, JSON.stringify([{
    code: '001801', name: '基金001801', shares: 18, cost: 1.25,
    updated_at: T2, deleted: false,
  }]));

  const loaded = loadHoldingsRepository(storage, { now: T2 });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.reason, 'compat_projection_reconciled');
  assert.equal(loaded.document.holdings[0].shares, 18);
  assert.equal(loaded.document.holdings[0].revision, 5);
});

test('an old-tab active projection cannot revive a V3 tombstone', () => {
  const storage = memoryStorage({ [HOLDINGS_DEVICE_KEY]: 'device:test' });
  const current = document([holding('001901', {
    revision: 4,
    updatedAt: T1,
    deletedAt: T1,
  })], { updatedAt: T1 });
  assert.equal(persistHoldingsDocument(storage, current, { now: T1 }).ok, true);
  storage.setItem(HOLDINGS_V1_COMPAT_KEY, JSON.stringify([{
    code: '001901', name: '基金001901', shares: 10, cost: 1.25,
    updated_at: T2, deleted: false,
  }]));

  const loaded = loadHoldingsRepository(storage, { now: T2 });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.document.holdings[0].deletedAt, T1);
  assert.equal(loaded.document.holdings[0].revision, 4);
});
