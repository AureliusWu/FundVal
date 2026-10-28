import test from 'node:test';
import assert from 'node:assert/strict';
import * as cloud from '../js/storage/cloud-sync.js';
import { createCloudArchiveFeature } from '../js/storage/cloud-archive-ui.js';
import { normalizeHoldingsDocumentV3, stableHoldingId } from '../js/storage/holdings-schema.js';
import { HOLDINGS_DEVICE_KEY, persistHoldingsDocument } from '../js/storage/holdings-repository.js';
import { classifyGistHttpFailure } from '../js/storage/gist-http.js';

const ID = 'a'.repeat(32), TIME = '2026-10-25T00:00:00.000Z';
const snapshot = normalizeHoldingsDocumentV3({ schema: 3, deviceId: 'synthetic-readback-device', updatedAt: TIME,
  holdings: [{ id: stableHoldingId('000001'), fundCode: '000001', fundName: '合成基金', shares: 10, costNav: null,
    createdAt: TIME, updatedAt: TIME, revision: 1, deviceId: 'synthetic-readback-device' }] });
const payload = cloud.makeCloudWritePayload(snapshot, 3);
// A shared-validator packaging experiment was rejected after its actual build.
// These tests target the real owners, not the retired experimental helper.

for (const [name, readback, reason] of [
  ['target mismatch', { ok: true, raw: payload, requiresPatch: true }, 'remote_target_readback_mismatch'],
  ['canonical mismatch', { ok: true, raw: { ...payload, holdings: [] } }, 'remote_readback_mismatch'],
  ['shares mismatch', { ok: true, raw: { ...payload, holdings: payload.holdings.map(row => ({ ...row, shares: 11 })) } }, 'remote_readback_mismatch'],
  ['zero is not null cost', { ok: true, raw: { ...payload, holdings: payload.holdings.map(row => ({ ...row, costNav: 0 })) } }, 'remote_readback_mismatch'],
  ['future schema', { ok: true, raw: { ...payload, schema: 4 } }, 'remote_readback_invalid'],
  ['invalid canonical', { ok: true, raw: '{invalid' }, 'remote_readback_invalid'],
]) test('real PATCH owner preserves acknowledged-but-unverified envelope for ' + name, async () => {
  let gets = 0, writes = 0, document = snapshot;
  const result = await cloud.synchronizeHoldingsCloud({ deviceId: snapshot.deviceId,
    remote: { async get() { return ++gets === 1 ? { ok: true, raw: payload } : readback; }, async patch() { writes++; return { ok: true }; } },
    local: { async load() { return { ok: true, document }; }, async backup() { return { ok: true }; },
      async persist(value) { document = value; return { ok: true }; } },
  });
  assert.equal(result.reason, reason); assert.equal(result.patched, true); assert.equal(result.patchAcknowledged, true);
  assert.equal(result.remoteVerified, false); assert.equal(result.pending, true); assert.equal(result.writeSchema, 3);
  assert.equal(Object.hasOwn(result, 'error'), reason === 'remote_readback_invalid');
  assert.equal(gets, 2); assert.equal(writes, 1);
});

function createHarness(t, options = {}) {
  const descriptors = Object.fromEntries(['localStorage', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const data = new Map([[HOLDINGS_DEVICE_KEY, snapshot.deviceId]]), calls = [];
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key), key: index => [...data.keys()][index] ?? null, get length() { return data.size; } };
  let current = true, lockCount = 0, meta = {}, id = '';
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { locks: { async request(name, settings, action) {
    lockCount++; if (options.staleAt === 'final-lock' && calls.includes('create-readback')) current = false;
    return action({ name });
  } } }, configurable: true });
  t.after(() => { for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  assert.equal(persistHoldingsDocument(storage, snapshot, { now: TIME }).ok, true);
  const scope = { isCurrent: () => current, signal: new AbortController().signal,
    adoptGistId(value) { id = value; return true; } };
  const feature = createCloudArchiveFeature({
    CACHE_KEY: 'synthetic-cache', getHoldingsDocument: () => snapshot,
    async loadCloudSyncFeature() { calls.push('module'); if (options.staleAt === 'module') current = false; return cloud; },
    async loadGistRemoteModule() { calls.push('gist-module'); return { v3GistFilename: () => 'fuyu-holdings-v3.json', classifyGistHttpFailure }; },
    nowISO: () => TIME,
    async fetchWithTimeout() { calls.push('post'); return options.postResponse || { ok: true, async json() { return { id: ID }; } }; },
    setGistId(value) { id = value; return true; },
    async createGistRemoteAdapter() {
      calls.push('adapter'); if (options.staleAt === 'adapter') current = false;
      return { async get({ phase }) {
        calls.push(phase); if (options.staleAt === 'readback') current = false;
        if (options.readError) throw options.readError;
        return options.readback || { ok: true, raw: payload };
      } };
    },
    loadSyncMeta: () => meta, saveSyncMeta(value) { calls.push('meta'); meta = value; return true; },
    setSyncTime() { calls.push('time'); return true; }, setSyncPending(value) { calls.push(['pending', value]); },
    installHoldingsDocument() { calls.push('install'); },
  });
  return { calls, id: () => id, run: () => feature.createCloudArchive('synthetic-token', { targetSchema: 3, scope }) };
}

test('real POST owner retains its successful DTO without adding PATCH acknowledgement fields', async t => {
  const h = createHarness(t), result = await h.run();
  assert.deepEqual(result, { ok: true, gistId: ID, remoteVerified: true, pending: false });
  assert.deepEqual(h.calls.filter(call => typeof call === 'string'), ['module', 'gist-module', 'post', 'adapter', 'create-readback', 'meta', 'time', 'install']);
});

test('real POST readback accepts equivalent property order, not only identical JSON bytes', async t => {
  const reordered = Object.fromEntries(Object.entries(payload).reverse());
  const h = createHarness(t, { readback: { ok: true, raw: JSON.stringify(reordered) } });
  assert.equal((await h.run()).remoteVerified, true);
});

for (const [name, readback, expected] of [
  ['target mismatch', { ok: true, raw: payload, requiresPatch: true }, { ok: false, reason: 'remote_target_readback_mismatch', patched: true }],
  ['canonical mismatch', { ok: true, raw: { ...payload, holdings: [] } }, { ok: false, reason: 'remote_readback_mismatch', patched: true }],
  ['invalid schema', { ok: true, raw: { ...payload, schema: 4 } }, { ok: false, reason: 'remote_readback_invalid', patched: true }],
  ['safe rate failure', { ok: false, reason: 'remote_http_429', failure: { code: 'rate_limit', status: 429, retryable: true, retryAfterMs: 60000 } },
    { ok: false, reason: 'remote_http_429', failure: { code: 'rate_limit', status: 429, retryable: true, retryAfterMs: 60000 }, patched: true }],
]) test('real POST owner preserves exact failure flags for ' + name, async t => {
  const h = createHarness(t, { readback }); assert.deepEqual(await h.run(), expected);
  assert.equal(h.calls.includes('meta'), false); assert.equal(h.calls.includes('time'), false); assert.equal(h.id(), ID);
});

test('POST get exceptions keep the existing rejection boundary, not PATCH acknowledgement DTOs', async t => {
  const sentinel = new Error('synthetic-readback-rejection'), h = createHarness(t, { readError: sentinel });
  await assert.rejects(h.run, error => error === sentinel); assert.equal(h.calls.includes('meta'), false);
});

test('POST 5xx does not prove absence of a newly-created archive and remains write-unknown', async t => {
  const h = createHarness(t, { postResponse: { ok: false, status: 503 } });
  // Only the fixed classification is needed; no network or response body.
  const result = await h.run();
  assert.equal(result.reason, 'remote_create_http_503');
  assert.equal(result.writeUnknown, true);
  assert.equal(h.calls.includes('adapter'), false);
});

for (const stage of ['module', 'adapter', 'readback', 'final-lock']) test('POST stale scope cannot continue after ' + stage, async t => {
  const h = createHarness(t, { staleAt: stage });
  assert.deepEqual(await h.run(), { ok: false, reason: 'cloud_configuration_changed' });
  assert.equal(h.calls.includes('meta'), false); assert.equal(h.calls.includes('install'), false);
  if (stage === 'module') assert.equal(h.calls.includes('gist-module'), false);
  if (stage === 'adapter') assert.equal(h.calls.includes('create-readback'), false);
});
