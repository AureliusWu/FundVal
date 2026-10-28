import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { parseSync } from 'rolldown/utils';
import { legacyDirtyHelpers, legacyPolicy, legacyRegistration } from './fixtures/pwa-update-v15-reference.js';
import { m5PostDrainPeerGuard, m5PostDrainPeerGuardSha256 } from './fixtures/pwa-update-m5-delta.js';

// Explicit M5 delta-excluding v15 compatibility projection. This suite retains
// all old assertions/oracle bytes but no longer claims full-current behavior
// equality. Full actual second-wait behavior runs in pwa-ocr-drain-guard-m5.
function projectM5SecondObservation(fullSource) {
  assert.equal(createHash('sha256').update(m5PostDrainPeerGuard).digest('hex'), m5PostDrainPeerGuardSha256);
  const first = fullSource.indexOf(m5PostDrainPeerGuard);
  assert.ok(first > 0, 'The exact independently bound M5 guard must be present');
  assert.equal(fullSource.lastIndexOf(m5PostDrainPeerGuard), first, 'Only one M5 guard may be projected');
  const program = parseSync('pwa-full-current.js', fullSource).program;
  const factory = program.body.find(node => node.type === 'ExportNamedDeclaration'
    && node.declaration?.id?.name === 'createPwaUpdateController')?.declaration;
  assert.ok(factory, 'Expected the actual public factory');
  const apply = factory.body.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'applyPendingServiceWorkerUpdate');
  const attempts = apply.body.body.filter(node => node.type === 'TryStatement');
  assert.equal(attempts.length, 1, 'The original single drain/activation try owner remains');
  const statements = attempts[0].block.body;
  assert.equal(statements[0].expression?.type, 'AwaitExpression');
  assert.equal(statements[0].expression.argument?.callee?.name, 'stopAndDrain');
  assert.equal(statements[1].test?.callee?.name, 'hasServiceWorkerUpdateBlocker');
  const added = statements[2];
  assert.equal(added.type, 'IfStatement');
  assert.equal(added.start, first, 'The one exact delta must follow the original local drain recheck');
  assert.equal(fullSource.slice(added.start, added.end), m5PostDrainPeerGuard);
  assert.equal(statements[3].test?.name, 'serviceWorkerReloadPending', 'The original local-reload branch must immediately follow');
  return fullSource.slice(0, added.start) + fullSource.slice(added.end);
}

const source = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const program = parseSync('app.js', source).program;
const text = node => source.slice(node.start, node.end);
const declaration = name => program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
const functions = ['holdingEditorValue', 'hasUnsavedHoldingEditorInput', 'hasUnsavedPageInput'].map(declaration);
assert.ok(functions.every(Boolean), 'Execute the real App dirty-form helpers, not copied helpers.');
const fullControllerSource = (await readFile(new URL('../js/runtime/pwa-update-controller.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const controllerSource = projectM5SecondObservation(fullControllerSource);
const controllerProgram = parseSync('pwa-update-controller.js', controllerSource).program;
const factory = controllerProgram.body.find(node => node.type === 'ExportNamedDeclaration'
  && node.declaration?.id?.name === 'createPwaUpdateController')?.declaration;
assert.ok(factory, 'Execute the actual exported controller factory.');
const returned = factory.body.body.at(-1);
assert.equal(returned.type, 'ReturnStatement');
// Read-only state instrumentation changes only the returned test view. Every
// production policy, registration and listener statement stays the actual AST.
const stateView = `state: () => ({ applying: serviceWorkerUpdateApplying, pendingReload: serviceWorkerReloadPending,
  pending: pendingServiceWorker, reloading: reloadingForServiceWorkerUpdate }), show: showServiceWorkerUpdate`;
const factoryText = controllerSource.slice(factory.start, returned.start)
  + `return Object.assign(${controllerSource.slice(returned.argument.start, returned.argument.end)}, { ${stateView} });`
  + controllerSource.slice(returned.end, factory.end);
const appHarnessState = `let editingCode = null, editingSnapshot = null, isSavingHolding = false,
  isSyncing = false, autoRefreshTimer = null; const GIST_TOKEN_KEY = 'fuyu_gist_token';`;
const legacyState = `let pendingServiceWorker = null, requestedServiceWorker = null, serviceWorkerUpdateApplying = false,
  serviceWorkerReloadPending = false, serviceWorkerUpdateChannel = null, reloadingForServiceWorkerUpdate = false;`;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function harness(options = {}) {
  const origin = 'https://fundval.example.test';
  const trace = [], timers = new Map(), listeners = new Map(), drains = [];
  const credentials = { token: options.token || '', mode: options.credentialMode || 'session' };
  const elements = Object.fromEntries(['i-code', 'i-name', 'i-shares', 'i-cost', 'gist-token', 'gist-remember-token',
    'update-banner', 'update-banner-text', 'update-now-btn'].map(id => [id, { value: '', textContent: '', disabled: false, hidden: true }]));
  elements['gist-token'].value = credentials.token;
  elements['gist-remember-token'].checked = credentials.mode === 'persistent';
  for (const id of options.missingElements || []) delete elements[id];
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
  const registrationListeners = new Map(), workerListeners = new Map();
  const reg = { waiting: options.firstInstall ? null : waiting, installing: null,
    addEventListener(type, fn) { add(registrationListeners, type, fn); }, update() { trace.push('registration:update'); } };
  const serviceWorker = { controller: previous,
    register(path) {
      trace.push(`register:${path}`);
      if (options.registrationThrows) throw new Error('registration threw');
      return options.registrationFails ? Promise.reject(new Error('registration failed')) : Promise.resolve(reg);
    },
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
    document: { getElementById: id => elements[id] || null }, navigator: options.noServiceWorker ? {} : { serviceWorker },
    location: { origin, href: `${origin}/FundVal/`, reload() { reloads++; trace.push('reload'); } },
    BroadcastChannel: options.noBroadcastChannel ? undefined : options.channelThrows ? class { constructor() { throw new Error('channel failed'); } } : Channel,
    Date: FixedDate, Math: math, URL,
    TIMING: { SW_UPDATE_MS: 1_800_000 },
    // Only the App's credential readers are synthetic; execute the actual dirty
    // helper with its new M4 session/persistence inputs, not a copied predicate.
    getGistToken: () => credentials.token,
    gistCredentialStore: { read: () => ({ mode: credentials.mode }) },
    safeGetItem: () => credentials.token,
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
  const policy = options.legacy
    ? `${legacyState}\n${legacyPolicy}\nfunction start() { ${legacyRegistration} }\nconst controller = {
      start, applyPendingServiceWorkerUpdate, hasServiceWorkerUpdateBlocker,
      isUpdateApplying: () => serviceWorkerUpdateApplying, ${stateView} };`
    : `${factoryText}\nconst controller = createPwaUpdateController({ hasUnsavedPageInput,
      isSyncing: () => isSyncing, isSavingHolding: () => isSavingHolding,
      clearAutoRefresh() { if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = null; } },
      startAutoRefresh, stopAndDrain: reason => refreshCoordinator.stopAndDrain(reason), showToast,
      updateIntervalMs: TIMING.SW_UPDATE_MS });`;
  // IO/clock/DOM/drain and App-state callbacks are synthetic; policy is either
  // the frozen pre-extraction oracle or the actual current module factory.
  const instance = new Function(...Object.keys(bindings), [
    appHarnessState, ...(options.legacy ? [legacyDirtyHelpers] : functions.map(text)), policy,
    options.deferStart ? '' : 'controller.start();',
    'return { apply: controller.applyPendingServiceWorkerUpdate, show: controller.show, start: controller.start,',
    'state: controller.state, isUpdateApplying: controller.isUpdateApplying, blocker: controller.hasServiceWorkerUpdateBlocker,',
    'setSyncing: value => { isSyncing = value; }, setSaving: value => { isSavingHolding = value; },',
    'setTimer: value => { autoRefreshTimer = value; } };',
  ].join('\n'))(...Object.values(bindings));
  function emit(type, event = {}) { for (const fn of [...listeners.get(type) || []]) fn(event); }
  return { ...instance, trace, elements, origin, previous, waiting, reg,
    setCredentials(token, mode = credentials.mode) { credentials.token = token; credentials.mode = mode; },
    reloads: () => reloads,
    posted: () => trace.filter(value => value.startsWith('post:')),
    drainCount: () => trace.filter(value => value.startsWith('drain:')).length,
    prepareCount: () => trace.filter(value => value === 'channel:prepare').length,
    holdDrain() { const value = deferred(); drains.push(value); return value; },
    changeController(value) { serviceWorker.controller = value; emit('controllerchange'); },
    ack(value = waiting, ackOrigin = origin) { emit('message', { origin: ackOrigin, source: value, data: { type: 'UPDATE_ACTIVATED' } }); },
    blockPeer() { channel.emit({ type: 'blocked', requestId: channel.lastMessage.requestId }); },
    emitPrepare(message = { type: 'prepare', requestId: 'peer-request' }) { channel.emit(message); },
    channelMessage: () => channel?.lastMessage,
    listenerCounts: () => Object.fromEntries([...listeners].map(([key, value]) => [key, value.length])),
    registrationListenerCounts: () => Object.fromEntries([...registrationListeners].map(([key, value]) => [key, value.length])),
    updateFound() { for (const fn of registrationListeners.get('updatefound') || []) fn(); },
    installWorker(state = 'installing') {
      const next = worker('installing', state);
      next.addEventListener = (type, fn) => add(workerListeners, type, fn);
      reg.installing = next;
      for (const fn of registrationListeners.get('updatefound') || []) fn();
      return { next, state(value) { next.state = value; for (const fn of workerListeners.get('statechange') || []) fn(); } };
    },
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

const digest = value => createHash('sha256').update(value).digest('hex');
const withoutPositions = value => Array.isArray(value) ? value.map(withoutPositions)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['start', 'end', 'loc', 'raw'].includes(key))
    .map(([key, child]) => [key, withoutPositions(child)])) : value;

test('the independent oracle stays byte-bound to the pre-extraction App, not the new module', () => {
  // These hashes were taken from the six original App function declarations
  // and original registration IfStatement before extraction, not recomputed
  // from the controller. Keep this self-contained fixture usable in clean CI.
  assert.equal(Buffer.byteLength(legacyPolicy), 4756);
  assert.equal(digest(legacyPolicy), '1117cf166b68115f0d8f84fdbf92e6bd9dce35c52b9f8f8a0085451160ee2033');
  assert.equal(Buffer.byteLength(legacyRegistration), 1998);
  assert.equal(digest(legacyRegistration), 'faeab3ddbb03ba11413bf055c548d3552f35cf87647ff47dfb27da49cb2d75f6');
  assert.equal(Buffer.byteLength(legacyDirtyHelpers), 1128);
  assert.equal(digest(legacyDirtyHelpers), '0a16a8c8d1eac8e56f1d2e32c56647789d8e55333931d3f6899ce210e4480093');
  const oldHelpers = parseSync('pwa-old-editor-helpers.js', legacyDirtyHelpers).program.body;
  assert.deepEqual(withoutPositions(functions.slice(0, 2)), withoutPositions(oldHelpers.slice(0, 2)),
    'holding-editor dirty detection remains exactly the frozen pre-extraction behavior');
  // M4 intentionally replaces persistent-token reads with the live credential
  // interface and adds the remember-token draft. This is not a controller-policy
  // migration or permission to rewrite the independent old oracle. Exercise that
  // explicit new dirty-input behavior below, while common inputs still run the
  // complete frozen old/current transcript matrix unchanged.
  assert.match(text(functions[2]), /getGistToken\(\)/);
  assert.match(text(functions[2]), /gistCredentialStore\?\.read\(\)\.mode/);
  assert.match(text(functions[2]), /gist-remember-token/);
});

test('M5 compatibility projection rejects missing, modified, duplicated or relocated guard and keeps all other differences', () => {
  for (const changed of [
    fullControllerSource.replace(m5PostDrainPeerGuard, ''),
    fullControllerSource.replace('var localBlocked = hasServiceWorkerUpdateBlocker();', 'var localBlocked = false;'),
    fullControllerSource.replace(m5PostDrainPeerGuard, m5PostDrainPeerGuard + '\n' + m5PostDrainPeerGuard),
    fullControllerSource.replace(m5PostDrainPeerGuard, '').replace('requestedServiceWorker = worker;', m5PostDrainPeerGuard + '\nrequestedServiceWorker = worker;'),
  ]) assert.throws(() => projectM5SecondObservation(changed));
  const outside = fullControllerSource.replace("worker.postMessage({ type: 'SKIP_WAITING' });", "worker.postMessage({ type: 'BROKEN_SKIP_WAITING' });");
  assert.notDeepEqual(withoutPositions(parseSync('projected-mutant.js', projectM5SecondObservation(outside)).program),
    withoutPositions(controllerProgram), 'Projection cannot hide any other changed policy statement');
});

test('M4 current dirty helper reads the saved session token and blocks an unsaved credential edit', async () => {
  const h = harness({ token: 'synthetic-session-token' });
  await h.ready(); assert.equal(h.blocker(), false, 'Matching session credentials are clean without persistent storage');
  h.elements['gist-token'].value = 'synthetic-edited-token';
  assert.equal(h.blocker(), true); await h.apply(); h.ack();
  assert.equal(h.prepareCount(), 0); assert.equal(h.drainCount(), 0); assert.equal(h.posted().length, 0); assert.equal(h.reloads(), 0);
  assert.equal(h.elements['gist-token'].value, 'synthetic-edited-token');
});

test('M4 remember-token draft blocks before activation and is rechecked after drain', async () => {
  const h = harness({ token: 'synthetic-session-token' }); await h.ready();
  h.elements['gist-remember-token'].checked = true; assert.equal(h.blocker(), true);
  await h.apply(); assert.equal(h.prepareCount(), 0); assert.equal(h.drainCount(), 0);
  h.elements['gist-remember-token'].checked = false;
  const drain = h.holdDrain(), applying = h.apply(); await h.tick(); assert.equal(h.drainCount(), 1);
  h.elements['gist-remember-token'].checked = true; drain.resolve(); await applying; h.ack();
  assert.equal(h.posted().length, 0); assert.equal(h.reloads(), 0); assert.equal(h.isUpdateApplying(), false);
  assert.equal(h.elements['gist-remember-token'].checked, true, 'The unsaved persistence choice survives drain');
});

test('M4 persistent credential mode and live credential changes remain dirty-update blockers', async () => {
  const h = harness({ token: 'synthetic-persistent-token', credentialMode: 'persistent' }); await h.ready();
  assert.equal(h.blocker(), false); h.elements['gist-remember-token'].checked = false;
  assert.equal(h.blocker(), true); h.elements['gist-remember-token'].checked = true;
  h.setCredentials('synthetic-new-session-token', 'session');
  assert.equal(h.blocker(), true); await h.apply();
  assert.equal(h.prepareCount(), 0); assert.equal(h.posted().length, 0); assert.equal(h.reloads(), 0);
});

test('M4 persistence draft prevents a first-install reload and keeps unauthorized ACK inert', async () => {
  const h = harness({ firstInstall: true }); await h.ready(); h.elements['gist-remember-token'].checked = true;
  h.changeController(h.waiting); h.ack();
  assert.equal(h.reloads(), 0); assert.equal(h.state().pendingReload, true);
  assert.equal(h.elements['gist-remember-token'].checked, true);
});

test('M5 delta-excluding factory view preserves old policy and registration except the explicit callback seams', () => {
  const clearTimer = `if (autoRefreshTimer) {\n    clearTimeout(autoRefreshTimer);\n    autoRefreshTimer = null;\n  }`;
  assert.equal(legacyPolicy.split(clearTimer).length, 2, 'one original timer ownership block');
  const expectedPolicy = legacyPolicy.replace(/\bisSyncing\b/g, 'isSyncing()')
    .replace(/\bisSavingHolding\b/g, 'isSavingHolding()')
    .replace(clearTimer, 'clearAutoRefresh();')
    .replace('refreshCoordinator.stopAndDrain', 'stopAndDrain');
  const expected = parseSync('pwa-original-policy.js', `${expectedPolicy}\nfunction start() {\n${legacyRegistration
    .replace('TIMING.SW_UPDATE_MS', 'updateIntervalMs')}\n}`).program.body;
  const actualFunctions = factory.body.body.filter(node => node.type === 'FunctionDeclaration');
  assert.deepEqual(actualFunctions.map(node => node.id.name), expected.map(node => node.id.name));
  assert.deepEqual(withoutPositions(actualFunctions), withoutPositions(expected));
  const originalState = parseSync('pwa-original-state.js', legacyState).program.body;
  const declarations = nodes => nodes.filter(node => node.type === 'VariableDeclaration')
    .flatMap(node => node.declarations.map(declaration => ({ kind: node.kind, declaration })));
  assert.deepEqual(withoutPositions(declarations(factory.body.body)), withoutPositions(declarations(originalState)));
  assert.deepEqual(factory.params[0].properties.map(node => node.key.name), [
    'hasUnsavedPageInput', 'isSyncing', 'isSavingHolding', 'clearAutoRefresh',
    'startAutoRefresh', 'stopAndDrain', 'showToast', 'updateIntervalMs',
  ]);
  assert.deepEqual(returned.argument.properties.map(node => node.key.name), [
    'start', 'hasServiceWorkerUpdateBlocker', 'applyPendingServiceWorkerUpdate', 'isUpdateApplying',
  ], 'private state/show instrumentation must remain test-only');
  assert.equal(controllerProgram.body.length, 1, 'no top-level listeners, IO or global test hook');
});

function transcriptState(h) {
  const state = h.state();
  return {
    state: { ...state, pending: state.pending?.name || null },
    applying: h.isUpdateApplying(),
    reloads: h.reloads(),
    trace: [...h.trace],
    elements: Object.fromEntries(Object.entries(h.elements).map(([key, value]) => [key, { ...value }])),
    listeners: h.listenerCounts(),
    registrationListeners: h.registrationListenerCounts(),
    channel: h.channelMessage() ? { ...h.channelMessage() } : null,
  };
}

const pairedScenarios = [
  { name: 'first install, null and duplicate controller events', options: () => ({ firstInstall: true }),
    async run(h, mark) { await h.ready(); mark(); h.changeController(null); mark(); h.changeController(h.waiting); mark(); h.changeController(h.waiting); mark(); } },
  { name: 'dirty first install preserves the draft', options: () => ({ firstInstall: true }),
    async run(h, mark) { await h.ready(); h.elements['i-name'].value = '合成草稿'; h.changeController(h.waiting); mark(); } },
  { name: 'clean peer replacement, null then replacement and unrequested ACK',
    async run(h, mark) { await h.ready(); h.changeController(null); mark(); h.ack(); mark(); h.changeController(h.waiting); mark(); h.changeController(h.waiting); mark(); } },
  { name: 'requested ACK exact origin/source and duplicate suppression',
    async run(h, mark) { await h.ready(); const apply = h.apply(); mark(); await h.tick(); await apply; mark(); h.ack(h.waiting, 'https://wrong.invalid'); h.ack(h.previous); h.ack(null); mark(); h.ack(); mark(); h.changeController(h.waiting); h.ack(); mark(); } },
  { name: 'synchronous ACK during postMessage', options: get => ({ post(worker) { get().ack(worker); } }),
    async run(h, mark) { await h.ready(); const apply = h.apply(); await h.tick(); await apply; mark(); } },
  { name: 'dirty input before apply',
    async run(h, mark) { await h.ready(); h.elements['i-shares'].value = '123'; await h.apply(); mark(); } },
  { name: 'live sync state and save state before apply',
    async run(h, mark) { await h.ready(); h.setSyncing(true); await h.apply(); mark(); h.setSyncing(false); h.setSaving(true); await h.apply(); mark(); } },
  { name: 'draft introduced during drain and unauthorized ACK',
    async run(h, mark) { await h.ready(); const drain = h.holdDrain(), apply = h.apply(); await h.tick(); mark(); h.elements['i-name'].value = '排空草稿'; drain.resolve(); await apply; mark(); h.elements['i-name'].value = ''; h.ack(); mark(); } },
  { name: 'blocked peer rejects apply without drain',
    async run(h, mark) { await h.ready(); const apply = h.apply(); h.blockPeer(); await h.tick(); await apply; mark(); } },
  { name: 'parallel clicks share one drain ownership',
    async run(h, mark) { await h.ready(); const drain = h.holdDrain(), first = h.apply(), second = h.apply(); await h.tick(); mark(); drain.resolve(); await Promise.all([first, second]); mark(); } },
  { name: 'peer replacement while draining defers and never posts',
    async run(h, mark) { await h.ready(); const drain = h.holdDrain(), apply = h.apply(); await h.tick(); h.changeController(h.waiting); mark(); await h.apply(); mark(); drain.resolve(); await apply; mark(); } },
  { name: 'pending local reload skips broadcast and waits for drain',
    async run(h, mark) { await h.ready(); h.changeController(h.waiting); const drain = h.holdDrain(), apply = h.apply(); await flush(); mark(); drain.resolve(); await apply; mark(); } },
  { name: 'pending reload draft recheck and explicit retry',
    async run(h, mark) { await h.ready(); h.changeController(h.waiting); const drain = h.holdDrain(), apply = h.apply(); await flush(); h.elements['i-cost'].value = '1.2345'; drain.resolve(); await apply; mark(); h.elements['i-cost'].value = ''; await h.apply(); mark(); } },
  { name: 'replacement during broadcast supersedes peer veto',
    async run(h, mark) { await h.ready(); const apply = h.apply(); h.blockPeer(); h.changeController(h.waiting); mark(); await h.tick(); await apply; mark(); } },
  { name: 'unsolicited ACK during drain',
    async run(h, mark) { await h.ready(); const drain = h.holdDrain(), apply = h.apply(); await h.tick(); h.ack(); mark(); drain.resolve(); await apply; mark(); h.ack(); mark(); } },
  { name: 'post failure clears authorization then clean retry', options: () => { let attempts = 0; return { post() { if (++attempts === 1) throw new Error('synthetic post failure'); } }; },
    async run(h, mark) { await h.ready(); const first = h.apply(); await h.tick(); await first; mark(); h.ack(); mark(); const retry = h.apply(); await h.tick(); await retry; h.ack(); mark(); } },
  { name: 'construction is inert until explicit original-position start', options: () => ({ deferStart: true }),
    async run(h, mark) { mark(); await h.ready(); mark(); h.start(); mark(); await h.ready(); mark(); } },
  { name: 'unsupported service worker is inert', options: () => ({ noServiceWorker: true }),
    async run(h, mark) { await h.ready(); mark(); await h.apply(); mark(); } },
  ...['noBroadcastChannel', 'channelThrows'].map(option => ({ name: `${option} preserves local drain/ACK path`, options: () => ({ [option]: true }),
    async run(h, mark) { await h.ready(); mark(); await h.apply(); mark(); h.ack(); mark(); } })),
  { name: 'registration rejection preserves message listeners without update interval', options: () => ({ registrationFails: true }),
    async run(h, mark) { await h.ready(); mark(); await h.apply(); h.ack(); mark(); } },
  { name: 'updatefound absent/installing/installed transitions',
    async run(h, mark) { await h.ready(); h.updateFound(); mark(); const installed = h.installWorker(); installed.state('installing'); mark(); installed.state('installed'); mark(); const apply = h.apply(); await h.tick(); await apply; mark(); h.ack(installed.next); mark(); } },
  { name: 'first-install installed worker is not a waiting update', options: () => ({ firstInstall: true }),
    async run(h, mark) { await h.ready(); const installed = h.installWorker(); installed.state('installed'); mark(); h.changeController(installed.next); mark(); } },
  { name: 'peer prepare response follows current dirty/sync/save state',
    async run(h, mark) { await h.ready(); h.emitPrepare(); mark(); h.setSyncing(true); h.emitPrepare({ type: 'prepare', requestId: '' }); h.emitPrepare({ type: 'other', requestId: 'peer' }); h.emitPrepare(); mark(); h.setSyncing(false); h.setSaving(true); h.emitPrepare(); mark(); h.setSaving(false); h.elements['i-name'].value = '草稿'; h.emitPrepare(); mark(); } },
  { name: 'sync appearing during drain is rechecked and clean retry remains explicit',
    async run(h, mark) { await h.ready(); const drain = h.holdDrain(), apply = h.apply(); await h.tick(); h.setSyncing(true); drain.resolve(); await apply; mark(); h.setSyncing(false); const retry = h.apply(); await h.tick(); await retry; h.ack(); mark(); } },
  { name: 'save appearing during drain preserves the local reload',
    async run(h, mark) { await h.ready(); h.changeController(h.waiting); const drain = h.holdDrain(), apply = h.apply(); await flush(); h.setSaving(true); drain.resolve(); await apply; mark(); h.setSaving(false); await h.apply(); mark(); } },
  { name: 'drain rejection restores timer and permits retry',
    async run(h, mark) { await h.ready(); h.setTimer(77); const drain = h.holdDrain(), apply = h.apply(); await h.tick(); mark(); drain.reject(new Error('synthetic drain failure')); await apply; mark(); h.ack(); mark(); const retry = h.apply(); await h.tick(); await retry; h.ack(); mark(); } },
  { name: 'missing update banner elements keep guarded activation behavior', options: () => ({ missingElements: ['update-banner', 'update-banner-text', 'update-now-btn'] }),
    async run(h, mark) { await h.ready(); mark(); h.show(h.waiting); const apply = h.apply(); await h.tick(); await apply; mark(); h.ack(); mark(); } },
];

for (const [index, scenario] of pairedScenarios.entries()) test(`M5 delta-excluding v15 compatibility projection: ${scenario.name}`, async t => {
  async function run(legacy) {
    let h;
    h = harness({ ...scenario.options?.(() => h), legacy });
    const transcript = [];
    const mark = () => transcript.push(transcriptState(h));
    mark();
    await scenario.run(h, mark);
    return transcript;
  }
  const current = await run(false), old = await run(true);
  const serialized = JSON.stringify({ scenario: scenario.name, current, old }, null, 2) + '\n';
  // Optional test-observation artifact only. CI needs no personal path; the
  // product factory, callbacks and statements do not depend on this output.
  const directory = process.env.FUNDVAL_PWA_TRANSCRIPT_DIR;
  if (directory) {
    assert.equal(isAbsolute(directory), true, 'explicit test evidence directory must be absolute');
    await writeFile(join(directory, `${String(index + 1).padStart(2, '0')}.json`), serialized, { flag: 'wx' });
  }
  t.diagnostic(`M5-second-observation-excluded-source-view;transcript checkpoints=${current.length};bytes=${Buffer.byteLength(serialized)};sha256=${digest(serialized)}`);
  assert.deepEqual(current, old, 'complete checkpoint state/DOM/IO/clock-listener transcript');
});

test('the public factory is inert and exposes no private state or test-only method', () => {
  const publicFactory = new Function(`return (${controllerSource.slice(factory.start, factory.end)});`)();
  const fail = () => { throw new Error('construction must not call an App callback'); };
  const controller = publicFactory({ hasUnsavedPageInput: fail, isSyncing: fail, isSavingHolding: fail,
    clearAutoRefresh: fail, startAutoRefresh: fail, stopAndDrain: fail, showToast: fail, updateIntervalMs: 123 });
  assert.deepEqual(Object.keys(controller), ['start', 'hasServiceWorkerUpdateBlocker', 'applyPendingServiceWorkerUpdate', 'isUpdateApplying']);
  assert.equal(controller.isUpdateApplying(), false);
  assert.equal(Object.hasOwn(controller, 'state'), false);
  assert.equal(Object.hasOwn(controller, 'show'), false);
});

test('a synchronous registration exception keeps the same thrown boundary as the original App block', () => {
  for (const legacy of [true, false]) assert.throws(() => harness({ legacy, registrationThrows: true }),
    { name: 'Error', message: 'registration threw' });
});
