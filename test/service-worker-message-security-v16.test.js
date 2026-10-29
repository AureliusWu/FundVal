import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://example.test';
const ROOT = ORIGIN + '/FundVal/';
function harness({ lookup, clients: windows = [], matchFailure = false, notificationFailure = false, rootUrl = ROOT } = {}) {
  const listeners = new Map();
  const effects = { skipped: 0, reads: [], notices: [], replies: [], messages: [], opened: [], focused: [], claimed: 0 };
  const client = { id: 'app', type: 'window', url: rootUrl, postMessage(value) { effects.messages.push(value); } };
  const api = {
    async get(id) { effects.reads.push(id); return lookup ? lookup(id, client) : id === client.id ? client : undefined; },
    async matchAll() { if (matchFailure) throw new Error('synthetic lookup failure'); return windows; },
    async openWindow(url) { effects.opened.push(url); return null; },
    async claim() { effects.claimed++; },
  };
  runInNewContext(source, {
    URL, Request, Response, clients: api, caches: { async keys() { return ['fuyu-v0.0.1']; }, async delete() {} },
    self: {
      location: { origin: ORIGIN, href: rootUrl + 'sw.js' }, clients: api,
      registration: { scope: rootUrl, async showNotification(title, options) {
        if (notificationFailure) throw new Error('synthetic permission denial');
        effects.notices.push({ title, options });
      } },
      async skipWaiting() { effects.skipped++; },
      addEventListener(type, handler) { listeners.set(type, handler); },
    },
  }, { filename: 'sw.js' });
  function start(type, values) {
    const lifetime = [];
    listeners.get(type)({ ...values, waitUntil(promise) { lifetime.push(Promise.resolve(promise)); } });
    return { lifetime, done: Promise.all(lifetime) };
  }
  function message(type, values = {}) {
    return start('message', { origin: ORIGIN, source: client,
      data: { type }, ports: [{ postMessage(value) { effects.replies.push(value); } }], ...values });
  }
  return { client, effects, start, message };
}
const invalidSenders = [
  ['foreign origin', { origin: 'https://untrusted.invalid' }],
  ['opaque origin', { origin: 'null' }],
  ['missing origin', { origin: undefined }],
  ['missing source', { source: null }],
  ['missing source id', { source: { type: 'window', url: ROOT } }],
  ['sibling app', { source: { id: 'app', type: 'window', url: ORIGIN + '/News/' } }],
  ['prefix collision', { source: { id: 'app', type: 'window', url: ORIGIN + '/FundVal-evil/' } }],
  ['OCR document', { source: { id: 'app', type: 'window', url: ROOT + 'ocr-import.html' } }],
  ['bridge document', { source: { id: 'app', type: 'window', url: ROOT + 'quote-bridge.html' } }],
  ['invalid source URL', { source: { id: 'app', type: 'window', url: 'not a URL' } }],
  ['relative source URL', { source: { id: 'app', type: 'window', url: './' } }],
  ['credential source URL', { source: { id: 'app', type: 'window', url: 'https://synthetic:password@example.test/FundVal/' } }],
];
for (const [name, values] of invalidSenders) {
  test('SW message authentication rejects ' + name + ' before every effect', async () => {
    for (const type of ['SKIP_WAITING', 'GET_VERSION', 'notify']) {
      const h = harness();
      await h.message(type, values).done;
      assert.equal(h.effects.skipped, 0, type);
      assert.equal(h.effects.replies.length, 0, type);
      assert.equal(h.effects.notices.length, 0, type);
    }
  });
}
test('SW authentication rejects missing/failed/non-window or mismatched live clients', async () => {
  for (const lookup of [
    async () => undefined, async () => { throw new Error('synthetic unavailable'); },
    async (_, client) => ({ ...client, type: 'worker' }),
    async (_, client) => ({ ...client, type: 'sharedworker' }),
    async (_, client) => ({ ...client, id: 'different' }),
    async (_, client) => ({ ...client, url: ORIGIN + '/News/' }),
    async (_, client) => ({ ...client, url: ROOT + 'index.html' }),
  ]) {
    for (const type of ['SKIP_WAITING', 'GET_VERSION', 'notify']) {
      const h = harness({ lookup });
      await h.message(type).done;
      assert.equal(h.effects.skipped, 0);
      assert.equal(h.effects.replies.length, 0);
      assert.equal(h.effects.notices.length, 0);
    }
  }
});
test('SW synchronously registers lifetime and waits for lookup before a legitimate waiting-worker request', async () => {
  let resolveLookup;
  const h = harness({ lookup: (_, client) => new Promise(resolve => { resolveLookup = () => resolve(client); }) });
  const request = h.message('SKIP_WAITING');
  assert.equal(request.lifetime.length, 1, 'register lifetime inside the original event callback');
  assert.equal(h.effects.skipped, 0, 'no activation before authentication');
  resolveLookup();
  await request.done;
  assert.equal(h.effects.skipped, 1, 'no controller requirement for a waiting worker');
});
test('SW accepts root and index query/hash clients and preserves version and legacy notification protocol', async () => {
  for (const suffix of ['', '?from=pwa#edit', 'index.html', 'index.html?from=legacy#edit']) {
    const h = harness();
    h.client.url = ROOT + suffix;
    await h.message('GET_VERSION').done;
    assert.match(h.effects.replies[0].cache, /^fuyu-v\d+\.\d+\.\d+$/);
    await h.message('notify', { data: { type: 'notify', title: '合成标题', body: '合成正文', tag: 'synthetic', url: ROOT + suffix } }).done;
    assert.equal(h.effects.notices.length, 1);
    assert.equal(h.effects.notices[0].title, '合成标题');
    assert.equal(h.effects.notices[0].options.body, '合成正文');
    assert.equal(h.effects.notices[0].options.data.url, ROOT + suffix);
  }
});
test('SW activation revalidates the requester and never notifies a navigated client', async () => {
  const h = harness();
  await h.message('SKIP_WAITING').done;
  h.client.url = ORIGIN + '/News/';
  await h.start('activate', {}).done;
  assert.equal(h.effects.messages.length, 0);
  assert.equal(h.effects.claimed, 0);
});
test('SW local root deployment and legacy relative notification targets remain supported', async () => {
  const h = harness({ rootUrl: ORIGIN + '/' });
  await h.message('GET_VERSION').done;
  assert.equal(h.effects.replies.length, 1);
  await h.message('notify', { data: { type: 'notify', url: './index.html#edit' } }).done;
  assert.equal(h.effects.notices[0].options.data.url, ORIGIN + '/index.html#edit');
});
test('SW invalid messages cannot replace an authenticated update requester', async () => {
  const h = harness();
  await h.message('SKIP_WAITING').done;
  await h.message('SKIP_WAITING', { source: { id: 'other', type: 'window', url: ORIGIN + '/News/' } }).done;
  await h.start('activate', {}).done;
  assert.equal(h.effects.skipped, 1);
  assert.equal(h.effects.messages.length, 1);
});
test('SW activation safely ignores a closed requester or a failed client lookup', async () => {
  for (const fail of [false, true]) {
    let activating = false;
    const h = harness({ lookup: async (_, client) => {
      if (!activating) return client;
      if (fail) throw new Error('synthetic disappeared requester');
      return undefined;
    } });
    await h.message('SKIP_WAITING').done;
    activating = true;
    await assert.doesNotReject(h.start('activate', {}).done);
    assert.equal(h.effects.messages.length, 0);
  }
});
const unsafeTargets = ['https://untrusted.invalid/', '//untrusted.invalid/', 'javascript:alert(1)', 'data:text/html,synthetic',
  'https://synthetic:password@example.test/FundVal/', 'http://example.test/FundVal/', 'blob:' + ROOT,
  ORIGIN + '/News/', ROOT + 'ocr-import.html', ROOT + '../News/', { url: ROOT }];
test('SW legacy notifications and clicks constrain destinations even when no app window remains', async () => {
  for (const target of unsafeTargets) {
    const h = harness();
    await h.message('notify', { data: { type: 'notify', url: target } }).done;
    assert.equal(h.effects.notices[0].options.data.url, ROOT);
    await h.start('notificationclick', { notification: { data: { url: target }, close() {} } }).done;
    assert.deepEqual(h.effects.opened, [ROOT]);
  }
});
test('SW notification clicks focus only a qualified app window, not the first same-origin window', async () => {
  const focused = [];
  const h = harness({ clients: [
    { type: 'window', url: ORIGIN + '/News/', async focus() { focused.push('sibling'); } },
    { type: 'window', url: ROOT + 'index.html?from=pwa', async focus() { focused.push('app'); } },
  ] });
  await h.start('notificationclick', { notification: { data: { url: ROOT }, close() {} } }).done;
  assert.deepEqual(focused, ['app']);
  assert.deepEqual(h.effects.opened, []);
});
test('SW client/notification API failures and malformed messages degrade without leaking or rejecting lifetime', async () => {
  const h = harness({ notificationFailure: true, matchFailure: true });
  await assert.doesNotReject(h.message('notify').done);
  await assert.doesNotReject(h.start('notificationclick', { notification: { data: {}, close() {} } }).done);
  for (const data of [null, [], 'notify', {}, { type: 'unknown' }]) await assert.doesNotReject(h.message('ignored', { data }).done);
  await assert.doesNotReject(h.message('GET_VERSION', { ports: [] }).done);
  assert.equal(h.effects.skipped, 0);
});

