import test from 'node:test';
import assert from 'node:assert/strict';
import { QuoteBridgeClient } from '../js/runtime/quote-bridge-client.js';

function harness({ load = true, reply = true } = {}) {
  let time = 0, sequence = 0, timerId = 0;
  const timers = new Map(), frames = [], sent = [];
  const browser = {
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener() {}, removeEventListener() {},
  };
  const document = {
    createElement() {
      const events = new Map();
      const frame = {
        removed: false,
        setAttribute() {},
        addEventListener(type, fn) { events.set(type, fn); },
        removeEventListener(type) { events.delete(type); },
        remove() { this.removed = true; },
        loaded() { events.get('load')?.(); },
        contentWindow: { postMessage(request) {
          sent.push({ code: request.params.codes[0], at: time, frame });
          if (reply) browser.setTimeout(() => {
            if (!frame.removed) client.handleMessage({ source: frame.contentWindow, data: {
              type: 'fundval:bridge:response', requestId: request.requestId, ok: true,
              data: { quotes: [{ code: request.params.codes[0], price: 100, changePct: 0, sourceTimeRaw: null }] },
            } });
          }, 3000);
        } },
      };
      frames.push(frame);
      return frame;
    },
    body: { appendChild(frame) { if (load) queueMicrotask(() => frame.loaded()); } },
  };
  const client = new QuoteBridgeClient({ window: browser, document, crypto: { randomUUID: () => `queue-test-${++sequence}` } });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const advance = async ms => {
    await flush();
    const end = time + ms;
    while (true) {
      const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    time = end; await flush();
  };
  return { client, frames, sent, advance, flush, timers };
}

test('three 3-second sources each retain their full 7-second dispatch budget', async () => {
  for (let sample = 0; sample < 3; sample++) {
    const h = harness();
    const result = Promise.all(['usSPY', 'usQQQ', 'usEEM'].map(code => h.client.securityQuotes([code], { timeoutMs: 7000 })));
    await h.advance(9000);
    assert.equal((await result).length, 3);
    assert.deepEqual(h.sent.map(x => x.at), [0, 3000, 6000]);
    h.client.destroy();
    assert.equal(h.timers.size, 0);
  }
});

test('queued abort never reaches JSONP and active abort discards its entire realm', async () => {
  const h = harness();
  const active = new AbortController(), queued = new AbortController();
  const first = assert.rejects(h.client.securityQuotes(['usSPY'], { signal: active.signal }), { code: 'aborted' });
  const second = assert.rejects(h.client.securityQuotes(['usQQQ'], { signal: queued.signal }), { code: 'aborted' });
  await h.flush(); queued.abort(); active.abort(); await h.flush();
  await Promise.all([first, second]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.frames[0].removed, true);
  const third = h.client.securityQuotes(['usEEM']);
  await h.advance(3000);
  assert.equal((await third).quotes[0].code, 'usEEM');
  assert.equal(h.frames.length, 2);
  h.client.destroy();
});

test('abort and destroy during iframe load release the pending load and queued jobs', async () => {
  const h = harness({ load: false });
  const controller = new AbortController();
  const first = assert.rejects(h.client.indexQuotes(['sh000001'], { signal: controller.signal }), { code: 'aborted' });
  await h.flush(); controller.abort(); await first;
  assert.equal(h.frames[0].removed, true);
  const second = assert.rejects(h.client.indexQuotes(['sh000300']), { code: 'bridge_unavailable' });
  const third = assert.rejects(h.client.indexQuotes(['usNDX']), { code: 'bridge_unavailable' });
  await h.flush(); h.client.destroy();
  await Promise.all([second, third]);
  assert.equal(h.frames.every(frame => frame.removed), true);
  assert.equal(h.timers.size, 0);
});

test('a source timeout removes the stuck frame and the next job gets a clean realm', async () => {
  const h = harness({ reply: false });
  const first = assert.rejects(h.client.securityQuotes(['usSPY'], { timeoutMs: 7000 }), { code: 'timeout' });
  const second = assert.rejects(h.client.securityQuotes(['usQQQ'], { timeoutMs: 7000 }), { code: 'timeout' });
  await h.advance(14000); await Promise.all([first, second]);
  assert.deepEqual(h.sent.map(x => x.at), [0, 7000]);
  assert.equal(h.frames.every(frame => frame.removed), true);
  h.client.destroy();
});
