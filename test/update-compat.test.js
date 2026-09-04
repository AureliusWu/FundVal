import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../js/update-compat.js', import.meta.url), 'utf8');

function createHarness(legacyApply) {
  let clickHandler = null;
  const context = {
    document: {
      addEventListener(type, handler) {
        if (type === 'click') clickHandler = handler;
      },
    },
  };
  if (legacyApply) context.applyPendingServiceWorkerUpdate = legacyApply;
  runInNewContext(source, context, { filename: 'update-compat.js' });
  assert.equal(typeof clickHandler, 'function');
  return clickHandler;
}

function createClickEvent({ matches = true } = {}) {
  const state = { prevented: 0, stopped: 0, selector: '' };
  return {
    state,
    event: {
      target: {
        closest(selector) {
          state.selector = selector;
          return matches ? { id: 'update-now-btn' } : null;
        },
      },
      preventDefault() { state.prevented += 1; },
      stopImmediatePropagation() { state.stopped += 1; },
    },
  };
}

test('mixed-release page delegates the new update action to the legacy guarded updater', () => {
  let applied = 0;
  const handler = createHarness(() => { applied += 1; });
  const { event, state } = createClickEvent();

  handler(event);

  assert.equal(state.selector, '#update-now-btn[data-action="apply-update"]');
  assert.equal(applied, 1);
  assert.equal(state.prevented, 1);
  assert.equal(state.stopped, 1);
});

test('current app action keeps propagating when no legacy updater is present', () => {
  const handler = createHarness();
  const { event, state } = createClickEvent();

  handler(event);

  assert.equal(state.prevented, 0);
  assert.equal(state.stopped, 0);
});

test('compatibility bridge ignores unrelated click targets', () => {
  let applied = 0;
  const handler = createHarness(() => { applied += 1; });
  const { event, state } = createClickEvent({ matches: false });

  handler(event);

  assert.equal(applied, 0);
  assert.equal(state.prevented, 0);
  assert.equal(state.stopped, 0);
});

test('compatibility bridge tolerates malformed events and legacy failures', async () => {
  const syncFailure = createHarness(() => { throw new Error('legacy failure'); });
  assert.doesNotThrow(() => syncFailure(null));
  assert.doesNotThrow(() => syncFailure({ target: {} }));
  const rejectedFailure = createHarness(() => Promise.reject(new Error('legacy rejection')));
  const { event } = createClickEvent();
  assert.doesNotThrow(() => rejectedFailure(event));
  await Promise.resolve();
});

test('compatibility bridge loads before the app entry and cannot bypass update safety guards', async () => {
  const [index, worker, app, fingerprint] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/release-fingerprint.mjs', import.meta.url), 'utf8'),
  ]);
  const compatOffset = index.indexOf('src="js/update-compat.js"');
  const appOffset = index.indexOf('src="js/bootstrap.js"');
  assert.ok(compatOffset > 0 && compatOffset < appOffset);
  assert.match(index, /<script src="js\/update-compat\.js" defer><\/script>/);
  assert.doesNotMatch(index, /onclick=/);
  const core = worker.slice(worker.indexOf('const CORE'), worker.indexOf('self.addEventListener'));
  assert.match(core, /\.\/js\/update-compat\.js/);
  assert.ok(core.indexOf('./js/update-compat.js') < core.indexOf('BUILD_APP_SHELL_CORE_START'));
  assert.doesNotMatch(app, /Object\.assign\(window,[\s\S]{0,500}applyPendingServiceWorkerUpdate/);
  assert.match(fingerprint, /'js\/update-compat\.js'/);
  assert.doesNotMatch(source, /SKIP_WAITING|postMessage|serviceWorker|location\.reload/);
});
