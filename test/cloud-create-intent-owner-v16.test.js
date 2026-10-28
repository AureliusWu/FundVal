import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/utils';
import { createCloudArchiveFeature } from '../js/storage/cloud-archive-ui.js';
import { createCloudCreateIntentStore, CLOUD_CREATE_INTENT_KEY as KEY } from '../js/storage/cloud-create-intent.js';
import { createSyncStatus } from '../js/runtime/sync-status.js';
import * as cloud from '../js/storage/cloud-sync.js';
import { normalizeHoldingsDocumentV3, stableHoldingId, canonicalHoldingsDocument } from '../js/storage/holdings-schema.js';
import { persistHoldingsDocument, HOLDINGS_DEVICE_KEY, HOLDINGS_LOCK_NAME, HOLDINGS_BACKUP_LATEST_KEY,
  HOLDINGS_CLOUD_BACKUP_LATEST_KEY } from '../js/storage/holdings-repository.js';
import { classifyGistHttpFailure, v3GistFilename } from '../js/storage/gist-remote.js';
import { createHoldingsTransfer } from '../js/runtime/holdings-transfer.js';
import { createDiagnosticsCenter } from '../js/runtime/diagnostics-ui.js';

const ID = 'a'.repeat(32), TIME = '2026-10-26T00:00:00.000Z';
const SECOND_NONCE = '22222222-2222-4222-8222-222222222222';
const value = normalizeHoldingsDocumentV3({ schema: 3, deviceId: 'synthetic-intent-device', updatedAt: TIME,
  holdings: [{ id: stableHoldingId('000001'), fundCode: '000001', fundName: '合成', shares: 10, costNav: null,
    createdAt: TIME, updatedAt: TIME, revision: 1, deviceId: 'synthetic-intent-device' }] });
const payload = cloud.makeCloudWritePayload(value, 3);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const digest = text => createHash('sha256').update(text).digest('hex');

function harness(t, options = {}) {
  const descriptors = Object.fromEntries(['localStorage', 'navigator', 'document', 'confirm'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const data = new Map([[HOLDINGS_DEVICE_KEY, value.deviceId]]), trace = [];
  const controls = { current: true, locked: false, posts: 0, locks: 0, intentReads: 0, intentWrites: 0,
    mode: options.mode || '', id: options.id || '', meta: {}, confirms: 0, pending: false, clock: Date.parse(TIME), seeded: false };
  const storage = {
    getItem(key) {
      if (key === KEY) {
        controls.intentReads++; trace.push(['intent-read', controls.locked]);
        if (controls.mode === 'read-denied' || controls.mode === 'write-read-denied' && controls.intentWrites) throw new Error('synthetic-private-storage');
        if (controls.mode === 'wrong-readback' && controls.intentWrites) return '{}';
      }
      return data.get(key) ?? null;
    },
    setItem(key, item) {
      if ([HOLDINGS_BACKUP_LATEST_KEY, HOLDINGS_CLOUD_BACKUP_LATEST_KEY].includes(key)) {
        trace.push(['backup-write', key]);
        if (controls.seeded && options.backupFail === key) throw new Error('synthetic-private-backup');
      }
      if (key === KEY) {
        controls.intentWrites++; trace.push(['intent-write', controls.locked, item]);
        if (controls.mode === 'write-denied') throw new Error('synthetic-private-storage');
        if (controls.mode === 'fake-write') return;
      }
      data.set(key, String(item));
    },
    removeItem(key) {
      if (key === KEY) {
        trace.push(['intent-remove', controls.locked]);
        if (controls.mode === 'remove-denied') throw new Error('synthetic-private-storage');
        if (controls.mode === 'fake-remove') return;
      }
      data.delete(key);
    },
    key: index => [...data.keys()][index] ?? null, get length() { return data.size; },
  };
  let tail = Promise.resolve();
  const locks = { request(name, settings, action) {
    assert.equal(name, HOLDINGS_LOCK_NAME); assert.deepEqual(settings, { mode: 'exclusive' });
    const ticket = ++controls.locks;
    const pending = tail.then(async () => {
      assert.equal(controls.locked, false); controls.locked = true; trace.push(['lock-enter', ticket]);
      try { options.beforeLock?.(ticket, controls, data); return await action({ name }); }
      finally { trace.push(['lock-exit', ticket]); controls.locked = false;
        if (ticket === 1 && options.invalidateAfterPreflight) controls.current = false;
      }
    });
    tail = pending.catch(() => {}); return pending;
  } };
  const elements = Object.fromEntries(['gist-token', 'gist-remember-token', 'cloud-upload-btn', 'cloud-download-btn', 'cloud-status']
    .map(key => [key, { value: '', checked: false, disabled: false, textContent: '', style: {} }]));
  elements['gist-token'].value = 'synthetic-never-sent';
  const dom = { getElementById: key => elements[key] };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom });
  Object.defineProperty(globalThis, 'confirm', { configurable: true, value: () => { controls.confirms++; trace.push('confirm'); return true; } });
  t.after(() => { for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  assert.equal(persistHoldingsDocument(storage, value, { now: TIME }).ok, true);
  controls.seeded = true;
  const holdingsBefore = digest(data.get('fuyu_holdings_v3')); trace.length = 0;
  if (options.raw !== undefined) data.set(KEY, options.raw);
  const signal = new AbortController().signal;
  const scope = { isCurrent: () => controls.current, signal,
    adoptGistId(id) { trace.push('adopt'); if (options.adoptFail) return false; controls.id = id; data.set('fuyu_gist_id', id); return true; } };
  const base = {
    CACHE_KEY: 'synthetic-cache', getHoldingsDocument: () => value, getHoldings: () => value.holdings,
    loadCloudSyncFeature: async () => cloud, loadGistRemoteModule: async () => ({ v3GistFilename, classifyGistHttpFailure }),
    nowISO: () => TIME,
    async fetchWithTimeout(url, request) {
      assert.equal(controls.locked, false, 'POST must never hold the repository lock');
      trace.push('POST'); controls.posts++;
      assert.equal(url, 'https://api.github.com/gists'); assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error'); assert.equal(request.signal, signal);
      assert.deepEqual(request.headers, { Authorization: 'token synthetic-never-sent', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' });
      assert.deepEqual(JSON.parse(request.body), { description: 'FundVal 持仓数据 | ' + TIME, public: false,
        files: { [v3GistFilename(value.deviceId)]: { content: JSON.stringify(payload, null, 2) } } });
      if (options.post) return options.post(controls, data);
      if (options.network) throw new Error('synthetic-private-network');
      return options.response || { ok: true, status: 201, async json() { return { id: ID }; } };
    },
    getGistId: () => controls.id, setGistId: scope.adoptGistId,
    async createGistRemoteAdapter() { trace.push('adapter'); return { async get() {
      assert.equal(controls.locked, false); trace.push('readback');
      return options.readback || { ok: true, raw: payload };
    } }; },
    loadSyncMeta: () => controls.meta,
    saveSyncMeta(meta) { trace.push('meta'); controls.meta = meta; return options.metaFail !== true; },
    setSyncTime() { trace.push('time'); return true; }, setSyncPending(pending) { controls.pending = pending; trace.push(['pending', pending]); },
    installHoldingsDocument() { trace.push('install'); }, setGistToken: async () => ({ ok: true }),
    clearGistCredentials: async () => { controls.id = ''; controls.meta = {}; data.delete('fuyu_gist_id'); data.delete('fuyu_sync_meta_v1'); return { ok: true, current: true }; },
    markSyncPending() { controls.pending = true; trace.push('pending'); }, renderCloudStatus() {}, showToast: message => trace.push(['toast', message]),
    startAutoPull() {}, resolveGistId: async () => ({ ok: false, reason: 'remote_archive_missing' }),
    runManualOperation: action => action(scope), getSyncStatus: () => ({ readFirst: false }), captureCloudConfigurationScope: () => scope,
    pushToCloud: async () => { trace.push('push'); return { ok: true, remoteVerified: true }; },
    pullFromCloud: async () => { trace.push('pull'); return { ok: true, remoteVerified: true }; },
  };
  const feature = createCloudArchiveFeature(base);
  assert.equal(controls.intentReads, 0, 'feature factory must be storage-lazy');
  return { feature, base, scope, data, trace, controls, elements, storage,
    run: () => feature.createCloudArchive('synthetic-never-sent', { targetSchema: 3, scope }),
    intent: () => createCloudCreateIntentStore().read(),
    holdingsUnchanged() { assert.equal(digest(data.get('fuyu_holdings_v3')), holdingsBefore); },
  };
}

function assertPreflight(trace) {
  const post = trace.indexOf('POST'); assert.ok(post > 0);
  assert.deepEqual(trace.slice(0, post).map(item => Array.isArray(item) ? item[0] : item),
    ['lock-enter', 'backup-write', 'backup-write', 'intent-read', 'intent-write', 'intent-read', 'lock-exit']);
  const write = trace.find(item => Array.isArray(item) && item[0] === 'intent-write');
  assert.equal(write[1], true);
}

test('actual owner persists exact preflight in original lock before lock-free POST; only verified final lock clears', async t => {
  const h = harness(t), result = await h.run();
  assert.deepEqual(result, { ok: true, gistId: ID, remoteVerified: true, pending: false });
  const write = h.trace.find(item => Array.isArray(item) && item[0] === 'intent-write');
  assert.equal(typeof write[2], 'string'); assert.deepEqual(Object.keys(JSON.parse(write[2])).sort(), ['createdAt', 'nonce', 'version']);
  const sequence = h.trace.map(item => Array.isArray(item) ? item[0] : item);
  assert.deepEqual(sequence, ['lock-enter', 'backup-write', 'backup-write', 'intent-read', 'intent-write', 'intent-read', 'lock-exit', 'POST',
    'adopt', 'adapter', 'readback', 'lock-enter', 'meta', 'time', 'pending', 'install', 'intent-read', 'intent-remove', 'intent-read', 'lock-exit']);
  assert.equal(h.trace.filter(item => Array.isArray(item) && item[0].startsWith('intent-')).every(item => item[1] === true), true);
  assert.equal(h.data.has(KEY), false); h.holdingsUnchanged();
  assert.equal(JSON.stringify(h.controls.meta).includes('nonce'), false);
  assert.equal(canonicalHoldingsDocument(value).includes('nonce'), false);
  assertPreflight(h.trace);
});
for (const key of [HOLDINGS_BACKUP_LATEST_KEY, HOLDINGS_CLOUD_BACKUP_LATEST_KEY]) {
  test('original backup must succeed before any intent preparation or POST: ' + key, async t => {
    const h = harness(t, { backupFail: key }); assert.equal((await h.run()).ok, false);
    assert.equal(h.controls.intentReads, 0); assert.equal(h.controls.intentWrites, 0); assert.equal(h.controls.posts, 0);
  });
}
for (const [name, mode, reason] of [
  ['read denial', 'read-denied', 'cloud_create_intent_read_failed'], ['write denial', 'write-denied', 'cloud_create_intent_write_failed'],
  ['fake write', 'fake-write', 'cloud_create_intent_write_failed'], ['write then read denial', 'write-read-denied', 'cloud_create_intent_write_failed'],
  ['wrong readback', 'wrong-readback', 'cloud_create_intent_write_failed'],
]) test('actual owner preflight failure makes zero POST: ' + name, async t => {
  const h = harness(t, { mode }); assert.deepEqual(await h.run(), { ok: false, reason });
  assert.equal(h.controls.posts, 0); assert.equal(h.trace.includes('adopt'), false); h.holdingsUnchanged();
});
for (const raw of ['{', JSON.stringify({ version: 2, nonce: SECOND_NONCE, createdAt: 1 }),
  JSON.stringify({ version: 1, nonce: SECOND_NONCE, createdAt: 1, token: 'synthetic-invalid-field' })]) {
  test('actual owner rejects existing malformed/future/extra metadata without overwrite', async t => {
    const h = harness(t, { raw }); assert.equal((await h.run()).reason, 'cloud_create_intent_invalid');
    assert.equal(h.controls.posts, 0); assert.equal(h.controls.intentWrites, 0); assert.equal(h.data.get(KEY), raw);
  });
}
test('two independent actual owners compete for one origin lock and only one may POST', async t => {
  const entered = deferred(), finish = deferred();
  const h = harness(t, { async post() { entered.resolve(); await finish.promise; return { ok: false, status: 503 }; } });
  const first = h.run(); await entered.promise;
  const second = createCloudArchiveFeature(h.base);
  assert.deepEqual(await second.createCloudArchive('synthetic-never-sent', { targetSchema: 3, scope: h.scope }),
    { ok: false, reason: 'cloud_create_intent_pending' });
  assert.equal(h.controls.posts, 1); finish.resolve(); assert.equal((await first).writeUnknown, true);
  assert.equal(h.intent().intent.version, 1); h.holdingsUnchanged();
});
for (const status of [400, 401, 403, 404, 422]) test('only explicit authoritative rejection clears same nonce: ' + status, async t => {
  const h = harness(t, { response: { ok: false, status } });
  const result = await h.run(); assert.equal(result.reason, 'remote_create_http_' + status); assert.equal(result.writeUnknown, false);
  assert.equal(h.data.has(KEY), false); assert.equal(h.controls.locks, 2); assert.equal(h.controls.posts, 1);
  assert.deepEqual(h.trace.filter(item => Array.isArray(item) && item[0].startsWith('intent-')).map(item => item[0]),
    ['intent-read', 'intent-write', 'intent-read', 'intent-read', 'intent-remove', 'intent-read']);
});
for (const status of [408, 409, 429, 500, 503, 0, undefined]) test('unapproved/unknown HTTP response preserves barrier: ' + status, async t => {
  const h = harness(t, { response: { ok: false, status } }); await h.run();
  assert.equal(h.controls.posts, 1); assert.equal(h.data.has(KEY), true); assert.equal(h.controls.locks, 1);
  assert.equal(h.trace.some(item => Array.isArray(item) && item[0] === 'intent-remove'), false);
});
for (const mode of ['remove-denied', 'fake-remove']) test('authoritative rejection cleanup failure still blocks next owner: ' + mode, async t => {
  const h = harness(t, { mode, response: { ok: false, status: 422 } });
  const result = await h.run(); assert.equal(result.reason, 'remote_create_http_422'); assert.equal(result.intentPending, true);
  assert.equal(h.data.has(KEY), true); assert.equal((await h.run()).reason, 'cloud_create_intent_pending'); assert.equal(h.controls.posts, 1);
});
test('verified archive with durable id and failed intent removal remains pending, not uncreated', async t => {
  const h = harness(t, { mode: 'fake-remove' });
  assert.deepEqual(await h.run(), { ok: false, reason: 'cloud_create_intent_clear_failed', patched: true, remoteVerified: true, pending: true });
  assert.equal(h.controls.pending, true); assert.equal(h.controls.id, ID); assert.equal(h.data.has(KEY), true);
  const reads = h.controls.intentReads;
  await h.feature.uploadToCloud(); assert.equal(h.trace.includes('push'), true); assert.equal(h.controls.intentReads, reads);
});
for (const options of [
  { network: true }, { response: { ok: true, async json() { throw new Error('synthetic-private-json'); } } },
  { response: { ok: true, async json() { return {}; } } }, { adoptFail: true },
  { readback: { ok: false, reason: 'remote_read_failed' } }, { metaFail: true },
]) test('unknown/id/adoption/readback/meta failure never silently discards intent', async t => {
  const h = harness(t, options); assert.equal((await h.run()).ok, false); assert.equal(h.data.has(KEY), true);
  assert.equal(h.controls.posts, 1); h.holdingsUnchanged();
});
test('stale POST response cannot clear a new nonce or write current UI', async t => {
  const entered = deferred(), finish = deferred();
  const h = harness(t, { async post() { entered.resolve(); await finish.promise; return { ok: false, status: 400 }; } });
  const running = h.feature.uploadToCloud(); await entered.promise;
  h.controls.current = false;
  const replacement = JSON.stringify({ version: 1, nonce: SECOND_NONCE, createdAt: 5 }); h.data.set(KEY, replacement);
  const boundary = h.trace.length; finish.resolve(); await running;
  assert.equal(h.data.get(KEY), replacement);
  assert.equal(h.trace.slice(boundary).some(item => Array.isArray(item) && item[0] === 'intent-remove'), false);
  assert.equal(h.trace.slice(boundary).some(item => item === 'pending' || Array.isArray(item) && item[0] === 'toast'), false);
});
test('nonce mismatch during final verified cleanup cannot erase another prepared intent', async t => {
  const replacement = JSON.stringify({ version: 1, nonce: SECOND_NONCE, createdAt: 5 });
  const h = harness(t, { beforeLock(ticket, controls, data) { if (ticket === 2) data.set(KEY, replacement); } });
  assert.equal((await h.run()).reason, 'cloud_create_intent_clear_failed'); assert.equal(h.data.get(KEY), replacement);
  assert.equal(h.trace.some(item => Array.isArray(item) && item[0] === 'intent-remove'), false);
});
test('scope lost while waiting for rejection-cleanup lock retains intent and performs zero remove', async t => {
  const h = harness(t, { response: { ok: false, status: 400 }, beforeLock(ticket, controls) { if (ticket === 2) controls.current = false; } });
  assert.deepEqual(await h.run(), { ok: false, reason: 'cloud_configuration_changed' });
  assert.equal(h.data.has(KEY), true);
  assert.equal(h.trace.some(item => Array.isArray(item) && item[0] === 'intent-remove'), false);
});
test('abandoned preflight before POST stays fail-closed after a new owner takes over', async t => {
  const h = harness(t, { invalidateAfterPreflight: true });
  assert.deepEqual(await h.run(), { ok: false, reason: 'cloud_configuration_changed' });
  assert.equal(h.controls.posts, 0); const saved = h.data.get(KEY); assert.equal(typeof saved, 'string');
  h.controls.current = true;
  await createCloudArchiveFeature(h.base).uploadToCloud();
  assert.equal(h.controls.posts, 0); assert.equal(h.controls.confirms, 0); assert.equal(h.data.get(KEY), saved);
});
test('POST cancellation retains the durable barrier without exposing abort details', async t => {
  const h = harness(t, { async post() { throw new DOMException('synthetic-private-abort', 'AbortError'); } });
  const result = await h.run(); assert.equal(result.writeUnknown, true); assert.equal(h.data.has(KEY), true);
  assert.equal(JSON.stringify(result).includes('synthetic-private-abort'), false);
});
for (const kind of ['persisted', 'malformed', 'future', 'read-denied']) test('new UI readFirst=false blocks no-id confirmation: ' + kind, async t => {
  const raw = kind === 'persisted' ? JSON.stringify({ version: 1, nonce: SECOND_NONCE, createdAt: 0 })
    : kind === 'future' ? JSON.stringify({ version: 2, nonce: SECOND_NONCE, createdAt: 0 }) : '{}';
  const h = harness(t, { raw, mode: kind === 'read-denied' ? 'read-denied' : '' });
  await h.feature.uploadToCloud(); assert.equal(h.controls.confirms, 0); assert.equal(h.controls.posts, 0);
  assert.deepEqual(h.trace.filter(item => Array.isArray(item) && item[0] === 'intent-read'), [['intent-read', false]]);
});
test('known id upload and download do not read an unrelated unknown barrier', async t => {
  const h = harness(t, { id: ID, mode: 'read-denied', raw: '{}' });
  await h.feature.uploadToCloud(); await h.feature.downloadFromCloud();
  assert.equal(h.controls.intentReads, 0); assert.equal(h.trace.includes('push'), true); assert.equal(h.trace.includes('pull'), true);
});
test('clearing normal credentials/meta and constructing a new feature does not remove unknown barrier', async t => {
  const h = harness(t, { network: true }); await h.run(); const saved = h.data.get(KEY);
  await h.feature.clearCloudConfig(); assert.equal(h.data.get(KEY), saved);
  h.controls.confirms = 0;
  await createCloudArchiveFeature(h.base).uploadToCloud();
  assert.equal(h.controls.confirms, 0); assert.equal(h.controls.posts, 1); assert.equal(h.data.get(KEY), saved);
});
test('actual App resetCloudConfiguration removes ordinary metadata but never create intent', async t => {
  const h = harness(t, { network: true }); await h.run(); const stored = h.data.get(KEY);
  h.data.set('fuyu_sync_meta_v1', '{}'); h.data.set('fuyu_gist_sync_time', TIME);
  const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const node = parseSync('app.js', source).program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === 'resetCloudConfiguration');
  assert.ok(node);
  const controller = createSyncStatus({ getGistToken: () => 'synthetic-never-sent', getGistId: () => '', clearTimeout() {}, clearInterval() {} });
  t.after(() => controller.dispose());
  const reset = new Function('syncController', 'setGistId', 'showToast', 'safeRemoveItem', 'GIST_SYNC_TIME_KEY', 'SYNC_META_KEY', 'GIST_ID_KEY', 'setArchiveCandidates',
    source.slice(node.start, node.end) + ';return resetCloudConfiguration;')(controller, () => true, () => {}, key => h.data.delete(key),
      'fuyu_gist_sync_time', 'fuyu_sync_meta_v1', 'fuyu_gist_id', () => {});
  assert.equal(reset(), true); assert.equal(h.data.has('fuyu_sync_meta_v1'), false); assert.equal(h.data.has('fuyu_gist_sync_time'), false);
  assert.equal(h.data.get(KEY), stored);
  await createCloudArchiveFeature(h.base).uploadToCloud();
  assert.equal(h.controls.posts, 1); assert.equal(h.controls.confirms, 0); h.holdingsUnchanged();
});
for (const network of [false, true]) test('actual fresh controller plus complete-empty discovery cannot replay unknown POST: ' + network, async t => {
  const h = harness(t, network ? { network: true } : { response: { ok: false, status: 503 } });
  await h.run(); const stored = h.data.get(KEY), timers = new Map(); let timer = 0;
  const controller = createSyncStatus({ ...h.base, TIMING: { AUTO_PUSH_DELAY: 1, AUTO_PULL_INTERVAL: 60000 },
    document: globalThis.document, getGistToken: () => 'synthetic-never-sent', isUpdateApplying: () => false,
    listGists: async () => ({ ok: true, complete: true, candidates: [] }), setArchiveCandidates() {},
    now: () => h.controls.clock, random: () => 0,
    setTimeout(callback, ms) { const id = ++timer; timers.set(id, { callback, ms }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: () => ++timer, clearInterval() {},
  });
  t.after(() => controller.dispose());
  assert.equal(controller.getStatus().readFirst, false);
  await controller.autoPullOnLoad();
  assert.equal(controller.getStatus().code, 'remote_archive_missing');
  const feature = createCloudArchiveFeature({ ...h.base, getSyncStatus: controller.getStatus,
    captureCloudConfigurationScope: controller.captureConfigurationScope, runManualOperation: controller.runManualOperation,
    resolveGistId: controller.resolveGistId });
  await feature.uploadToCloud(); assert.equal(h.controls.posts, 1); assert.equal(h.controls.confirms, 0);
  assert.equal(h.data.get(KEY), stored); h.holdingsUnchanged();
});
test('actual export and diagnostics never consume or include create-intent nonce/body', async t => {
  const h = harness(t, { response: { ok: false, status: 503 } }); await h.run();
  const stored = h.data.get(KEY), nonce = JSON.parse(stored).nonce, reads = h.controls.intentReads;
  let exported;
  t.mock.method(URL, 'createObjectURL', blob => { exported = blob; return 'blob:synthetic'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const content = { textContent: '', innerHTML: '' };
  globalThis.document.createElement = () => ({ click() {} });
  const getElement = globalThis.document.getElementById;
  globalThis.document.getElementById = id => id === 'diagnostics-content' ? content : getElement(id);
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  t.after(() => windowDescriptor ? Object.defineProperty(globalThis, 'window', windowDescriptor) : delete globalThis.window);
  const transfer = createHoldingsTransfer({ getHoldingsDocument: () => value, showToast() {} });
  await transfer.exportData(); const exportText = await exported.text();
  const center = createDiagnosticsCenter({ getHoldings: () => value.holdings, getHoldingsDocument: () => value,
    refreshCoordinator: { snapshot: () => ({ sourceRegistry: { sources: [] }, lastCompleted: null }) }, showToast() {}, esc: String });
  const diagnostics = await center.refreshDiagnosticsCenter();
  for (const text of [canonicalHoldingsDocument(value), exportText, diagnostics, content.innerHTML, JSON.stringify(h.controls.meta)]) {
    assert.equal(text.includes(nonce), false); assert.equal(text.includes(KEY), false); assert.equal(text.includes(stored), false);
  }
  assert.equal(JSON.parse(exportText).schema, 3); assert.equal(h.controls.intentReads, reads);
  assert.equal(h.data.get(KEY), stored);
});
for (const broken of ['missing-write', 'missing-readback']) test('strict actual-owner preflight oracle rejects ' + broken, async t => {
  const h = harness(t);
  const store = createCloudCreateIntentStore();
  const dishonest = { ...store, prepare() {
    const intent = { version: 1, nonce: SECOND_NONCE, createdAt: 1 };
    if (broken === 'missing-readback') h.storage.setItem(KEY, JSON.stringify(intent));
    return { ok: true, intent };
  }, clear: () => ({ ok: true }) };
  const owner = createCloudArchiveFeature({ ...h.base, cloudCreateIntentStore: dishonest });
  assert.equal((await owner.createCloudArchive('synthetic-never-sent', { targetSchema: 3, scope: h.scope })).ok, true);
  assert.throws(() => assertPreflight(h.trace), { code: 'ERR_ASSERTION' });
});
