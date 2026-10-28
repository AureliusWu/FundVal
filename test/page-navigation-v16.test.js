import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageNavigation } from '../js/runtime/page-navigation.js';

function harness(hash = '', initialState = null) {
  const entries = [{ url: 'https://example.test/FundVal/?keep=1' + hash, state: initialState }];
  const listeners = new Map(), rendered = []; let index = 0;
  const window = {
    location: { get href() { return entries[index].url; } },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
    history: {
      get state() { return entries[index].state; },
      pushState(state, _, url) { entries.splice(index + 1); entries.push({ state, url: String(url) }); index++; },
      replaceState(state, _, url) { entries[index] = { state, url: String(url) }; },
      back() { if (index) { index--; listeners.get('popstate')?.(); } },
      forward() { if (index < entries.length - 1) { index++; listeners.get('popstate')?.(); } },
    },
  };
  const router = createPageNavigation({ window, showPage: name => rendered.push(name) });
  return { router, window, rendered, entries, listeners };
}

test('default market start adds no startup URL/history entry or render side effect', () => {
  const h = harness(); h.router.start(); h.router.start();
  assert.equal(h.entries.length, 1); assert.deepEqual(h.rendered, []);
  assert.equal(h.window.location.href, 'https://example.test/FundVal/?keep=1');
});

test('native back/forward changes panels without dropping the document or its query', () => {
  const h = harness(); h.router.start(); h.router.navigate('edit');
  assert.deepEqual(h.rendered, ['edit']); assert.equal(h.entries.length, 2);
  assert.equal(new URL(h.window.location.href).hash, '#edit');
  h.window.history.back(); assert.equal(h.rendered.at(-1), 'market');
  assert.equal(h.window.location.href, 'https://example.test/FundVal/?keep=1');
  h.window.history.forward(); assert.equal(h.rendered.at(-1), 'edit');
});

test('market button consumes the owned edit entry instead of growing an alternating stack', () => {
  const h = harness(); h.router.navigate('edit'); h.router.navigate('market');
  assert.equal(h.rendered.at(-1), 'market'); assert.equal(new URL(h.window.location.href).hash, '');
  h.router.navigate('edit'); assert.equal(h.entries.length, 2);
  h.router.navigate('edit'); assert.equal(h.entries.length, 2);
});

test('an initial edit deep link seeds exactly one safe market back target', () => {
  const h = harness('#edit'); h.router.start();
  assert.equal(h.entries.length, 2); assert.equal(h.rendered.at(-1), 'edit');
  h.window.history.back(); assert.equal(h.rendered.at(-1), 'market');
  assert.equal(new URL(h.window.location.href).search, '?keep=1');
});

test('a restored owned edit entry is not seeded twice', () => {
  const h = harness('#edit', { fuyuPageNavigation: 'edit' }); h.router.start();
  assert.equal(h.entries.length, 1); assert.deepEqual(h.rendered, ['edit']);
});

test('unsupported or denied history keeps ordinary panel navigation usable', () => {
  const rendered = [], router = createPageNavigation({ window: {}, showPage: page => rendered.push(page) });
  router.navigate('edit'); router.navigate('market'); assert.deepEqual(rendered, ['edit', 'market']);
  const h = harness(); h.window.history.pushState = () => { throw new Error('denied'); };
  h.router.navigate('edit'); assert.deepEqual(h.rendered, ['edit']);
});

test('unknown pages/anchors never become an arbitrary URL or callback argument', () => {
  const h = harness('#external-anchor'); h.router.start();
  for (const value of ['../other', 'https://elsewhere.test', '', null, {}]) assert.equal(h.router.navigate(value), false);
  assert.deepEqual(h.rendered, []); assert.equal(h.entries.length, 1);
});

test('dispose removes only its own popstate listener and can restart', () => {
  const h = harness(); h.router.start(); assert.equal(h.listeners.has('popstate'), true);
  h.router.dispose(); assert.equal(h.listeners.has('popstate'), false);
  h.router.start(); assert.equal(h.listeners.has('popstate'), true);
});

test('repeated market clicks before native popstate dispatch request back only once', () => {
  const h = harness(); let backCalls = 0;
  const originalBack = h.window.history.back;
  h.window.history.back = () => { backCalls++; };
  h.router.navigate('edit'); h.router.navigate('market'); h.router.navigate('market');
  assert.equal(backCalls, 1, 'a delayed native traversal must not queue another back outside the App');
  originalBack(); assert.equal(h.rendered.at(-1), 'market');
  h.router.navigate('edit'); h.router.navigate('market'); assert.equal(backCalls, 2);
});
