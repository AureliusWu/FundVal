import test from 'node:test';
import assert from 'node:assert/strict';
import { createOcrPageGuard } from '../js/ocr/page-guard.js';

function target() {
  const listeners = new Map();
  return { addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type, event = {}) { for (const fn of [...listeners.get(type) || []]) fn(event); },
    count(type) { return listeners.get(type)?.size || 0; } };
}
function harness() {
  const state = { dirty: false, saving: false, confirm: true, discarded: 0, navigated: 0, restored: 0, notices: [], channels: [], frames: [] };
  const style = new Map(), document = { ...target(), documentElement: { style: { setProperty: (key, value) => style.set(key, value) } } };
  const window = { ...target(), document, visualViewport: { ...target(), height: 844, offsetTop: 0 },
    confirm: () => state.confirm, requestAnimationFrame: fn => state.frames.push(fn),
    BroadcastChannel: class {
      constructor(name) { Object.assign(this, target()); this.name = name; this.messages = []; this.closed = 0; state.channels.push(this); }
      postMessage(message) { this.messages.push(message); }
      close() { this.closed++; }
    } };
  const guard = createOcrPageGuard({ window, hasPendingWork: () => state.dirty, isSaving: () => state.saving,
    discard: () => state.discarded++, navigate: () => state.navigated++, notify: message => state.notices.push(message), restored: () => state.restored++ });
  return { state, style, window, document, guard };
}
test('OCR page guard is inert until start and installs only one lifecycle listener/channel', () => {
  const h = harness(); assert.equal(h.state.channels.length, 0);
  h.guard.start(); h.guard.start();
  assert.equal(h.window.count('beforeunload'), 1); assert.equal(h.window.count('pagehide'), 1);
  assert.equal(h.state.channels.length, 1); assert.equal(h.state.channels[0].name, 'fuyu_sw_update_v1');
  h.guard.dispose(); h.guard.dispose();
  assert.equal(h.window.count('beforeunload'), 0); assert.equal(h.window.count('pagehide'), 0); assert.equal(h.state.channels[0].closed, 1);
});
test('OCR pending preview blocks unload; clean entry does not prompt or discard', () => {
  const h = harness(); h.guard.start(); let prevented = 0;
  const event = { preventDefault() { prevented++; }, returnValue: undefined };
  h.window.fire('beforeunload', event); assert.equal(prevented, 0);
  h.state.dirty = true; h.window.fire('beforeunload', event);
  assert.equal(prevented, 1); assert.equal(event.returnValue, ''); assert.equal(h.state.discarded, 0);
});
test('OCR leave never interrupts a commit and a rejected discard retains the preview', () => {
  const h = harness(); h.guard.start(); h.state.saving = true;
  assert.equal(h.guard.requestLeave(), false); assert.equal(h.state.notices.length, 1);
  h.state.saving = false; h.state.dirty = true; h.state.confirm = false;
  assert.equal(h.guard.requestLeave(), false); assert.equal(h.state.discarded, 0); assert.equal(h.state.navigated, 0);
  h.state.confirm = true; assert.equal(h.guard.requestLeave(), true);
  assert.equal(h.state.discarded, 1); assert.equal(h.state.navigated, 1);
});
test('OCR update peer sends only a bounded request identity and fixed blocked message', () => {
  const h = harness(); h.guard.start(); const channel = h.state.channels[0];
  channel.fire('message', { data: { type: 'prepare', requestId: 'sw-synthetic-1' } });
  assert.equal(channel.messages.length, 0); h.state.dirty = true;
  for (const data of [{ type: 'prepare', requestId: 'private/invalid' }, { type: 'prepare', requestId: {} }, { type: 'prepare', requestId: 'sw-' + 'a'.repeat(100) }, { type: 'blocked', requestId: 'sw-1' }]) channel.fire('message', { data });
  assert.equal(channel.messages.length, 0);
  channel.fire('message', { data: { type: 'prepare', requestId: 'sw-synthetic-1', image: 'untrusted-content' } });
  assert.deepEqual(channel.messages, [{ type: 'blocked', requestId: 'sw-synthetic-1' }]);
});
test('OCR keyboard viewport is applied from real dimensions, and suspended/closed on pagehide', () => {
  const h = harness(); h.guard.start();
  assert.equal(h.style.get('--ocr-viewport-height'), '844px');
  h.window.visualViewport.height = 400; h.window.visualViewport.offsetTop = 44;
  h.window.visualViewport.fire('resize');
  assert.equal(h.style.get('--ocr-viewport-height'), '400px'); assert.equal(h.style.get('--ocr-viewport-top'), '44px');
  h.window.fire('pagehide'); assert.equal(h.state.discarded, 1); assert.equal(h.window.count('beforeunload'), 0);
  assert.equal(h.state.channels[0].closed, 1);
  h.window.fire('pageshow', { persisted: true });
  assert.equal(h.state.restored, 1); assert.equal(h.window.count('beforeunload'), 1); assert.equal(h.state.channels.length, 2);
});
test('OCR deferred keyboard focus work cannot scroll a detached session after disposal', () => {
  const h = harness(); h.guard.start(); let scrolled = 0;
  const field = { matches: () => true, scrollIntoView: () => scrolled++ };
  h.document.activeElement = field; h.document.fire('focusin', { target: field });
  h.guard.dispose(); h.state.frames[0](); assert.equal(scrolled, 0);
});
