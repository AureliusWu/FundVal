import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseSync } from 'rolldown/utils';

const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const build = await readFile(new URL('../scripts/build-site.mjs', import.meta.url), 'utf8');
const worker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const program = parseSync('app.js', app).program;
const buildProgram = parseSync('build-site.mjs', build).program;
const declaration = (body, name) => body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
  .find(node => node.id?.name === name);
const called = (node, object, property) => node?.type === 'CallExpression'
  && node.callee?.type === 'MemberExpression' && node.callee.object?.name === object
  && node.callee.property?.name === property;

test('real App imports and constructs the two planned responsibility owners', () => {
  for (const [path, imported, owner] of [
    ['./runtime/sync-status.js', 'createSyncStatus', 'syncController'],
    ['./runtime/pwa-update-controller.js', 'createPwaUpdateController', 'pwaUpdateController'],
  ]) {
    const entry = program.body.find(node => node.type === 'ImportDeclaration' && node.source.value === path);
    assert.ok(entry?.specifiers.some(node => node.imported?.name === imported));
    const instance = declaration(program.body, owner);
    assert.equal(instance?.init?.type, 'CallExpression');
    assert.equal(instance.init.callee.name, imported);
  }
});

test('App does not retain a second copy of migrated update and synchronization state', () => {
  const forbidden = new Set(['syncPending', 'syncDebounceTimer', 'autoPullTimer', 'isSyncing',
    'pendingServiceWorker', 'requestedServiceWorker', 'serviceWorkerUpdateApplying',
    'serviceWorkerReloadPending', 'serviceWorkerUpdateChannel', 'reloadingForServiceWorkerUpdate']);
  const retained = program.body.flatMap(node => node.type === 'VariableDeclaration' ? node.declarations : [])
    .filter(node => forbidden.has(node.id?.name)).map(node => node.id.name);
  assert.deepEqual(retained, []);
});

test('App sync entry names delegate to the real state owner instead of retaining algorithms', () => {
  for (const name of ['hasCloudConfig', 'renderCloudStatus', 'hasPendingSync',
    'resolveGistId', 'pullFromCloud', 'pushToCloud', 'scheduleAutoPush', 'startAutoPull', 'autoPullOnLoad']) {
    const fn = program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
    assert.ok(fn, `Keep the App entry ${name}`);
    assert.equal(fn.body.body.length, 1, `${name} must not duplicate controller state/algorithm`);
    assert.equal(fn.body.body[0].type, 'ReturnStatement');
    assert.ok(called(fn.body.body[0].argument, 'syncController', name));
  }
  // M4 manual actions no longer inject this unused App wrapper. Failure policy
  // still belongs to the real controller, tested through its active API.
  assert.doesNotMatch(app, /function handleCloudFailure\(/);
});

test('PWA starts once at the former registration phase and reads sync busy state dynamically', () => {
  const starts = program.body.filter(node => node.type === 'ExpressionStatement'
    && called(node.expression, 'pwaUpdateController', 'start'));
  assert.equal(starts.length, 1);
  const consume = program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'consumeOcrImportReturn');
  const bindings = program.body.find(node => node.type === 'ExpressionStatement'
    && node.expression?.callee?.name === 'initActionBindings');
  assert.ok(starts[0].start > consume.end && starts[0].end < bindings.start);
  assert.doesNotMatch(app, /navigator\.serviceWorker\.register\(/);
  const instance = declaration(program.body, 'pwaUpdateController');
  const options = instance.init.arguments[0];
  const busy = options.properties.find(node => node.key?.name === 'isSyncing').value;
  assert.equal(busy.type, 'ArrowFunctionExpression');
  assert.ok(called(busy.body, 'syncController', 'isSyncing'));
});

test('new responsibility modules remain in the original post-integrity group without changing five groups', () => {
  const set = declaration(buildProgram.body, 'POST_INTEGRITY_MODULES').init.arguments[0].elements.map(node => node.value);
  assert.ok(set.includes('js/runtime/sync-status.js'));
  assert.ok(set.includes('js/runtime/pwa-update-controller.js'));
  assert.ok(worker.includes("'./js/runtime/sync-status.js'"));
  assert.ok(worker.includes("'./js/runtime/pwa-update-controller.js'"));
  const groups = declaration(buildProgram.body, 'APP_CHUNK_GROUPS').init.elements.map(node =>
    Object.fromEntries(node.properties.filter(property => ['name', 'priority'].includes(property.key?.name))
      .map(property => [property.key.name, property.value.value])));
  assert.deepEqual(groups, [
    { name: 'startup-pure', priority: 100 }, { name: 'post-integrity', priority: 90 },
    { name: 'business-runtime', priority: 10 }, { name: 'cloud', priority: 10 },
    { name: 'diagnostics', priority: 10 },
  ]);
});
