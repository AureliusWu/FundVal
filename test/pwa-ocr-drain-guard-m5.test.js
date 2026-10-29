import test from 'node:test';
import assert from 'node:assert/strict';
import { createPwaUpdateController } from '../js/runtime/pwa-update-controller.js';
import { createOcrPageGuard } from '../js/ocr/page-guard.js';

// Full actual factories, never the legacy source projection. Platform objects
// are in-memory boundaries: no native browser/SW/OCR/network/device claim.
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function events() {
  const rows = new Map();
  return { addEventListener(type, fn) { if (!rows.has(type)) rows.set(type, new Set()); rows.get(type).add(fn); },
    removeEventListener(type, fn) { rows.get(type)?.delete(fn); },
    emit(type, event) { for (const fn of [...rows.get(type) || []]) fn(event); } };
}
function harness(t) {
  const keys = ['document', 'navigator', 'location', 'BroadcastChannel', 'setTimeout', 'setInterval', 'Date', 'Math'];
  const descriptors = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const state = { localDirty: false, ocrDirty: false, delaySecond: false, secondDelivery: null, clock: 100000, sample: 0 };
  const trace = [], timers = new Map(), channels = new Set(), drains = [];
  const effects = { prepares: [], blocked: [], posts: [], reloads: 0, starts: 0, clears: 0, drainCalls: 0, discarded: 0, toasts: [] };
  const elements = Object.fromEntries(['update-banner', 'update-banner-text', 'update-now-btn']
    .map(id => [id, { textContent: '', disabled: false, hidden: true }]));
  let timerId = 0;
  class Channel {
    constructor(name) { this.name = name; Object.assign(this, events()); channels.add(this); }
    postMessage(message) {
      trace.push(['channel', message.type, message.requestId]);
      if (message.type === 'prepare') effects.prepares.push(message.requestId);
      if (message.type === 'blocked') effects.blocked.push(message.requestId);
      const deliver = () => { for (const peer of channels) if (peer !== this && peer.name === this.name) peer.emit('message', { data: message }); };
      if (state.delaySecond && message.type === 'prepare' && effects.prepares.length === 2) state.secondDelivery = deliver;
      else deliver();
    }
    close() { channels.delete(this); }
  }
  const origin = 'https://synthetic-pwa.invalid';
  const waiting = { postMessage(message) { trace.push(['worker', message.type]); effects.posts.push(message.type); } };
  const sw = { ...events(), controller: {}, register: async () => ({ waiting, addEventListener() {}, update() {} }) };
  const NativeDate = Date, math = Object.create(Math);
  math.random = () => ++state.sample / 100;
  class FixedDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [state.clock])); } static now() { return state.clock; } }
  const bindings = { document: { getElementById: id => elements[id] }, navigator: { serviceWorker: sw },
    location: { origin, reload() { effects.reloads++; } }, BroadcastChannel: Channel, Date: FixedDate, Math: math,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, setInterval() { return 1; } };
  for (const [key, value] of Object.entries(bindings)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const controller = createPwaUpdateController({ hasUnsavedPageInput: () => state.localDirty, isSyncing: () => false,
    isSavingHolding: () => false, clearAutoRefresh() { effects.clears++; }, startAutoRefresh() { effects.starts++; },
    stopAndDrain() { effects.drainCalls++; trace.push(['drain']); return drains.shift()?.promise || Promise.resolve(); },
    showToast: value => effects.toasts.push(value), updateIntervalMs: 1e6 });
  const ocrWindow = { ...events(), BroadcastChannel: Channel,
    document: { ...events(), documentElement: { style: { setProperty() {} } } } };
  const ocr = createOcrPageGuard({ window: ocrWindow, hasPendingWork: () => state.ocrDirty, isSaving: () => false,
    discard() { effects.discarded++; }, navigate() {}, notify() {}, restored() {} });
  controller.start(); ocr.start();
  t.after(() => {
    ocr.dispose();
    for (const key of keys) { if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]); else delete globalThis[key]; }
  });
  return { state, effects, elements, trace, controller, ocr,
    holdDrain() { const value = deferred(); drains.push(value); return value; },
    async ready() { await flush(); },
    async tickPeer() {
      const [id, timer] = timers.entries().next().value || [];
      assert.ok(timer, 'Expected an actual peer-observation wait'); assert.equal(timer.ms, 450);
      timers.delete(id); state.clock += timer.ms; timer.fn(); await flush();
    },
    ack() { sw.emit('message', { origin, source: waiting, data: { type: 'UPDATE_ACTIVATED' } }); },
    replaceController() { sw.controller = waiting; sw.emit('controllerchange', {}); },
  };
}
function paused(h, message) {
  assert.equal(h.controller.isUpdateApplying(), false);
  assert.equal(h.elements['update-now-btn'].disabled, false);
  assert.equal(h.elements['update-now-btn'].textContent, '安全更新');
  assert.equal(h.elements['update-banner-text'].textContent, message);
  assert.equal(h.effects.starts, 1); assert.equal(h.effects.posts.length, 0); assert.equal(h.effects.reloads, 0);
  assert.equal(h.effects.discarded, 0, 'The updater must not discard the independent OCR preview');
}

test('actual OCR peer becoming dirty during drain vetoes the second observation and preserves waiting', async t => {
  const h = harness(t); await h.ready(); const held = h.holdDrain();
  const applying = h.controller.applyPendingServiceWorkerUpdate(); await h.tickPeer();
  assert.equal(h.effects.drainCalls, 1); h.state.ocrDirty = true; held.resolve(); await flush();
  assert.equal(h.effects.prepares.length, 2); assert.equal(h.effects.blocked.length, 1);
  await h.tickPeer(); await applying;
  paused(h, '其他已打开页面有未保存输入，更新已暂停');
  assert.equal(h.state.ocrDirty, true);
});

test('actual OCR prepare delivered after becoming dirty inside the second wait still vetoes', async t => {
  const h = harness(t); h.state.delaySecond = true; await h.ready();
  const applying = h.controller.applyPendingServiceWorkerUpdate(); await h.tickPeer();
  assert.equal(h.effects.prepares.length, 2); assert.equal(typeof h.state.secondDelivery, 'function');
  h.state.ocrDirty = true; h.state.secondDelivery(); await h.tickPeer(); await applying;
  assert.equal(h.effects.blocked.length, 1); paused(h, '其他已打开页面有未保存输入，更新已暂停');
});

test('local input becoming dirty during the second peer await is rechecked before activation', async t => {
  const h = harness(t); await h.ready();
  const applying = h.controller.applyPendingServiceWorkerUpdate(); await h.tickPeer();
  assert.equal(h.effects.prepares.length, 2); h.ack(); assert.equal(h.effects.reloads, 0);
  h.state.localDirty = true;
  await h.tickPeer(); await applying;
  paused(h, '检测到未保存编辑，更新仍已暂停'); assert.equal(h.state.localDirty, true);
  h.ack(); assert.equal(h.effects.reloads, 0, 'An aborted attempt must not authorize an activation ACK');
});

test('drain rejection keeps the existing recovery and clean retry performs both observations', async t => {
  const h = harness(t); await h.ready(); const held = h.holdDrain();
  const failed = h.controller.applyPendingServiceWorkerUpdate(); await h.tickPeer();
  held.reject(new Error('Synthetic drain failure')); await failed;
  paused(h, '安全更新未完成，可稍后重试'); assert.equal(h.effects.prepares.length, 1);
  const retry = h.controller.applyPendingServiceWorkerUpdate(); await h.tickPeer();
  assert.equal(h.effects.prepares.length, 3); await h.tickPeer(); await retry;
  assert.deepEqual(h.effects.posts, ['SKIP_WAITING']); h.ack(); assert.equal(h.effects.reloads, 1);
});

test('after a blocked OCR preview is explicitly cleared, a fresh retry can safely request activation', async t => {
  const h = harness(t); await h.ready(); const held = h.holdDrain();
  const first = h.controller.applyPendingServiceWorkerUpdate(); await h.tickPeer();
  h.state.ocrDirty = true; held.resolve(); await flush();
  assert.equal(h.effects.prepares.length, 2); await h.tickPeer(); await first;
  paused(h, '其他已打开页面有未保存输入，更新已暂停');
  h.state.ocrDirty = false;
  const retry = h.controller.applyPendingServiceWorkerUpdate(); await h.tickPeer(); await h.tickPeer(); await retry;
  assert.equal(h.effects.prepares.length, 4); assert.deepEqual(h.effects.posts, ['SKIP_WAITING']);
  assert.equal(h.effects.drainCalls, 2); h.ack(); assert.equal(h.effects.reloads, 1);
});

test('clean current updater performs two real observations without changing public APIs', async t => {
  const h = harness(t); await h.ready();
  assert.deepEqual(Object.keys(h.controller), ['start', 'hasServiceWorkerUpdateBlocker', 'applyPendingServiceWorkerUpdate', 'isUpdateApplying']);
  const applying = h.controller.applyPendingServiceWorkerUpdate(); await h.tickPeer();
  assert.equal(h.effects.posts.length, 0); assert.equal(h.effects.prepares.length, 2);
  await h.tickPeer(); await applying;
  assert.deepEqual(h.effects.posts, ['SKIP_WAITING']);
  assert.equal(h.effects.starts, 0); assert.equal(h.effects.drainCalls, 1);
  assert.ok(h.trace.findIndex(row => row[0] === 'drain') < h.trace.findLastIndex(row => row[0] === 'channel' && row[1] === 'prepare'));
  assert.equal(h.controller.isUpdateApplying(), true); h.ack(); assert.equal(h.effects.reloads, 1);
});

test('native-controller replacement during the second wait becomes only a local reload, never another activation request', async t => {
  const h = harness(t); await h.ready();
  const applying = h.controller.applyPendingServiceWorkerUpdate(); await h.tickPeer();
  assert.equal(h.effects.prepares.length, 2); h.replaceController();
  assert.equal(h.effects.reloads, 0); await h.tickPeer(); await applying;
  assert.deepEqual(h.effects.posts, []); assert.equal(h.effects.reloads, 1);
});
