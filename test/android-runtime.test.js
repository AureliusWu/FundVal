import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createHoldingsTransfer } from '../js/runtime/holdings-transfer.js';

const RUNTIME = await readFile(new URL('../android/android-runtime.js', import.meta.url), 'utf8');
const ORIGIN = 'https://aureliuswu.github.io';
const NONCE = 'aad8f7a0-079a-4f52-ae15-053f44b5c13e';
const SECOND_NONCE = '24c451bc-d1a7-4aaa-a74d-fb303731c1aa';
const PROTOCOL = `fundval-android-v2:${NONCE}`;
const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
const BACKUP = '{"schema":3,"holdings":[]}';
const KEYS = [
  'fuyu_holdings_v3', 'fuyu_holdings_v1', 'fuyu_device_id_v1',
  'fuyu_holdings_repository_backup_latest_v1', 'fuyu_holdings_repository_backup_previous_v1',
  'fuyu_holdings_repository_journal_v1', 'fuyu_holdings_projection_meta_v1',
  'fuyu_backup_latest', 'fuyu_backup_previous',
];
const V3 = KEYS[0];
const storageSnapshot = (raw, overrides = {}) => ({
  ...Object.fromEntries(KEYS.map(key => [key, null])), [V3]: raw, ...overrides,
});
const valid = snapshot => snapshot[V3]?.startsWith('valid:') === true;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function boot({ platform = 'android', origin = ORIGIN, topFrame = true, pathname = '/FundVal/', initial = {} } = {}) {
  let receive;
  let nextTimer = 0;
  const timers = new Map();
  const storage = new Map(Object.entries(initial).filter(([, value]) => value !== null));
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const window = {
    addEventListener(type, listener) {
      assert.equal(type, 'message');
      assert.equal(receive, undefined);
      receive = listener;
    },
  };
  window.top = topFrame ? window : {};
  runInNewContext(RUNTIME, {
    window, document: { documentElement: { dataset: platform === null ? {} : { fundvalPlatform: platform } } },
    location: { origin, pathname }, TextEncoder, localStorage,
    setTimeout: (fn, ms) => {
      assert.ok(ms > 0 && ms <= 12000);
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout: id => timers.delete(id),
  });
  return { window, receive, localStorage, expireTimers() {
    for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
  } };
}

function fakePort(onRequest) {
  return {
    messages: [], closed: false,
    postMessage(data) {
      const request = JSON.parse(data);
      this.messages.push(request);
      if (onRequest) onRequest(request, this);
    },
    close() { this.closed = true; },
    reply(data) { this.onmessage?.({ data: JSON.stringify(data) }); },
  };
}

function handshake(port, overrides = {}) {
  return { isTrusted: true, source: null, origin: '', data: PROTOCOL, ports: [port], ...overrides };
}

function bind(runtime, port, nonce = NONCE) {
  const api = runtime.window.FundValAndroid;
  assert.equal(api.arm(nonce), true);
  runtime.receive(handshake(port, { origin: 'null', data: `fundval-android-v2:${nonce}` }));
  return api;
}

test('Android runtime binds only on the packaged top frame at exact trusted paths', () => {
  for (const options of [
    { platform: null },
    { origin: 'https://appassets.androidplatform.net' },
    { platform: 'web' },
    { topFrame: false },
    { origin: 'null' },
    { origin: 'http://aureliuswu.github.io' },
    { origin: 'https://aureliuswu.github.io.example.test' },
    { origin: 'https://aureliuswu.github.io:444' },
    { pathname: '/FundVal/quote-bridge.html' },
    { pathname: '/FundVal/ocr-import.html/elsewhere' },
  ]) {
    const runtime = boot(options);
    assert.equal(runtime.receive, undefined, JSON.stringify(options));
    assert.equal(runtime.window.FundValAndroid, undefined, JSON.stringify(options));
  }
  const { window, receive } = boot();
  assert.equal(typeof receive, 'function');
  assert.equal(typeof window.FundValAndroid.exportHoldings, 'function');
  assert.equal(typeof boot({ pathname: '/FundVal/ocr-import.html' }).window.FundValAndroid.withDurableHoldings, 'function');
  assert.equal(Object.isFrozen(window.FundValAndroid), true);
  assert.equal(Object.getOwnPropertyDescriptor(window, 'FundValAndroid').writable, false);
});

test('opaque iframe, regular postMessage and malformed handshakes cannot attach an export port', async () => {
  const { window, receive, expireTimers } = boot();
  const api = window.FundValAndroid;
  const badPort = fakePort();
  receive(handshake(badPort)); // Cannot bind without a native challenge.
  assert.equal(badPort.onmessage, undefined);
  assert.equal(api.arm('not-a-challenge'), false);
  assert.equal(api.arm(NONCE), true);
  for (const overrides of [
    { isTrusted: false },
    { source: {}, origin: 'null' },
    { source: {}, origin: ORIGIN },
    { origin: 'https://foreign.example.test' },
    { data: 'different-protocol' },
    { data: `fundval-android-v2:${SECOND_NONCE}` },
    { ports: [] },
    { ports: [badPort, fakePort()] },
  ]) {
    receive(handshake(badPort, overrides));
    assert.equal(badPort.onmessage, undefined);
  }
  const blocked = api.exportHoldings(BACKUP);
  expireTimers();
  assert.equal(await blocked, 'failed');
  assert.deepEqual(badPort.messages, []);
  assert.equal(badPort.onmessage, undefined);

  const realPort = fakePort();
  receive(handshake(realPort, { origin: 'null' }));
  await api.ready();
  const exportResult = api.exportHoldings(BACKUP);
  await nextTurn();
  receive(handshake(badPort, { source: {}, origin: 'null' }));
  receive(handshake(badPort)); // The nonce was consumed, cannot be replayed.
  assert.equal(realPort.closed, false, 'untrusted frame must not replace the native port');
  assert.deepEqual(realPort.messages, [{ id: 1, op: 'export', contents: BACKUP }]);
  realPort.reply({ id: 1, ok: true, status: 'saved' });
  assert.equal(await exportResult, 'saved');
});

test('Android port accepts one pending export with a four MiB UTF-8 cap and reports all outcomes', async () => {
  const runtime = boot();
  const port = fakePort();
  const api = bind(runtime, port);
  for (const value of [null, {}, '', 'a'.repeat(MAX_EXPORT_BYTES + 1), '基'.repeat(Math.ceil(MAX_EXPORT_BYTES / 3))]) {
    assert.equal(await api.exportHoldings(value), 'failed');
  }
  assert.equal(port.messages.length, 0);
  const bounded = api.exportHoldings('a'.repeat(MAX_EXPORT_BYTES));
  await nextTurn();
  assert.equal(port.messages.length, 1);
  assert.equal(port.messages[0].contents.length, MAX_EXPORT_BYTES);
  assert.equal(await api.exportHoldings(BACKUP), 'failed', 'second pending export must not reach native storage');
  assert.equal(port.messages.length, 1);
  port.reply({ id: port.messages.at(-1).id, ok: true, status: 'saved' });
  assert.equal(await bounded, 'saved');

  for (const [nativeResult, result] of [['cancelled', 'cancelled'], ['failed', 'failed'], ['unexpected', 'failed']]) {
    const pending = api.exportHoldings(BACKUP);
    await nextTurn();
    port.reply({ id: port.messages.at(-1).id, ok: false, status: nativeResult });
    assert.equal(await pending, result);
  }
  const messageError = api.exportHoldings(BACKUP);
  await nextTurn();
  port.onmessageerror();
  assert.equal(await messageError, 'failed');
  const unavailable = fakePort();
  bind(runtime, unavailable, SECOND_NONCE);
  unavailable.postMessage = () => { throw new Error('synthetic closed port'); };
  assert.equal(await api.exportHoldings(BACKUP), 'failed');
});

test('native port replacement closes the old port and resolves an interrupted export as failed', async () => {
  const runtime = boot();
  const first = fakePort(), second = fakePort();
  const api = bind(runtime, first);
  const pending = api.exportHoldings(BACKUP);
  await nextTurn();
  bind(runtime, second, SECOND_NONCE);
  assert.equal(first.closed, true);
  assert.equal(await pending, 'failed');
  const next = api.exportHoldings(BACKUP);
  await nextTurn();
  assert.deepEqual(second.messages, [{ id: 2, op: 'export', contents: BACKUP }]);
  second.reply({ id: 2, ok: true, status: 'saved' });
  assert.equal(await next, 'saved');
});

test('first checkpoint seeds only the exact repository allowlist and waits for native acknowledgement', async () => {
  const runtime = boot({ initial: { [V3]: 'valid:legacy', fuyu_gist_token: 'synthetic-private' } });
  const port = fakePort((request, channel) => {
    if (request.op === 'read') channel.reply({ id: request.id, ok: true, generation: 0, snapshot: null });
  });
  const api = bind(runtime, port);
  let returned = false;
  const operation = api.withDurableHoldings(() => ({ ok: true }), valid).then(result => { returned = true; return result; });
  await nextTurn();
  const commit = port.messages.at(-1);
  assert.equal(commit.op, 'commit');
  assert.equal(commit.generation, 0);
  assert.deepEqual(commit.snapshot, storageSnapshot('valid:legacy'));
  assert.equal(returned, false);
  port.reply({ id: commit.id + 1, ok: true, generation: 1 });
  await nextTurn();
  assert.equal(returned, false, 'mismatched response must not acknowledge commit');
  port.reply({ id: commit.id, ok: true, generation: 1 });
  assert.equal((await operation).ok, true);
  assert.equal(runtime.localStorage.getItem('fuyu_gist_token'), 'synthetic-private');
});

test('native state hydrates a stale WebView before reads and does not checkpoint an unchanged read', async () => {
  const stale = storageSnapshot('valid:stale', { fuyu_holdings_repository_journal_v1: '{"state":"prepared"}' });
  const runtime = boot({ initial: stale });
  const port = fakePort((request, channel) => channel.reply({
    id: request.id, ok: true, generation: 5, snapshot: storageSnapshot('valid:durable'),
  }));
  const api = bind(runtime, port);
  const result = await api.withDurableHoldings(() => {
    assert.equal(runtime.localStorage.getItem(V3), 'valid:durable');
    assert.equal(runtime.localStorage.getItem('fuyu_holdings_repository_journal_v1'), null);
    return { document: 'durable-read' }; // OCR reads have no `ok` field.
  }, valid);
  assert.equal(result.document, 'durable-read');
  assert.equal(port.messages.length, 1);
});

test('lost commit acknowledgement rolls back only the projection; the next read follows native generation', async () => {
  const runtime = boot();
  let generation = 7;
  let durable = storageSnapshot('valid:before');
  const port = fakePort((request, channel) => {
    if (request.op === 'read') channel.reply({ id: request.id, ok: true, generation, snapshot: durable });
    else { assert.equal(request.generation, generation); generation++; durable = request.snapshot; }
  });
  const api = bind(runtime, port);
  const operation = api.withDurableHoldings(() => {
    runtime.localStorage.setItem(V3, 'valid:new');
    return { ok: true, document: 'never-return-before-ack' };
  }, valid);
  await nextTurn();
  runtime.expireTimers();
  const failure = await operation;
  assert.equal(failure.ok, false);
  assert.equal(failure.recoveryRequired, true);
  assert.equal(failure.document, null);
  assert.equal(runtime.localStorage.getItem(V3), 'valid:before');
  assert.equal(port.messages.filter(request => request.op === 'commit').length, 1);
  assert.equal(await api.withDurableHoldings(() => runtime.localStorage.getItem(V3), valid), 'valid:new');
  assert.equal(port.messages.filter(request => request.op === 'commit').length, 1, 're-read does not overwrite new native authority');
});

test('failed/invalid callbacks do not acknowledge or checkpoint a mutated repository', async () => {
  const runtime = boot();
  const port = fakePort((request, channel) => channel.reply({
    id: request.id, ok: true, generation: 1, snapshot: storageSnapshot('valid:stable'),
  }));
  const api = bind(runtime, port);
  for (const result of [{ ok: false, document: 'candidate' }, { ok: true, integrity: { transactionBlocked: true } }, { ok: true }, null]) {
    const received = await api.withDurableHoldings(() => {
      runtime.localStorage.setItem(V3, 'invalid:staged');
      return result;
    }, valid);
    assert.equal(received.ok, false);
    assert.equal(received.document, null);
    assert.equal(runtime.localStorage.getItem(V3), 'valid:stable');
  }
  assert.deepEqual(port.messages.map(request => request.op), ['read', 'read', 'read', 'read']);
});

test('wrong generation acknowledgement cannot publish a candidate', async () => {
  const runtime = boot();
  const port = fakePort((request, channel) => channel.reply(request.op === 'read' ? {
    id: request.id, ok: true, generation: 10, snapshot: storageSnapshot('valid:stable'),
  } : { id: request.id, ok: true, generation: 12 }));
  const api = bind(runtime, port);
  const received = await api.withDurableHoldings(() => {
    runtime.localStorage.setItem(V3, 'valid:staged');
    return { ok: true };
  }, valid);
  assert.equal(received.ok, false);
  assert.equal(received.recoveryRequired, true);
  assert.equal(runtime.localStorage.getItem(V3), 'valid:stable');
});

test('future local schema, malformed native snapshot and unavailable port fail closed without callback', async () => {
  for (const [initial, native] of [
    [{ [V3]: '{"schema":4}' }, { generation: 3, snapshot: storageSnapshot('valid:old') }],
    [{ [V3]: 'valid:local' }, { generation: 3, snapshot: { ...storageSnapshot('valid:old'), fuyu_gist_token: 'not-allowed' } }],
    [{ [V3]: 'valid:local' }, { generation: 3, snapshot: storageSnapshot('invalid:corrupt') }],
    [{ [V3]: 'valid:local' }, { generation: 0, snapshot: storageSnapshot('valid:nonempty') }],
  ]) {
    const runtime = boot({ initial });
    const port = fakePort((request, channel) => channel.reply({ id: request.id, ok: true, ...native }));
    const api = bind(runtime, port);
    assert.equal((await api.withDurableHoldings(() => assert.fail('must not enter callback'), valid)).ok, false);
    assert.equal(runtime.localStorage.getItem(V3), initial[V3]);
    assert.equal(port.messages.length, 1);
  }
  const runtime = boot();
  const operation = runtime.window.FundValAndroid.withDurableHoldings(() => assert.fail('must not enter callback'), valid);
  runtime.expireTimers();
  assert.equal((await operation).reason, 'android_store_unavailable');
});

test('packaged holdings export passes canonical JSON, honors cancellation, and never triggers a browser download', async t => {
  const setGlobal = (name, value) => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => prior ? Object.defineProperty(globalThis, name, prior) : delete globalThis[name]);
  };
  const original = { schema: 3, deviceId: 'synthetic:android-export', updatedAt: '2026-10-30T00:00:00.000Z', holdings: [] };
  const toasts = [], payloads = [], statuses = ['saved', 'cancelled', 'failed'];
  setGlobal('document', {
    documentElement: { dataset: { fundvalPlatform: 'android' } },
    createElement() { assert.fail('Android export must not fall back to a blob download'); },
  });
  setGlobal('localStorage', { getItem: () => null, setItem() { assert.fail('export must not change local data'); } });
  setGlobal('FundValAndroid', {
    async exportHoldings(contents) { payloads.push(JSON.parse(contents)); return statuses.shift(); },
  });
  const transfer = createHoldingsTransfer({ getHoldingsDocument: () => original, showToast: value => toasts.push(value) });
  for (let attempt = 0; attempt < 3; attempt++) await transfer.exportData();
  assert.deepEqual(payloads, Array.from({ length: 3 }, () => ({ ...original, overseasAccuracy: [] })));
  assert.deepEqual(toasts, ['已导出持仓文件', '未能导出持仓文件，请重试']);
});

test('the public PWA entry and service worker do not reference the APK-only runtime', async () => {
  const [index, worker] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(index, /data-fundval-platform|android-runtime\.js/i);
  assert.doesNotMatch(worker, /android-runtime\.js/i);
});

test('the real update controller never registers a web update worker in the APK', async t => {
  const { createPwaUpdateController } = await import('../js/runtime/pwa-update-controller.js');
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const restore = (name, previous) => previous
    ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name];
  t.after(() => { restore('document', documentBefore); restore('navigator', navigatorBefore); });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    documentElement: { dataset: { fundvalPlatform: 'android' } },
  } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    get serviceWorker() { assert.fail('APK startup must not touch the web update worker'); },
  } });
  createPwaUpdateController({}).start();
});
