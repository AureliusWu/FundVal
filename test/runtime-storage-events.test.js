import test from 'node:test';
import assert from 'node:assert/strict';
import { installRuntimeGuards } from '../js/resilience.js';
import { canonicalHoldingsDocument, normalizeHoldingsDocumentV3, toLegacyHoldings } from '../js/storage/holdings-schema.js';
import {
  HOLDINGS_DEVICE_KEY, HOLDINGS_JOURNAL_KEY, HOLDINGS_PROJECTION_META_KEY,
  HOLDINGS_V1_COMPAT_KEY, HOLDINGS_V3_KEY,
} from '../js/storage/holdings-repository.js';

const T0 = '2026-09-20T00:00:00.000Z';
const T1 = '2026-09-21T00:00:00.000Z';
const HOLDINGS_EVENT_KEYS = [HOLDINGS_JOURNAL_KEY, HOLDINGS_V3_KEY, HOLDINGS_V1_COMPAT_KEY];

function snapshot(shares, revision, updatedAt) {
  const document = normalizeHoldingsDocumentV3({
    schema: 3, deviceId: 'device:synthetic-runtime-test', updatedAt,
    holdings: [{
      id: 'fund:005844', fundCode: '005844', fundName: '合成跨标签页测试基金',
      shares, costNav: 1.2, note: null, createdAt: T0, updatedAt, revision,
      deletedAt: null, deviceId: 'device:synthetic-runtime-test',
    }],
  });
  const v3Raw = canonicalHoldingsDocument(document);
  const v1Raw = JSON.stringify(toLegacyHoldings(document));
  return { v3Raw, v1Raw, projectionMetaRaw: JSON.stringify({ version: 1, v3Canonical: v3Raw, v1Raw }) };
}

function storageValues(value) {
  return {
    [HOLDINGS_DEVICE_KEY]: 'device:synthetic-runtime-test',
    [HOLDINGS_V3_KEY]: value.v3Raw,
    [HOLDINGS_V1_COMPAT_KEY]: value.v1Raw,
    [HOLDINGS_PROJECTION_META_KEY]: value.projectionMetaRaw,
  };
}

/**
 * The authoritative store represents tab B's already completed transaction.
 * Tab A reads a delayed renderer view; local writes synchronously update both
 * views. This deliberately does not assume that acquiring a Web Lock flushes
 * localStorage notifications from another renderer.
 */
function delayedRendererStorage(authoritativeValues, rendererValues = authoritativeValues) {
  const authoritative = new Map(Object.entries(authoritativeValues));
  const renderer = new Map(Object.entries(rendererValues));
  const reads = [];
  const mutations = [];
  const storage = {
    getItem(key) { reads.push(key); return renderer.get(key) ?? null; },
    setItem(key, value) {
      const raw = String(value);
      mutations.push({ operation: 'set', key });
      renderer.set(key, raw);
      authoritative.set(key, raw);
    },
    removeItem(key) {
      mutations.push({ operation: 'remove', key });
      renderer.delete(key);
      authoritative.delete(key);
    },
    key(index) { return [...renderer.keys()][index] ?? null; },
    get length() { return renderer.size; },
  };
  return { storage, authoritative, renderer, reads, mutations };
}

function fakeBrowser(t) {
  const listeners = new Map();
  const lockRequests = [];
  const timers = [];
  const classes = new Set();
  const toast = {
    textContent: '', style: {}, onclick: null,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
  };
  let lockTail = Promise.resolve();
  const replacements = {
    window: { addEventListener(name, callback) {
      const callbacks = listeners.get(name) || [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
    } },
    document: {
      readyState: 'complete', documentElement: { dataset: {} },
      getElementById: id => id === 'toast' ? toast : null,
      addEventListener() {},
    },
    navigator: { onLine: true, locks: { request(name, options, callback) {
      lockRequests.push({ name, mode: options.mode });
      const result = lockTail.then(() => callback({ name }));
      lockTail = result.catch(() => {});
      return result;
    } } },
    location: { reload() { throw new Error('storage notifications must not automatically reload'); } },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
  };
  const originals = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    toast, classes, lockRequests,
    async storageEvent(event) {
      for (const listener of listeners.get('storage') || []) await listener(event);
    },
  };
}

for (const key of HOLDINGS_EVENT_KEYS) {
  test(`runtime ${key} notification must not read, recover or write the holdings repository`, async t => {
    const browser = fakeBrowser(t);
    const fixture = delayedRendererStorage(storageValues(snapshot(200, 2, T1)));
    installRuntimeGuards(fixture.storage);
    fixture.reads.length = 0;
    fixture.mutations.length = 0;

    await browser.storageEvent({ key, storageArea: fixture.storage, newValue: fixture.renderer.get(key) ?? null });

    assert.deepEqual(fixture.mutations, [], 'a notification must never mutate storage');
    assert.deepEqual(browser.lockRequests, [], 'a notification must never enter a repository recovery/write lock');
    assert.deepEqual(fixture.reads, [], 'the event handler must not inspect a potentially mixed renderer snapshot');
    assert.match(browser.toast.textContent, /其他页面更新持仓/);
    assert.equal(typeof browser.toast.onclick, 'function');
  });

  test(`delayed ${key} notification cannot roll a committed 200-share holding back to 100`, async t => {
    const browser = fakeBrowser(t);
    const previous = snapshot(100, 1, T0);
    const next = snapshot(200, 2, T1);
    const preparedJournal = JSON.stringify({ version: 1, state: 'prepared', createdAt: T1, previous, next });
    const fixture = delayedRendererStorage(storageValues(next), {
      ...storageValues(previous),
      [HOLDINGS_V3_KEY]: next.v3Raw,
      [HOLDINGS_JOURNAL_KEY]: preparedJournal,
    });
    const committedBeforeEvent = [...fixture.authoritative];
    installRuntimeGuards(fixture.storage);
    fixture.reads.length = 0;
    fixture.mutations.length = 0;

    await browser.storageEvent({ key, storageArea: fixture.storage, newValue: fixture.renderer.get(key) ?? null });

    const committed = JSON.parse(fixture.authoritative.get(HOLDINGS_V3_KEY)).holdings[0];
    assert.equal(committed.shares, 200,
      'tab B already committed 200 shares; tab A must not persist its stale prepared.previous snapshot');
    assert.equal(committed.revision, 2);
    assert.equal(committed.updatedAt, T1);
    assert.deepEqual([...fixture.authoritative], committedBeforeEvent, 'preserve every committed byte');
    assert.deepEqual(fixture.mutations, [], 'mixed renderer snapshots are not a runtime repair authority');
    assert.deepEqual(browser.lockRequests, []);
    assert.match(browser.toast.textContent, /其他页面更新持仓/);
  });
}

test('unrelated storage notification does not touch the repository or display a holding notice', async t => {
  const browser = fakeBrowser(t);
  const fixture = delayedRendererStorage(storageValues(snapshot(200, 2, T1)));
  installRuntimeGuards(fixture.storage);
  fixture.reads.length = 0;

  await browser.storageEvent({ key: 'unrelated-setting', storageArea: fixture.storage, newValue: 'synthetic' });

  assert.deepEqual(fixture.reads, []);
  assert.deepEqual(fixture.mutations, []);
  assert.deepEqual(browser.lockRequests, []);
  assert.equal(browser.toast.textContent, '');
});
