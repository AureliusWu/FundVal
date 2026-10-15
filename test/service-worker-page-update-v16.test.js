import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSync } from 'rolldown/utils';

const source = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const program = parseSync('app.js', source).program;
const text = node => source.slice(node.start, node.end);
const declaration = name => program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
const first = declaration('holdingEditorValue'), last = declaration('consumeOcrImportReturn');
assert.ok(first && last, 'Extract the real page-update function region, not a copied helper.');
const functions = program.body.filter(node => node.type === 'FunctionDeclaration' && node.start >= first.start && node.end <= last.start);
for (const name of ['hasServiceWorkerUpdateBlocker', 'otherPageBlocksServiceWorkerUpdate',
  'showServiceWorkerUpdate', 'handleActivatedServiceWorker', 'applyPendingServiceWorkerUpdate']) {
  assert.ok(functions.some(node => node.id.name === name), `Missing real function ${name}`);
}
const registration = program.body.filter(node => node.type === 'IfStatement'
  && text(node).includes("navigator.serviceWorker.register('sw.js')")
  && text(node).includes("'controllerchange'"));
assert.equal(registration.length, 1, 'Execute the unique real registration/listener block.');
const stateNames = new Set(['editingCode', 'editingSnapshot', 'isSavingHolding', 'isSyncing', 'autoRefreshTimer', 'GIST_TOKEN_KEY']);
const declarations = program.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
  .filter(node => node.id.type === 'Identifier' && (stateNames.has(node.id.name) || /[sS]erviceWorker/.test(node.id.name)));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function harness(options = {}) {
  const origin = 'https://fundval.example.test';
  const trace = [], timers = new Map(), listeners = new Map(), drains = [];
  const elements = Object.fromEntries(['i-code', 'i-name', 'i-shares', 'i-cost', 'gist-token',
    'update-banner', 'update-banner-text', 'update-now-btn'].map(id => [id, { value: '', textContent: '', disabled: false, hidden: true }]));
  let now = Date.parse('2026-10-15T06:30:00Z'), timerId = 0, reloads = 0, channel;
  const add = (map, type, fn) => map.set(type, [...map.get(type) || [], fn]);
  const remove = (map, type, fn) => map.set(type, (map.get(type) || []).filter(value => value !== fn));
  function worker(name, state) {
    return { name, state, scriptURL: `${origin}/FundVal/sw.js`, postMessage(message) {
      trace.push(`post:${name}:${message.type}`);
      options.post?.(this, message);
    } };
  }
  const previous = options.firstInstall ? null : worker('previous', 'activated');
  const waiting = worker('waiting', 'installed');
  const reg = { waiting: options.firstInstall ? null : waiting, installing: null,
    addEventListener() {}, update() { trace.push('registration:update'); } };
  const serviceWorker = { controller: previous,
    register(path) { trace.push(`register:${path}`); return Promise.resolve(reg); },
    addEventListener(type, fn) { add(listeners, type, fn); } };
  class Channel {
    constructor(name) { this.name = name; this.listeners = new Map(); channel = this; }
    addEventListener(type, fn) { add(this.listeners, type, fn); }
    removeEventListener(type, fn) { remove(this.listeners, type, fn); }
    postMessage(message) { trace.push(`channel:${message.type}`); this.lastMessage = message; }
    emit(message) { for (const fn of [...this.listeners.get('message') || []]) fn({ data: message }); }
  }
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const math = Object.create(Math);
  math.random = () => 0.25;
  const bindings = {
    document: { getElementById: id => elements[id] || null }, navigator: { serviceWorker },
    location: { origin, href: `${origin}/FundVal/`, reload() { reloads++; trace.push('reload'); } },
    BroadcastChannel: Channel, Date: FixedDate, Math: math, URL,
    TIMING: { SW_UPDATE_MS: 1_800_000 },
    safeGetItem: () => '',
    showToast: message => trace.push(`toast:${message}`),
    startAutoRefresh: () => trace.push('refresh:restart'),
    refreshCoordinator: { stopAndDrain(reason) {
      trace.push(`drain:${reason}`);
      return drains.shift()?.promise || Promise.resolve();
    } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms, ms }); return id; },
    clearTimeout(id) { timers.delete(id); trace.push(`timeout:clear:${id}`); },
    setInterval(fn, ms) { trace.push(`interval:${ms}`); return ++timerId; },
  };
  // All policy helpers and listeners below are exact AST slices of app.js.
  // Only platform IO/clock/DOM and the refresh drain boundary are synthetic.
  const instance = new Function(...Object.keys(bindings), [
    ...declarations.map(node => `let ${text(node)};`),
    ...functions.map(text), text(registration[0]),
    'return { apply: applyPendingServiceWorkerUpdate, show: showServiceWorkerUpdate,',
    'state: () => ({ applying: serviceWorkerUpdateApplying, pendingReload: serviceWorkerReloadPending,',
    'pending: pendingServiceWorker, reloading: reloadingForServiceWorkerUpdate }),',
    'setSyncing: value => { isSyncing = value; }, setSaving: value => { isSavingHolding = value; },',
    'setTimer: value => { autoRefreshTimer = value; } };',
  ].join('\n'))(...Object.values(bindings));
  function emit(type, event = {}) { for (const fn of [...listeners.get(type) || []]) fn(event); }
  return { ...instance, trace, elements, origin, previous, waiting, reg,
    reloads: () => reloads,
    posted: () => trace.filter(value => value.startsWith('post:')),
    drainCount: () => trace.filter(value => value.startsWith('drain:')).length,
    prepareCount: () => trace.filter(value => value === 'channel:prepare').length,
    holdDrain() { const value = deferred(); drains.push(value); return value; },
    changeController(value) { serviceWorker.controller = value; emit('controllerchange'); },
    ack(value = waiting, ackOrigin = origin) { emit('message', { origin: ackOrigin, source: value, data: { type: 'UPDATE_ACTIVATED' } }); },
    blockPeer() { channel.emit({ type: 'blocked', requestId: channel.lastMessage.requestId }); },
    async tick(ms = 450) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await flush();
    },
    ready: flush,
  };
}

test('first installation keeps one clean reload, while unchanged/null controller events are ignored', async () => {
  const h = harness({ firstInstall: true });
  await h.ready();
  h.changeController(null);
  assert.equal(h.reloads(), 0, 'A null-to-null notification is not a first installation.');
  h.changeController(h.waiting);
  assert.equal(h.reloads(), 1);
  h.changeController(h.waiting);
  assert.equal(h.reloads(), 1);
});

test('a dirty first installation preserves the draft and shows a pending local reload', async () => {
  const h = harness({ firstInstall: true });
  await h.ready();
  h.elements['i-name'].value = '未保存的合成草稿';
  h.changeController(h.waiting);
  assert.equal(h.reloads(), 0);
  assert.equal(h.state().pendingReload, true);
  assert.equal(h.elements['i-name'].value, '未保存的合成草稿');
});

test('an unrequested native controller replacement only offers a local reload, even for a clean peer', async () => {
  const h = harness();
  await h.ready();
  h.changeController(h.waiting);
  assert.equal(h.reloads(), 0, 'A peer without its own activation request must not reload.');
  assert.equal(h.state().pendingReload, true);
  assert.equal(h.elements['update-banner'].hidden, false);
  assert.equal(h.elements['update-now-btn'].textContent, '重新载入');
});

test('a null notification cannot erase an existing controller and authorize a peer reload', async () => {
  const h = harness();
  await h.ready();
  h.changeController(null);
  assert.equal(h.reloads(), 0);
  h.changeController(h.waiting);
  assert.equal(h.reloads(), 0, 'An already controlled peer is not a first installation after a null notification.');
  assert.equal(h.state().pendingReload, true);
});

test('an activation message without an explicit local request is ignored', async () => {
  const h = harness();
  await h.ready();
  h.ack();
  assert.equal(h.reloads(), 0);
  assert.equal(h.state().pendingReload, false);
});

test('a requested activation ACK requires both exact source identity and same origin', async () => {
  const h = harness();
  await h.ready();
  const update = h.apply();
  await h.tick();
  await update;
  assert.equal(h.posted().length, 1);
  h.ack(h.waiting, 'https://other.example.test');
  h.ack(h.previous);
  h.ack(null);
  assert.equal(h.reloads(), 0);
  h.ack();
  assert.equal(h.reloads(), 1);
  h.changeController(h.waiting);
  h.ack();
  assert.equal(h.reloads(), 1, 'ACK/controllerchange duplicates cannot cause a second reload.');
});

test('the activation request is registered before its postMessage can synchronously produce an ACK', async () => {
  let h;
  h = harness({ post(worker) { h.ack(worker); } });
  await h.ready();
  const update = h.apply();
  await h.tick();
  await update;
  assert.equal(h.reloads(), 1);
  assert.ok(h.trace.indexOf('drain:service-worker-update') < h.trace.indexOf('post:waiting:SKIP_WAITING'));
});

test('dirty input before update prevents both broadcast preparation and drain', async () => {
  const h = harness();
  await h.ready();
  h.elements['i-shares'].value = '123';
  await h.apply();
  assert.equal(h.prepareCount(), 0);
  assert.equal(h.drainCount(), 0);
  assert.equal(h.posted().length, 0);
});

test('an active cloud sync or holding save blocks the update before drain', async () => {
  for (const setter of ['setSyncing', 'setSaving']) {
    const h = harness();
    await h.ready();
    h[setter](true);
    await h.apply();
    assert.equal(h.drainCount(), 0);
    assert.equal(h.posted().length, 0);
  }
});

test('dirty input introduced during drain is retained and cannot authorize a subsequent ACK', async () => {
  const h = harness();
  await h.ready();
  const drain = h.holdDrain(), update = h.apply();
  await h.tick();
  assert.equal(h.drainCount(), 1);
  assert.equal(h.state().applying, true);
  h.elements['i-name'].value = '排空中出现的草稿';
  drain.resolve();
  await update;
  assert.equal(h.posted().length, 0);
  assert.equal(h.reloads(), 0);
  assert.equal(h.state().applying, false);
  assert.equal(h.elements['update-now-btn'].disabled, false);
  assert.equal(h.elements['i-name'].value, '排空中出现的草稿');
  h.elements['i-name'].value = '';
  h.ack();
  assert.equal(h.reloads(), 0, 'Clearing a draft does not authorize an unsolicited activation ACK.');
});

test('a blocked peer prevents activation when no controller replacement occurred', async () => {
  const h = harness();
  await h.ready();
  const update = h.apply();
  h.blockPeer();
  await h.tick();
  await update;
  assert.equal(h.drainCount(), 0);
  assert.equal(h.posted().length, 0);
  assert.equal(h.reloads(), 0);
});

test('two clicks awaiting the same cross-page window cannot start parallel drains', async () => {
  const h = harness();
  await h.ready();
  const drain = h.holdDrain(), firstUpdate = h.apply(), secondUpdate = h.apply();
  await h.tick();
  assert.equal(h.drainCount(), 1);
  drain.resolve();
  await Promise.all([firstUpdate, secondUpdate]);
  assert.equal(h.posted().length, 1);
});

test('a peer activation during drain defers reload, leaves the applying button disabled and never posts to the activated worker', async () => {
  const h = harness();
  await h.ready();
  const drain = h.holdDrain(), update = h.apply();
  await h.tick();
  h.changeController(h.waiting);
  assert.equal(h.reloads(), 0);
  assert.equal(h.state().pendingReload, true);
  assert.equal(h.state().applying, true);
  assert.equal(h.elements['update-now-btn'].disabled, true);
  await h.apply();
  assert.equal(h.drainCount(), 1);
  drain.resolve();
  await update;
  assert.equal(h.reloads(), 1);
  assert.equal(h.posted().length, 0);
});

test('a pending local reload waits for drain but does not ask other tabs to permit an activation', async () => {
  const h = harness();
  await h.ready();
  h.changeController(h.waiting);
  const drain = h.holdDrain(), update = h.apply();
  await flush();
  assert.equal(h.prepareCount(), 0);
  assert.equal(h.drainCount(), 1);
  assert.equal(h.reloads(), 0);
  drain.resolve();
  await update;
  assert.equal(h.reloads(), 1);
  assert.equal(h.posted().length, 0);
});

test('a draft introduced while draining a local reload is rechecked and survives until an explicit clean retry', async () => {
  const h = harness();
  await h.ready();
  h.changeController(h.waiting);
  const drain = h.holdDrain(), update = h.apply();
  await flush();
  h.elements['i-cost'].value = '1.2345';
  drain.resolve();
  await update;
  assert.equal(h.reloads(), 0);
  assert.equal(h.state().applying, false);
  assert.equal(h.elements['i-cost'].value, '1.2345');
  h.elements['i-cost'].value = '';
  await h.apply();
  assert.equal(h.reloads(), 1);
  assert.equal(h.drainCount(), 2);
  assert.equal(h.posted().length, 0);
});

test('a controller replacement during the broadcast window converts even a peer veto into local-only drain/reload', async () => {
  const h = harness();
  await h.ready();
  const update = h.apply();
  h.blockPeer();
  h.changeController(h.waiting);
  await h.tick();
  await update;
  assert.equal(h.drainCount(), 1);
  assert.equal(h.reloads(), 1);
  assert.equal(h.posted().length, 0);
});

test('an ACK received during drain before a local activation request cannot reload early', async () => {
  const h = harness();
  await h.ready();
  const drain = h.holdDrain(), update = h.apply();
  await h.tick();
  h.ack();
  assert.equal(h.reloads(), 0);
  drain.resolve();
  await update;
  assert.equal(h.posted().length, 1);
  h.ack();
  assert.equal(h.reloads(), 1);
});

test('a failed post clears request authorization and allows a clean retry', async () => {
  let attempts = 0;
  const h = harness({ post() { if (++attempts === 1) throw new Error('synthetic post failure'); } });
  await h.ready();
  const firstUpdate = h.apply();
  await h.tick();
  await firstUpdate;
  assert.equal(h.state().applying, false);
  assert.equal(h.elements['update-now-btn'].disabled, false);
  h.ack();
  assert.equal(h.reloads(), 0, 'A failed post must not leave a requester identity authorized.');
  const retry = h.apply();
  await h.tick();
  await retry;
  assert.equal(attempts, 2);
  h.ack();
  assert.equal(h.reloads(), 1);
});
