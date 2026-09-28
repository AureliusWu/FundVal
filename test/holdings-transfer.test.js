import test from 'node:test';
import assert from 'node:assert/strict';
import { createHoldingsTransfer } from '../js/runtime/holdings-transfer.js';
import { canonicalHoldingsDocument, normalizeHoldingsDocumentV3, toLegacyHoldings } from '../js/storage/holdings-schema.js';
import { HOLDINGS_BACKUP_LATEST_KEY, HOLDINGS_V3_KEY, persistHoldingsDocument } from '../js/storage/holdings-repository.js';

const T0 = '2026-09-21T00:00:00.000Z';
const T1 = '2026-09-22T00:00:00.000Z';
function doc(shares = 10, revision = 1) {
  return normalizeHoldingsDocumentV3({ schema: 3, deviceId: 'device:synthetic', updatedAt: T1, holdings: [{
    id: 'fund:005844', fundCode: '005844', fundName: '合成测试基金', shares, costNav: null,
    createdAt: T0, updatedAt: revision === 1 ? T0 : T1, revision, deletedAt: null,
    deviceId: 'device:synthetic', note: '备注',
  }] });
}

function fixture(t, options = {}) {
  const data = new Map();
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem(key, value) { options.beforeSet?.(key); data.set(key, String(value)); },
    removeItem: key => data.delete(key),
  };
  assert.equal(persistHoldingsDocument(storage, doc()).ok, true);
  const setGlobal = (key, value) => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => prior ? Object.defineProperty(globalThis, key, prior) : delete globalThis[key]);
  };
  setGlobal('localStorage', storage);
  setGlobal('navigator', { locks: options.locks || { request: async (_, __, fn) => fn({ name: 'synthetic' }) } });
  let reader;
  setGlobal('FileReader', class {
    constructor() { reader = this; }
    readAsText(file) { this.file = file; }
  });
  let installed = options.unreadable ? null : doc();
  const toasts = [];
  let pushes = 0;
  let installs = 0;
  const transfer = createHoldingsTransfer({
    getHoldingsDocument: () => installed,
    getHoldings: () => toLegacyHoldings(installed),
    installHoldingsDocument(value) { installed = value; installs += 1; },
    scheduleAutoPush() { pushes += 1; }, renderHoldingsList() {}, refresh() {},
    showToast: message => toasts.push(message), CACHE_KEY: 'fuyu_test_cache',
  });
  async function importDocument(value) {
    const file = { synthetic: true };
    const target = { files: [file], value: 'selected' };
    transfer.importData({ target });
    assert.equal(target.value, '');
    assert.equal(reader.file, file);
    await reader.onload({ target: { result: JSON.stringify(value) } });
  }
  return { data, storage, transfer, importDocument, toasts,
    get installed() { return installed; }, get pushes() { return pushes; }, get installs() { return installs; } };
}

test('lazy transfer module imports a verified document and installs only the saved result', async t => {
  const f = fixture(t);
  await f.importDocument(doc(20, 2));
  assert.equal(f.installed.holdings[0].shares, 20);
  assert.equal(f.installed.holdings[0].note, '备注');
  assert.equal(f.storage.getItem(HOLDINGS_V3_KEY), canonicalHoldingsDocument(f.installed));
  assert.equal(f.pushes, 1);
  assert.equal(f.installs, 1);
});

test('lazy export entry produces Schema 3 JSON without changing local holdings', async t => {
  const f = fixture(t);
  const before = [...f.data];
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let blob;
  let clicked = false;
  const anchor = { href: '', download: '', click() { clicked = true; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag) { assert.equal(tag, 'a'); return anchor; },
  } });
  t.after(() => prior ? Object.defineProperty(globalThis, 'document', prior) : delete globalThis.document);
  t.mock.method(URL, 'createObjectURL', value => { blob = value; return 'blob:synthetic-export'; });
  await f.transfer.exportData();
  assert.equal(clicked, true);
  assert.equal(anchor.download, 'fuyu-holdings.json');
  const payload = JSON.parse(await blob.text());
  assert.equal(payload.schema, 3);
  assert.equal(payload.holdings[0].shares, 10);
  assert.equal(payload.holdings[0].costNav, null);
  assert.equal(payload.holdings[0].note, '备注');
  assert.deepEqual([...f.data], before);
});

test('import rejects a newer schema and keeps both the saved and displayed holdings intact', async t => {
  const f = fixture(t);
  const before = f.storage.getItem(HOLDINGS_V3_KEY);
  await f.importDocument({ schema: 4, holdings: [] });
  assert.equal(f.storage.getItem(HOLDINGS_V3_KEY), before);
  assert.equal(f.installed.holdings[0].shares, 10);
  assert.equal(f.pushes, 0);
  assert.equal(f.installs, 0);
});

test('quota failure during import preserves the old UI and does not schedule a sync', async t => {
  let fail = false;
  const f = fixture(t, { beforeSet(key) {
    if (fail && key === HOLDINGS_BACKUP_LATEST_KEY) throw new Error('synthetic quota');
  } });
  const before = f.storage.getItem(HOLDINGS_V3_KEY);
  fail = true;
  await f.importDocument(doc(20, 2));
  assert.equal(f.storage.getItem(HOLDINGS_V3_KEY), before);
  assert.equal(f.installed.holdings[0].shares, 10);
  assert.equal(f.installs, 0);
  assert.equal(f.pushes, 0);
  assert.match(f.toasts.at(-1), /导入保存失败/);
});

test('import cannot overwrite an edit committed while it was waiting for the repository lock', async t => {
  let beforeLock;
  const f = fixture(t, { locks: { request: async (_, __, fn) => { beforeLock?.(); return fn({ name: 'synthetic' }); } } });
  beforeLock = () => {
    assert.equal(persistHoldingsDocument(f.storage, doc(30, 3)).ok, true);
  };
  await f.importDocument(doc(20, 2));
  assert.equal(JSON.parse(f.storage.getItem(HOLDINGS_V3_KEY)).holdings[0].shares, 30);
  assert.equal(f.installs, 0);
  assert.equal(f.pushes, 0);
});

test('manual restore installs a verified backup and schedules a sync', async t => {
  const f = fixture(t);
  f.storage.setItem(HOLDINGS_BACKUP_LATEST_KEY, JSON.stringify({ v3Raw: canonicalHoldingsDocument(doc(4)), v1Raw: null }));
  await f.transfer.restoreLatestBackup();
  assert.equal(f.installed.holdings[0].shares, 4);
  assert.equal(f.storage.getItem(HOLDINGS_V3_KEY), canonicalHoldingsDocument(f.installed));
  assert.equal(f.pushes, 1);
});

test('manual restore cannot overwrite a future-schema primary with an old backup', async t => {
  const f = fixture(t);
  const future = JSON.stringify({ schema: 4, holdings: [], opaque: 'preserve' });
  f.storage.setItem(HOLDINGS_BACKUP_LATEST_KEY, JSON.stringify({ v3Raw: canonicalHoldingsDocument(doc(4)) }));
  f.storage.setItem(HOLDINGS_V3_KEY, future);
  const before = [...f.data];
  await f.transfer.restoreLatestBackup();
  assert.deepEqual([...f.data], before);
  assert.equal(f.installs, 0);
  assert.equal(f.pushes, 0);
});

test('a readonly page cannot restore over a repair committed while waiting for its lock', async t => {
  let beforeLock;
  const f = fixture(t, { unreadable: true, locks: { request: async (_, __, callback) => {
    beforeLock();
    return callback({ name: 'synthetic' });
  } } });
  f.storage.setItem(HOLDINGS_V3_KEY, '{damaged');
  f.storage.setItem(HOLDINGS_BACKUP_LATEST_KEY, JSON.stringify({ v3Raw: canonicalHoldingsDocument(doc(4)) }));
  beforeLock = () => f.storage.setItem(HOLDINGS_V3_KEY, canonicalHoldingsDocument(doc(30, 3)));
  await f.transfer.restoreLatestBackup();
  assert.equal(f.storage.getItem(HOLDINGS_V3_KEY), canonicalHoldingsDocument(doc(30, 3)));
  assert.equal(f.installs, 0);
  assert.equal(f.pushes, 0);
  assert.match(f.toasts.at(-1), /其他页面已更新持仓/);
});

test('unreadable storage cannot masquerade as a missing restore baseline', async t => {
  const f = fixture(t, { unreadable: true });
  const before = [...f.data];
  f.storage.getItem = () => { throw new Error('synthetic access denied'); };
  await f.transfer.restoreLatestBackup();
  assert.deepEqual([...f.data], before);
  assert.equal(f.installs, 0);
  assert.equal(f.pushes, 0);
  assert.match(f.toasts.at(-1), /备份恢复失败/);
});

for (const future of [{ schema: 4, holdings: [] }, { schema: 4, renamedRecords: [] }]) {
  test(`manual restore refuses future backup bundles with ${Object.keys(future)[1]} instead of their old projection`, async t => {
    const f = fixture(t);
    f.storage.setItem(HOLDINGS_BACKUP_LATEST_KEY, JSON.stringify({
      v3Raw: JSON.stringify(future), v1Raw: JSON.stringify(toLegacyHoldings(doc(4))),
    }));
    f.storage.setItem('fuyu_backup_latest', JSON.stringify({ holdings: toLegacyHoldings(doc(3)) }));
    const before = [...f.data];
    await f.transfer.restoreLatestBackup();
    assert.deepEqual([...f.data], before);
    assert.equal(f.installs, 0);
    assert.equal(f.pushes, 0);
    assert.match(f.toasts.at(-1), /备份由较新版本创建/);
  });
}
