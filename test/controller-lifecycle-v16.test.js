import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncStatus } from '../js/runtime/sync-status.js';
import { createPwaUpdateController } from '../js/runtime/pwa-update-controller.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Both production factories are connected through their actual public state
// readers. Only browser IO, cloud adapters and refresh execution are synthetic.
function harness(t) {
  const trace = [], pending = [], gates = [], listeners = new Map(), timers = new Map();
  const elements = Object.fromEntries(['cloud-status', 'update-banner', 'update-banner-text', 'update-now-btn']
    .map(id => [id, { hidden: true, disabled: false, textContent: '', style: {} }]));
  const cloudStarted = deferred(), drainStarted = deferred();
  let dirty = false, cloudGate = null, drainGate = null, nextTimer = 0, deniedNetwork = 0;
  let sync, pwa;
  const origin = 'https://fundval.example.test';
  const oldWorker = { name: 'old' };
  const waitingWorker = { name: 'waiting', postMessage(message) { trace.push(['post', message]); } };
  const serviceWorker = {
    controller: oldWorker,
    register(path) {
      trace.push(['register', path]);
      return Promise.resolve({ waiting: waitingWorker, addEventListener() {}, update() {} });
    },
    addEventListener(type, listener) {
      listeners.set(type, [...listeners.get(type) || [], listener]);
    },
  };
  const addTimer = (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; };
  const browser = {
    document: { getElementById: id => elements[id] || null },
    navigator: { serviceWorker },
    location: { origin, reload() { trace.push(['reload']); } },
    BroadcastChannel: undefined,
    setInterval: addTimer,
    fetch() { deniedNetwork++; throw new Error('Network is forbidden in controller lifecycle tests'); },
  };
  const original = Object.fromEntries(Object.keys(browser).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(browser)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(async () => {
    dirty = false;
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(pending);
    await flush();
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.equal(deniedNetwork, 0, 'No real network request may leave the synthetic adapters');
  });
  const cloud = async (direction, options) => {
    assert.equal(options.deviceId, 'synthetic-device');
    trace.push(['cloud', direction]);
    cloudStarted.resolve();
    if (cloudGate) await cloudGate.promise;
    return { ok: true };
  };
  sync = createSyncStatus({
    TIMING: { AUTO_PUSH_DELAY: 500, AUTO_PULL_INTERVAL: 10000 },
    document: browser.document,
    isUpdateApplying: () => pwa.isUpdateApplying(),
    getHoldingsDocument: () => ({ deviceId: 'synthetic-device' }),
    getGistToken: () => 'synthetic-token', getGistId: () => 'synthetic-gist', setGistId() {},
    getSyncTime: () => '', setSyncTime() {}, loadSyncMeta: () => ({}),
    markSyncPending: () => sync.setSyncPending(true),
    async loadCloudSyncFeature() {
      trace.push(['load-cloud']);
      return { pullHoldingsCloud: options => cloud('pull', options), synchronizeHoldingsCloud: options => cloud('push', options) };
    },
    async findExistingGist() { throw new Error('A configured synthetic archive must not be discovered'); },
    async createGistRemoteAdapter(token, gistId) {
      assert.equal(token, 'synthetic-token'); assert.equal(gistId, 'synthetic-gist'); return {};
    },
    async createCloudLocalAdapter() { return {}; },
    async reloadHoldingsAfterCloud() { return { ok: true }; },
    renderHoldingsList() {}, refresh() { trace.push(['quote-refresh']); },
    showToast: text => trace.push(['toast', text]), nowISO: () => '2026-10-23T00:00:00.000Z',
    setTimeout: addTimer, clearTimeout: id => timers.delete(id),
    setInterval: addTimer, clearInterval: id => timers.delete(id),
  });
  pwa = createPwaUpdateController({
    hasUnsavedPageInput: () => dirty,
    isSyncing: () => sync.isSyncing(), isSavingHolding: () => false,
    clearAutoRefresh: () => trace.push(['refresh-stop']),
    startAutoRefresh: () => trace.push(['refresh-restart']),
    stopAndDrain(reason) {
      trace.push(['drain', reason]); drainStarted.resolve();
      return drainGate?.promise || Promise.resolve();
    },
    showToast: text => trace.push(['toast', text]), updateIntervalMs: 1800000,
  });
  assert.deepEqual(trace, [], 'Constructing the mutually connected factories must remain inert');
  pwa.start();
  const emit = (type, event) => { for (const listener of listeners.get(type) || []) listener(event); };
  return {
    sync, pwa, trace, elements, waitingWorker, oldWorker, origin, cloudStarted, drainStarted,
    ready: flush,
    track(promise) { pending.push(promise); return promise; },
    holdCloud() { cloudGate = deferred(); gates.push(cloudGate); return cloudGate; },
    holdDrain() { drainGate = deferred(); gates.push(drainGate); return drainGate; },
    setDirty(value) { dirty = value; },
    count(kind) { return trace.filter(entry => entry[0] === kind).length; },
    ack(source = waitingWorker, eventOrigin = origin) {
      emit('message', { origin: eventOrigin, source, data: { type: 'UPDATE_ACTIVATED' } });
    },
    activate() { serviceWorker.controller = waitingWorker; emit('controllerchange', {}); },
  };
}

test('real active cloud synchronization blocks PWA activation until the operation settles', { timeout: 5000 }, async t => {
  const h = harness(t);
  await h.ready();
  const gate = h.holdCloud();
  const syncing = h.track(h.sync.pushToCloud(false));
  await h.cloudStarted.promise;
  assert.equal(h.sync.isSyncing(), true);
  assert.equal(h.pwa.hasServiceWorkerUpdateBlocker(), true);
  await h.track(h.pwa.applyPendingServiceWorkerUpdate());
  assert.equal(h.count('drain'), 0);
  assert.equal(h.count('post'), 0);
  assert.equal(h.pwa.isUpdateApplying(), false);
  assert.match(h.elements['update-banner-text'].textContent, /云同步仍在进行/);
  gate.resolve();
  assert.deepEqual(await syncing, { ok: true });
  assert.equal(h.sync.isSyncing(), false);
  assert.equal(h.pwa.hasServiceWorkerUpdateBlocker(), false);
});

test('real PWA drain state rejects both new sync directions before loading cloud code', { timeout: 5000 }, async t => {
  const h = harness(t);
  await h.ready();
  const gate = h.holdDrain();
  const applying = h.track(h.pwa.applyPendingServiceWorkerUpdate());
  await h.drainStarted.promise;
  assert.equal(h.pwa.isUpdateApplying(), true);
  const blocked = { ok: false, reason: 'service_worker_update_pending' };
  assert.deepEqual(await h.track(h.sync.pullFromCloud(false)), blocked);
  assert.deepEqual(await h.track(h.sync.pushToCloud(false)), blocked);
  assert.equal(h.sync.isSyncing(), false);
  assert.equal(h.count('load-cloud'), 0);
  assert.equal(h.count('post'), 0, 'Activation must wait for the real drain promise');
  gate.resolve();
  await applying;
  assert.deepEqual(h.trace.filter(entry => entry[0] === 'post'), [['post', { type: 'SKIP_WAITING' }]]);
  assert.equal(h.count('reload'), 0);
});

test('dirty input appearing during drain resumes refresh and reopens sync without activation', { timeout: 5000 }, async t => {
  const h = harness(t);
  await h.ready();
  const gate = h.holdDrain();
  const applying = h.track(h.pwa.applyPendingServiceWorkerUpdate());
  await h.drainStarted.promise;
  h.setDirty(true);
  gate.resolve();
  await applying;
  assert.equal(h.pwa.isUpdateApplying(), false);
  assert.equal(h.count('refresh-restart'), 1);
  assert.equal(h.count('post'), 0);
  assert.equal(h.elements['update-now-btn'].disabled, false);
  h.ack();
  assert.equal(h.count('reload'), 0, 'An aborted apply must not authorize an activation ACK');
  h.setDirty(false);
  assert.deepEqual(await h.track(h.sync.pullFromCloud(false)), { ok: true });
  assert.equal(h.count('cloud'), 1);
  assert.equal(h.sync.isSyncing(), false);
});

test('after sync settles a clean update accepts only its exact activation ACK and reloads once', { timeout: 5000 }, async t => {
  const h = harness(t);
  await h.ready();
  assert.deepEqual(await h.track(h.sync.pushToCloud(false)), { ok: true });
  assert.equal(h.pwa.hasServiceWorkerUpdateBlocker(), false);
  await h.track(h.pwa.applyPendingServiceWorkerUpdate());
  assert.equal(h.count('drain'), 1);
  assert.equal(h.count('post'), 1);
  h.ack(h.waitingWorker, 'https://wrong.example.test');
  h.ack(h.oldWorker);
  assert.equal(h.count('reload'), 0);
  h.ack();
  assert.equal(h.count('reload'), 1);
  h.activate();
  h.ack();
  assert.equal(h.count('reload'), 1, 'ACK/controllerchange duplicates cannot reload twice');
});
