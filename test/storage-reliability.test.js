import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalHoldingsDocument, normalizeHoldingsDocumentV3, toLegacyHoldings } from '../js/storage/holdings-schema.js';
import { parseAndMigrateHoldings } from '../js/storage/holdings-migration.js';
import {
  HOLDINGS_BACKUP_LATEST_KEY, HOLDINGS_BACKUP_PREVIOUS_KEY, HOLDINGS_CLOUD_BACKUP_LATEST_KEY,
  HOLDINGS_DEVICE_KEY, HOLDINGS_JOURNAL_KEY, HOLDINGS_LOCK_NAME, HOLDINGS_PROJECTION_META_KEY,
  HOLDINGS_V1_COMPAT_KEY, HOLDINGS_V3_KEY, backupCloudSyncSnapshot, backupRepositoryState,
  loadHoldingsRepository, persistHoldingsDocument, reconcileLegacyHoldings,
  recoverPendingRepositoryTransaction, saveLegacyHoldingsTransaction, withHoldingsLock,
} from '../js/storage/holdings-repository.js';
import { runStartupIntegrityChecks, runStartupIntegrityChecksLocked } from '../js/resilience.js';

const T0 = '2026-09-20T00:00:00.000Z';
const T1 = '2026-09-21T00:00:00.000Z';
const T2 = '2026-09-22T00:00:00.000Z';

function doc(overrides = {}) {
  return normalizeHoldingsDocumentV3({
    schema: 3, updatedAt: T1, deviceId: 'device:test', holdings: [{
      id: 'fund:001001', fundCode: '001001', fundName: '合成测试基金', shares: 10,
      costNav: null, note: '应保留的备注', createdAt: T0, updatedAt: T1,
      revision: 4, deletedAt: null, deviceId: 'device:test', ...overrides,
    }],
  });
}

function memoryStorage(initial = {}, hooks = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { hooks.setItem?.(key, String(value)); data.set(key, String(value)); },
    removeItem(key) { hooks.removeItem?.(key); data.delete(key); },
    key(index) { return [...data.keys()][index] ?? null; },
    get length() { return data.size; },
  };
}

function snapshot(document) {
  const v3Raw = canonicalHoldingsDocument(document);
  const v1Raw = JSON.stringify(toLegacyHoldings(document));
  return { v3Raw, v1Raw, projectionMetaRaw: JSON.stringify({ version: 1, v3Canonical: v3Raw, v1Raw }) };
}

function seeded(document = doc(), hooks) {
  const value = snapshot(document);
  return memoryStorage({
    [HOLDINGS_DEVICE_KEY]: 'device:test', [HOLDINGS_V3_KEY]: value.v3Raw,
    [HOLDINGS_V1_COMPAT_KEY]: value.v1Raw, [HOLDINGS_PROJECTION_META_KEY]: value.projectionMetaRaw,
  }, hooks);
}

function serialLocks() {
  let tail = Promise.resolve();
  return { request(name, options, callback) {
    assert.equal(name, HOLDINGS_LOCK_NAME);
    assert.deepEqual(options, { mode: 'exclusive' });
    const next = tail.then(() => callback({ name }));
    tail = next.catch(() => {});
    return next;
  } };
}

for (const primaryKey of [HOLDINGS_V3_KEY, HOLDINGS_V1_COMPAT_KEY]) {
  test(`future schema in ${primaryKey} blocks recovery, backups and writes without changing any bytes`, () => {
    const current = doc();
    const storage = seeded(current);
    storage.setItem(primaryKey, JSON.stringify({ schema: 4, holdings: [], opaque: 'preserve' }));
    storage.setItem(HOLDINGS_BACKUP_LATEST_KEY, JSON.stringify(snapshot(current)));
    storage.setItem(HOLDINGS_BACKUP_PREVIOUS_KEY, 'older backup');
    storage.setItem(HOLDINGS_CLOUD_BACKUP_LATEST_KEY, 'cloud backup');
    const before = [...storage.data];

    for (const result of [recoverPendingRepositoryTransaction(storage), loadHoldingsRepository(storage),
      persistHoldingsDocument(storage, current), saveLegacyHoldingsTransaction(storage, toLegacyHoldings(current)),
      backupCloudSyncSnapshot(storage, { local: current })]) {
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'future_schema_readonly');
      assert.equal(result.document, null);
    }
    assert.equal(backupRepositoryState(storage), false);
    const integrity = runStartupIntegrityChecks(storage, Date.parse(T2));
    assert.equal(integrity.readonly, true);
    assert.equal(integrity.transactionBlocked, true);
    assert.deepEqual([...storage.data], before);
  });
}

test('future schema inside a journal cannot be rolled back to the old schema', () => {
  const storage = seeded();
  const previous = snapshot(doc());
  const next = { ...previous, v3Raw: JSON.stringify({ schema: 4, holdings: [] }) };
  storage.setItem(HOLDINGS_JOURNAL_KEY, JSON.stringify({ version: 1, state: 'prepared', previous, next }));
  const before = [...storage.data];
  assert.equal(recoverPendingRepositoryTransaction(storage).reason, 'future_schema_readonly');
  assert.equal(loadHoldingsRepository(storage).reason, 'future_schema_readonly');
  assert.deepEqual([...storage.data], before);
});

test('legacy round trips preserve note, revisions, timestamps and device ownership', () => {
  const current = doc();
  const legacy = toLegacyHoldings(current);
  assert.equal(legacy[0].note, current.holdings[0].note);
  const result = reconcileLegacyHoldings(legacy, current, { now: T2, deviceId: 'device:other' });
  assert.equal(canonicalHoldingsDocument(result), canonicalHoldingsDocument(current));
  const oldProjection = legacy.map(({ note, ...item }) => item);
  const edited = reconcileLegacyHoldings(oldProjection.map(item => ({ ...item, shares: 20 })), current, { now: T2 });
  assert.equal(edited.holdings[0].note, current.holdings[0].note);
  assert.equal(edited.holdings[0].revision, 5);
  assert.equal(reconcileLegacyHoldings([{ ...legacy[0], note: null }], current, { now: T2 }).holdings[0].note, null);
  assert.equal(current.holdings[0].shares, 10);
});

test('missing or malformed holding numbers never become zero during migration or saving', () => {
  for (const value of [null, undefined, '', ' ', true, false, [], {}]) {
    const row = { code: '001001', name: '测试', shares: value, cost: null };
    assert.equal(parseAndMigrateHoldings([row]).ok, false);
    assert.throws(() => reconcileLegacyHoldings([row], doc()), /shares must be non-negative/);
  }
  for (const cost of [false, true, ' ', [], {}]) {
    const row = { code: '001001', name: '测试', shares: 0, cost };
    assert.equal(parseAndMigrateHoldings([row]).ok, false);
    assert.throws(() => reconcileLegacyHoldings([row], doc()), /costNav must be non-negative/);
  }
  assert.equal(parseAndMigrateHoldings([{ code: '001001', shares: 0, cost: 0 }]).document.holdings[0].costNav, 0);
});

for (const failedKey of [HOLDINGS_BACKUP_LATEST_KEY, HOLDINGS_JOURNAL_KEY, HOLDINGS_V3_KEY,
  HOLDINGS_V1_COMPAT_KEY, HOLDINGS_PROJECTION_META_KEY]) {
  test(`quota failure at ${failedKey} never publishes the candidate document`, () => {
    const initial = doc();
    let fail = true;
    const storage = seeded(initial, { setItem(key) {
      if (key === failedKey && fail) { fail = false; throw new Error('synthetic quota failure'); }
    } });
    const before = snapshot(initial);
    const candidate = toLegacyHoldings(initial).map(row => ({ ...row, shares: 999, updated_at: T2 }));
    const result = saveLegacyHoldingsTransaction(storage, candidate, { expectedDocument: initial, now: T2 });
    assert.equal(result.ok, false);
    assert.equal(result.document, null);
    assert.equal(storage.getItem(HOLDINGS_V3_KEY), before.v3Raw);
    assert.equal(storage.getItem(HOLDINGS_V1_COMPAT_KEY), before.v1Raw);
    assert.equal(storage.getItem(HOLDINGS_PROJECTION_META_KEY), before.projectionMetaRaw);
    assert.equal(initial.holdings[0].shares, 10);
    assert.equal(loadHoldingsRepository(storage).document.holdings[0].shares, 10);
  });
}

test('failed journal finalization restores the old document and leaves only recoverable state', () => {
  let fail = true;
  const initial = doc();
  const storage = seeded(initial, { removeItem(key) {
    if (key === HOLDINGS_JOURNAL_KEY && fail) throw new Error('synthetic remove failure');
  } });
  const result = persistHoldingsDocument(storage, doc({ shares: 99, revision: 5 }), { now: T2 });
  assert.equal(result.ok, false);
  assert.equal(result.document, null);
  assert.equal(result.recoveryRequired, true);
  assert.equal(storage.getItem(HOLDINGS_V3_KEY), canonicalHoldingsDocument(initial));
  fail = false;
  assert.deepEqual(recoverPendingRepositoryTransaction(storage), { ok: true, state: 'not_applied' });
  assert.equal(loadHoldingsRepository(storage).document.holdings[0].shares, 10);
});

test('missing, failed and rejected Web Locks never execute an unlocked callback', async () => {
  let called = false;
  const callback = () => { called = true; };
  assert.equal((await withHoldingsLock(callback, { locks: null })).reason, 'storage_lock_unavailable');
  assert.equal((await withHoldingsLock(callback, { locks: { request() { throw new Error('denied'); } } })).reason, 'storage_lock_failed');
  assert.equal((await withHoldingsLock(callback, { locks: { request: async (_, __, fn) => fn(null) } })).reason, 'storage_lock_unavailable');
  assert.equal(called, false);
  const storage = seeded();
  const before = [...storage.data];
  assert.equal((await runStartupIntegrityChecksLocked(storage, Date.parse(T2), { locks: null })).reason, 'storage_lock_unavailable');
  assert.deepEqual([...storage.data], before);
});

test('another tab waits for the active journal owner, then stale edits are rejected', async () => {
  const locks = serialLocks();
  const initial = doc();
  const storage = seeded(initial);
  const previous = snapshot(initial);
  const nextDocument = doc({ shares: 20, revision: 5 });
  const next = snapshot(nextDocument);
  let resume;
  const barrier = new Promise(resolve => { resume = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let secondEntered = false;
  const first = withHoldingsLock(async () => {
    storage.setItem(HOLDINGS_JOURNAL_KEY, JSON.stringify({ version: 1, state: 'prepared', previous, next }));
    storage.setItem(HOLDINGS_V3_KEY, next.v3Raw);
    entered();
    await barrier;
    assert.equal(secondEntered, false);
    assert.equal(storage.getItem(HOLDINGS_V3_KEY), next.v3Raw);
    storage.setItem(HOLDINGS_V1_COMPAT_KEY, next.v1Raw);
    storage.setItem(HOLDINGS_PROJECTION_META_KEY, next.projectionMetaRaw);
    return recoverPendingRepositoryTransaction(storage);
  }, { locks });
  await started;
  const second = withHoldingsLock(() => {
    secondEntered = true;
    const result = loadHoldingsRepository(storage);
    assert.equal(result.document.holdings[0].shares, 20);
    return saveLegacyHoldingsTransaction(storage, toLegacyHoldings(initial), { expectedDocument: initial, now: T2 });
  }, { locks });
  await Promise.resolve();
  assert.equal(secondEntered, false);
  resume();
  assert.equal((await first).state, 'finalized');
  const result = await second;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_local_document');
  assert.equal(loadHoldingsRepository(storage).document.holdings[0].shares, 20);
});
