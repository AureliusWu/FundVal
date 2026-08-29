import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { QuoteBridgeClient } from '../js/runtime/quote-bridge-client.js';

function makeEventTarget(target = {}) {
  const listeners = new Map();
  target.addEventListener = (type, listener) => {
    const entries = listeners.get(type) || new Set();
    entries.add(listener);
    listeners.set(type, entries);
  };
  target.removeEventListener = (type, listener) => listeners.get(type)?.delete(listener);
  target.dispatch = (type, event) => {
    for (const listener of listeners.get(type) || []) listener(event);
  };
  return target;
}

function makeHarness() {
  const attributes = new Map();
  let posted = null;
  const contentWindow = {
    postMessage(message, targetOrigin) {
      posted = { message, targetOrigin };
    },
  };
  const frame = makeEventTarget({
    contentWindow,
    hidden: false,
    tabIndex: 0,
    removed: false,
    setAttribute(name, value) { attributes.set(name, value); },
    remove() { this.removed = true; },
  });
  const browserWindow = makeEventTarget({
    setTimeout,
    clearTimeout,
  });
  const document = {
    createElement(name) {
      assert.equal(name, 'iframe');
      return frame;
    },
    body: {
      appendChild(node) {
        assert.equal(node, frame);
        queueMicrotask(() => frame.dispatch('load', {}));
      },
    },
  };
  return {
    attributes,
    browserWindow,
    contentWindow,
    document,
    frame,
    get posted() { return posted; },
  };
}

async function waitForPosted(harness) {
  for (let index = 0; index < 20 && !harness.posted; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(harness.posted, 'expected a message to be posted to the bridge');
  return harness.posted.message;
}

test('client creates an opaque-origin iframe and accepts only messages from its WindowProxy', async () => {
  const harness = makeHarness();
  const client = new QuoteBridgeClient({
    window: harness.browserWindow,
    document: harness.document,
    crypto: { randomUUID: () => 'request-client01' },
    timeoutMs: 1_000,
  });
  const pending = client.indexQuotes(['sh000001']);
  const request = await waitForPosted(harness);
  assert.equal(harness.attributes.get('sandbox'), 'allow-scripts');
  assert.equal(harness.attributes.get('sandbox').includes('allow-same-origin'), false);
  assert.equal(harness.attributes.get('referrerpolicy'), 'no-referrer');
  assert.equal(harness.attributes.get('src'), './quote-bridge.html');
  assert.equal(harness.posted.targetOrigin, '*');

  const response = {
    type: 'fundval:bridge:response',
    requestId: request.requestId,
    ok: true,
    data: { quotes: [{
      code: 'sh000001', price: 3952.18, changePct: 0, sourceTimeRaw: '20260828161402',
    }] },
  };
  harness.browserWindow.dispatch('message', { source: {}, data: response });
  assert.equal(client.pending.size, 1, 'wrong message source must be ignored');
  harness.browserWindow.dispatch('message', { source: harness.contentWindow, data: response });
  const data = await pending;
  assert.equal(data.quotes[0].changePct, 0);
  client.destroy();
});

test('client rejects a same-frame response whose code is outside the request set', async () => {
  const harness = makeHarness();
  const client = new QuoteBridgeClient({
    window: harness.browserWindow,
    document: harness.document,
    crypto: { randomUUID: () => 'request-client02' },
    timeoutMs: 1_000,
  });
  const pending = client.overseasComponents(['usNVDA']);
  const request = await waitForPosted(harness);
  harness.browserWindow.dispatch('message', {
    source: harness.contentWindow,
    data: {
      type: 'fundval:bridge:response', requestId: request.requestId, ok: true,
      data: { quotes: [{ code: 'usAMD', price: 100, changePct: 1, sourceTimeRaw: null }] },
    },
  });
  await assert.rejects(pending, { code: 'invalid_response' });
  client.destroy();
});

test('bridge HTML CSP permits only the local runtime and the two current JSONP hosts', async () => {
  const html = await readFile(new URL('../quote-bridge.html', import.meta.url), 'utf8');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self' https:\/\/fund\.eastmoney\.com https:\/\/qt\.gtimg\.cn/);
  assert.match(html, /script-src-attr 'none'/);
  assert.doesNotMatch(html, /script-src[^;]*\*/);
  assert.doesNotMatch(html, /allow-same-origin|unsafe-inline|unsafe-eval|localStorage|gist/i);
  assert.match(html, /js\/sandbox\/quote-bridge-runtime\.js/);
});
