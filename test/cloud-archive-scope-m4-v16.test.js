import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCloudArchiveFeature } from '../js/storage/cloud-archive-ui.js';
import { createSyncStatus } from '../js/runtime/sync-status.js';

// Execute both actual owners. All documents, credentials and transport results
// are synthetic; timers/IO/DOM below are in-memory test boundaries only.
const A = 'a'.repeat(32), B = 'b'.repeat(32);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

function harness(t, options = {}) {
  const previous = { document: globalThis.document, confirm: globalThis.confirm };
  const effects = [], gates = {}, timers = new Map(), intervals = new Map();
  const controls = { token: 'synthetic-config-a', id: options.id ?? A, meta: {}, io: 0, buttonWrites: [], clock: 100000 };
  const elements = Object.fromEntries(['gist-token', 'gist-remember-token', 'cloud-upload-btn', 'cloud-download-btn', 'cloud-status']
    .map(id => [id, { value: '', checked: false, textContent: '', disabled: false, style: {} }]));
  elements['gist-token'].value = controls.token;
  for (const id of ['cloud-upload-btn', 'cloud-download-btn']) elements[id] = new Proxy(elements[id], {
    set(target, key, value) { controls.buttonWrites.push([id, key, value]); target[key] = value; return true; },
  });
  globalThis.document = { getElementById: id => elements[id] };
  globalThis.confirm = () => { effects.push('confirm'); return true; };
  t.after(() => { globalThis.document = previous.document; globalThis.confirm = previous.confirm; });
  const documentValue = { deviceId: 'synthetic-device', holdings: [{ fundCode: '000001' }] };
  const results = { push: { ok: true, remoteVerified: true }, pull: { ok: true, remoteVerified: true } };
  let api, timerId = 0;
  const mark = () => { effects.push('pending'); controls.meta.pending = true; api.setSyncPending(true); };
  async function boundary(name) { effects.push(name); if (gates[name]) await gates[name].promise; }
  const controllerContext = {
    TIMING: { AUTO_PUSH_DELAY: 100, AUTO_PULL_INTERVAL: 1000 }, document: globalThis.document,
    isUpdateApplying: () => false, getHoldingsDocument: () => documentValue,
    getGistToken: () => controls.token, getGistId: () => controls.id,
    setGistId: id => { controls.id = id; return true; },
    setSyncTime: () => effects.push('time'), loadSyncMeta: () => controls.meta, markSyncPending: mark,
    loadCloudSyncFeature: async () => ({
      synchronizeHoldingsCloud: async () => { controls.io++; await boundary('push'); return results.push; },
      pullHoldingsCloud: async () => { controls.io++; await boundary('pull'); return results.pull; },
    }),
    listGists: async () => { await boundary('list'); return { ok: true, complete: true, candidates: [{ id: A, schema: 3 }] }; },
    setArchiveCandidates: () => effects.push('candidates'),
    createGistRemoteAdapter: async () => ({}), createCloudLocalAdapter: async () => ({}),
    reloadHoldingsAfterCloud: async () => ({ ok: true }),
    renderHoldingsList: () => effects.push('holdings-render'), refresh: () => effects.push('refresh'),
    showToast: () => effects.push('controller-toast'), nowISO: () => new Date(controls.clock).toISOString(),
    now: () => controls.clock, random: () => 0,
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, ms) => { const id = ++timerId; intervals.set(id, { callback, ms }); return id; },
    clearInterval: id => intervals.delete(id),
  };
  api = createSyncStatus(controllerContext);
  const uiContext = {
    getHoldingsDocument: () => documentValue, getHoldings: () => documentValue.holdings,
    setGistToken: async () => { await boundary('save'); return { ok: true }; },
    getGistId: controllerContext.getGistId, getSyncStatus: api.getStatus,
    captureCloudConfigurationScope: api.captureConfigurationScope,
    runManualOperation: api.runManualOperation, resolveGistId: api.resolveGistId,
    listCloudArchives: async () => { await boundary('ui-list'); return { ok: true, complete: true, candidates: [{ id: A, schema: 3 }] }; },
    setArchiveCandidates: () => effects.push('ui-candidates'),
    pushToCloud: async (...args) => { const result = await api.pushToCloud(...args);
      if (options.throwAfterPush) throw new Error('synthetic-private-rejection'); return result; },
    pullFromCloud: api.pullFromCloud,
    markSyncPending: mark, renderCloudStatus: () => effects.push('ui-render'),
    showToast: () => effects.push('ui-toast'), startAutoPull: () => { effects.push('auto'); api.startAutoPull(); },
  };
  const feature = createCloudArchiveFeature({ ...uiContext, ...options.uiOverrides });
  return { feature, api, controls, elements, effects, results, timers, intervals,
    hold(name) { return gates[name] = deferred(); },
    reset({ token = controls.token, id = B } = {}) {
      api.resetCloudState(); controls.token = token; controls.id = id; controls.meta = {};
    },
  };
}

test('configuration scope uses the prepared token and does not expose credentials', t => {
  const h = harness(t);
  const scope = h.api.captureConfigurationScope('different-synthetic-token');
  assert.equal(scope.isCurrent(), false);
  assert.deepEqual(Object.keys(scope), ['isCurrent']); assert.equal(Object.isFrozen(scope), true);
});

test('same-token reset invalidates the captured configuration scope', t => {
  const h = harness(t), scope = h.api.captureConfigurationScope(h.controls.token);
  assert.equal(scope.isCurrent(), true); h.reset(); assert.equal(scope.isCurrent(), false);
});

test('same-epoch adopted archive does not invalidate the configuration scope', async t => {
  const h = harness(t, { id: '' }), scope = h.api.captureConfigurationScope(h.controls.token);
  await h.api.runManualOperation(async operation => {
    assert.equal(operation.adoptGistId(A), true); assert.equal(scope.isCurrent(), true);
    return { ok: true, remoteVerified: true };
  });
  assert.equal(scope.isCurrent(), true); assert.equal(h.controls.id, A);
});

for (const sameToken of [false, true]) test('late upload cannot mutate the new configuration after ' + (sameToken ? 'same-token archive reset' : 'credential reset'), async t => {
  const h = harness(t), held = h.hold('push');
  const running = h.feature.uploadToCloud(); await flush(); assert.ok(h.effects.includes('push'));
  h.reset({ token: sameToken ? h.controls.token : 'synthetic-config-b' });
  assert.equal(h.api.isSyncing(), true, 'Reset must not release active IO before settlement');
  const count = h.effects.length;
  held.resolve(); await running;
  assert.deepEqual(h.effects.slice(count), []);
  assert.equal(h.controls.meta.pending, undefined); assert.equal(h.api.isPending(), false);
  assert.equal(h.api.isSyncing(), false); assert.equal(h.intervals.size, 0);
  assert.equal(h.elements['cloud-upload-btn'].disabled, false, 'Settled old IO releases its own control');
  assert.equal(h.elements['cloud-upload-btn'].textContent, '上传到云端');
});

test('late upload rejection cannot mark pending or show an error for the new configuration', async t => {
  const h = harness(t, { throwAfterPush: true }), held = h.hold('push');
  const running = h.feature.uploadToCloud(); await flush(); h.reset({ token: 'synthetic-config-b' });
  const count = h.effects.length;
  held.resolve(); await running;
  assert.deepEqual(h.effects.slice(count), []); assert.equal(h.controls.meta.pending, undefined);
});

test('late download releases its own button but cannot start polling for the new configuration', async t => {
  const h = harness(t), held = h.hold('pull');
  const running = h.feature.downloadFromCloud(); await flush(); assert.ok(h.effects.includes('pull'));
  h.reset();
  const count = h.effects.length;
  held.resolve(); await running;
  assert.deepEqual(h.effects.slice(count), []); assert.equal(h.elements['cloud-download-btn'].disabled, false);
});

test('an old finally cannot alter a button already completed by a newer action owner', async t => {
  const h = harness(t), held = h.hold('push');
  const oldAction = h.feature.uploadToCloud(); await flush(); assert.ok(h.effects.includes('push'));
  h.reset({ token: 'synthetic-config-b' }); h.elements['gist-token'].value = h.controls.token;
  // A programmatic new action is still refused by the controller busy lock,
  // but owns and settles its own UI. Old IO remains active until its real end.
  await h.feature.uploadToCloud();
  assert.equal(h.api.isSyncing(), true);
  h.elements['cloud-upload-btn'].textContent = 'new-owner-complete';
  const writes = h.controls.buttonWrites.length;
  held.resolve(); await oldAction;
  assert.equal(h.controls.buttonWrites.length, writes);
  assert.equal(h.elements['cloud-upload-btn'].textContent, 'new-owner-complete');
  assert.equal(h.api.isSyncing(), false);
});

test('an old finally cannot alter a detached DOM button', async t => {
  const h = harness(t), held = h.hold('push');
  const running = h.feature.uploadToCloud(); await flush(); h.reset();
  h.elements['cloud-upload-btn'].isConnected = false;
  const writes = h.controls.buttonWrites.length;
  held.resolve(); await running;
  assert.equal(h.controls.buttonWrites.length, writes);
});

test('credential await cannot attach the old prepared token to the new configuration', async t => {
  const h = harness(t), held = h.hold('save');
  const running = h.feature.uploadToCloud(); await flush(); h.reset({ token: 'synthetic-config-b' });
  const writes = h.controls.buttonWrites.length;
  held.resolve(); await running;
  assert.equal(h.controls.io, 0); assert.equal(h.controls.buttonWrites.length, writes);
});

test('missing configuration guard fails closed before cloud or button mutations', async t => {
  const h = harness(t, { uiOverrides: { captureCloudConfigurationScope: undefined } });
  await h.feature.uploadToCloud(); await h.feature.downloadFromCloud();
  assert.equal(h.controls.io, 0); assert.equal(h.controls.buttonWrites.length, 0);
});

test('late archive-list completion cannot install candidates or toast in the new configuration', async t => {
  const h = harness(t), held = h.hold('ui-list');
  const running = h.feature.refreshCloudArchives(); await flush(); assert.ok(h.effects.includes('ui-list'));
  h.reset({ token: 'synthetic-config-b' });
  const count = h.effects.length;
  held.resolve(); await running;
  assert.deepEqual(h.effects.slice(count), []);
  assert.equal(h.controls.meta.pending, undefined); assert.equal(h.api.isSyncing(), false);
});

test('current archive-list completion still installs safe candidates and prompts explicit selection', async t => {
  const h = harness(t);
  await h.feature.refreshCloudArchives();
  assert.ok(h.effects.includes('ui-candidates')); assert.ok(h.effects.includes('ui-toast'));
});

test('current configuration failed upload preserves pending and releases its own button', async t => {
  const h = harness(t); h.results.push = { ok: false, reason: 'remote_http_503' };
  await h.feature.uploadToCloud();
  assert.equal(h.controls.meta.pending, true); assert.equal(h.api.isPending(), true);
  assert.equal(h.elements['cloud-upload-btn'].disabled, false);
});

test('actual App passes the controller-owned configuration guard into the lazy UI', () => {
  const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(source, /captureCloudConfigurationScope:\s*syncController\.captureConfigurationScope/);
});
