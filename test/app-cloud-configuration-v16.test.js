import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseSync } from 'rolldown/utils';
import { createSyncStatus } from '../js/runtime/sync-status.js';
import { createCloudArchiveFeature } from '../js/storage/cloud-archive-ui.js';
import { createGistCredentialStore } from '../js/storage/gist-credentials.js';

const source = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const ast = parseSync('app.js', source).program;
const names = ['loadGistCredentials', 'resetCloudConfiguration', 'setGistToken', 'clearGistCredentials', 'selectCloudArchive'];
const functions = names.map(name => {
  const node = ast.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name);
  if (!node) return `function ${name}(){throw new Error('missing real App function ${name}');}`;
  // Keep the real singleton-promise owner, replacing only its dynamic module
  // transport with a held local factory boundary. No VM/browser import or IO.
  return source.slice(node.start, node.end).replace("import('./storage/gist-credentials.js')", 'loadCredentialModule()');
}).join('\n');
const ID = 'a'.repeat(32), OTHER = 'b'.repeat(32);
function harness() {
  const calls = [], storage = new Map([['id', ID], ['time', '2026-10-25'], ['meta', 'synthetic-meta']]);
  let gate = null, clearBlocked = false;
  const makeStorage = () => {
    const values = new Map();
    return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
      getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
      removeItem(key) { if (clearBlocked) throw new Error('Synthetic removal denied'); values.delete(key); } };
  };
  const actualStore = createGistCredentialStore({ sessionStorage: makeStorage(), localStorage: makeStorage() });
  assert.equal(actualStore.save('synthetic-old', { persist: true }).ok, true);
  const elements = { 'gist-token': { value: 'synthetic-old' }, 'gist-remember-token': { checked: true }, 'gist-archive': { value: OTHER } };
  const store = {
    read: actualStore.read,
    save(token, options) { calls.push('save'); return actualStore.save(token, options); },
    clear() { calls.push('clear'); return actualStore.clear(); },
  };
  const controller = createSyncStatus({ getGistToken: () => store.read().token,
    getGistId: () => storage.get('id') || '', clearTimeout() {}, clearInterval() {} });
  const context = {
    GIST_ID_KEY: 'id', GIST_SYNC_TIME_KEY: 'time', SYNC_META_KEY: 'meta',
    GIST_TOKEN_KEY: 'synthetic-token-key', GIST_CONSENT_KEY: 'synthetic-consent-key',
    syncController: { ...controller, resetCloudState(options) { calls.push('reset'); calls.push(['reset-options', options]); controller.resetCloudState(options); } },
    async loadCredentialModule() { calls.push('load'); if (gate) await gate; return { createGistCredentialStore: () => store }; },
    sessionStore: () => null, localStore: () => null,
    safeRemoveItem(key) { calls.push(['remove', key]); storage.delete(key); return true; },
    setGistId(id) { calls.push(['id', id]); storage.set('id', id); return true; }, getGistId: () => storage.get('id') || '',
    setArchiveCandidates: value => calls.push(['candidates', value]),
    document: { getElementById: id => elements[id] },
    renderCredentialStatus: () => calls.push('credential-status'), renderCloudStatus: () => calls.push('status'),
    showToast: message => calls.push(['toast', message]), markSyncPending: () => calls.push('pending'),
    startAutoPull: () => calls.push('auto-pull'), confirm: () => true,
  };
  const api = vm.runInNewContext(`let cloudInputRevision=0,gistCredentialStore=null,gistCredentialsPromise=null;let archiveCandidates=[{id:${JSON.stringify(OTHER)}}];${functions};({${names.join(',')},bumpInputRevision:()=>{cloudInputRevision++}})`, context);
  return { api, calls, storage, elements, setGate: value => { gate = value; }, context,
    readToken: () => store.read().token, failClear: () => { clearBlocked = true; } };
}
test('App token replacement has one configuration reset/metadata cleanup owner', async () => {
  const h = harness(); await h.api.setGistToken('synthetic-new');
  assert.equal(h.calls.filter(item => item === 'reset').length, 1);
  assert.equal(h.calls.find(item => Array.isArray(item) && item[0] === 'reset-options')[1].preserveBackoff, false);
  for (const key of ['id', 'time', 'meta']) assert.equal(h.storage.has(key), false);
  assert.equal(h.calls.filter(item => Array.isArray(item) && item[0] === 'candidates').length, 1);
});
test('invalid token replacement preserves the existing archive and metadata', async () => {
  const h = harness(); await h.api.setGistToken('invalid value');
  assert.equal(h.calls.includes('reset'), false); assert.equal(h.storage.get('id'), ID);
  assert.equal(h.storage.get('meta'), 'synthetic-meta');
});
test('App clear invalidates before lazy await and owns all configuration/form cleanup once', async () => {
  const h = harness(); let resolve; h.setGate(new Promise(done => { resolve = done; }));
  const pending = h.api.clearGistCredentials();
  assert.equal(h.calls[0], 'reset'); assert.equal(h.storage.has('id'), false);
  resolve(); await pending;
  assert.equal(h.calls.filter(item => item === 'reset').length, 1);
  assert.equal(h.elements['gist-token'].value, ''); assert.equal(h.elements['gist-remember-token'].checked, false);
  for (const key of ['id', 'time', 'meta']) assert.equal(h.storage.has(key), false);
});
test('explicit archive selection preserves candidates, clears metadata and marks local data pending', () => {
  const h = harness(); h.api.selectCloudArchive();
  assert.equal(h.storage.get('id'), OTHER); assert.equal(h.storage.has('meta'), false);
  assert.equal(h.calls.filter(item => item === 'reset').length, 1);
  assert.equal(h.calls.some(item => Array.isArray(item) && item[0] === 'candidates'), false);
  assert.equal(h.calls.find(item => Array.isArray(item) && item[0] === 'reset-options')[1].preserveBackoff, true);
  assert.ok(h.calls.indexOf('pending') > h.calls.findIndex(item => Array.isArray(item) && item[0] === 'id'));
});

test('a late clear cannot overwrite input edited while the credential module loads', async () => {
  const h = harness(); let resolve; h.setGate(new Promise(done => { resolve = done; }));
  const pending = h.api.clearGistCredentials();
  h.api.bumpInputRevision();
  h.elements['gist-token'].value = 'synthetic-new-draft';
  h.elements['gist-remember-token'].checked = true;
  resolve(); await pending;
  assert.equal(h.elements['gist-token'].value, 'synthetic-new-draft');
  assert.equal(h.elements['gist-remember-token'].checked, true);
});

test('failed archive selection restores the actual identity instead of displaying an unsaved target', () => {
  const h = harness(); h.context.setGistId = () => false;
  h.api.selectCloudArchive();
  assert.equal(h.storage.get('id'), ID); assert.equal(h.storage.get('meta'), 'synthetic-meta');
  assert.equal(h.elements['gist-archive'].value, ID);
  assert.equal(h.calls.includes('pending'), false); assert.equal(h.calls.includes('auto-pull'), false);
});

test('actual shared credential await clears first and preserves a concurrently requested new save', async () => {
  const h = harness(); let resolve; h.setGate(new Promise(done => { resolve = done; }));
  const clearing = h.api.clearGistCredentials(), saving = h.api.setGistToken('synthetic-new');
  resolve(); const cleared = await clearing; await saving;
  assert.equal(h.calls.filter(item => item === 'clear').length, 1);
  assert.ok(h.calls.indexOf('clear') < h.calls.indexOf('save'));
  assert.equal(h.readToken(), 'synthetic-new'); assert.equal(cleared.current, false);
});

test('actual credential loader shares one promise and one factory across concurrent callers', async () => {
  const h = harness(); let resolve; h.setGate(new Promise(done => { resolve = done; }));
  const first = h.api.loadGistCredentials(), second = h.api.loadGistCredentials();
  assert.equal(first, second); assert.equal(h.calls.filter(item => item === 'load').length, 1);
  resolve(); assert.equal(await first, await second); assert.equal(h.api.loadGistCredentials(), first);
});

test('clear current result stays valid across a draft edit without erasing that input', async () => {
  const h = harness(); let resolve; h.setGate(new Promise(done => { resolve = done; }));
  const clearing = h.api.clearGistCredentials();
  h.api.bumpInputRevision(); h.elements['gist-token'].value = 'synthetic-unsaved-draft';
  resolve(); const cleared = await clearing;
  assert.equal(cleared.current, true); assert.equal(h.calls.filter(item => item === 'clear').length, 1);
  assert.equal(h.readToken(), ''); assert.equal(h.elements['gist-token'].value, 'synthetic-unsaved-draft');
});

test('clear result current is evaluated when consumed, not snapshotted before a later save', async () => {
  const h = harness(), cleared = await h.api.clearGistCredentials();
  assert.equal(cleared.current, true);
  await h.api.setGistToken('synthetic-new');
  assert.equal(cleared.current, false);
  assert.deepEqual(Object.keys(cleared).sort(), ['current', 'hasToken', 'legacyPending', 'mode', 'ok', 'reason', 'storageAvailable']);
  assert.doesNotMatch(JSON.stringify(cleared), /synthetic|"token"|revision|epoch/);
});

function clearUiHarness(t, h, clear) {
  const before = { document: globalThis.document, confirm: globalThis.confirm }, toasts = [];
  globalThis.document = h.context.document; globalThis.confirm = () => true;
  t.after(() => { globalThis.document = before.document; globalThis.confirm = before.confirm; });
  return { feature: createCloudArchiveFeature({ clearGistCredentials: clear, showToast: message => toasts.push(message) }), toasts };
}
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

for (const replacement of ['save', 'reset']) test('actual clear owner and UI suppress an old clear toast after a new ' + replacement + ' before UI continuation', async t => {
  const h = harness(); let release;
  const held = new Promise(done => { release = done; });
  const ui = clearUiHarness(t, h, async () => { const result = await h.api.clearGistCredentials(); await held; return result; });
  const clearing = ui.feature.clearCloudConfig(); await flush();
  assert.equal(h.calls.filter(item => item === 'clear').length, 1);
  if (replacement === 'save') await h.api.setGistToken('synthetic-new');
  else h.context.syncController.resetCloudState();
  release(); await clearing;
  assert.equal(h.readToken(), replacement === 'save' ? 'synthetic-new' : ''); assert.deepEqual(ui.toasts, []);
});

test('actual failed clear remains visible after a draft edit while shared loading is pending', async t => {
  const h = harness(); h.failClear(); let resolve; h.setGate(new Promise(done => { resolve = done; }));
  const ui = clearUiHarness(t, h, () => h.api.clearGistCredentials());
  const clearing = ui.feature.clearCloudConfig();
  h.api.bumpInputRevision(); h.elements['gist-token'].value = 'synthetic-unsaved-draft';
  resolve(); await clearing;
  assert.equal(h.calls.filter(item => item === 'clear').length, 1);
  assert.equal(h.elements['gist-token'].value, 'synthetic-unsaved-draft');
  assert.equal(ui.toasts.length, 1); assert.match(ui.toasts[0], /刷新或重开可能恢复旧凭证/);
});

test('clear UI refuses an unknown-current result instead of guessing a completed clear', async t => {
  const h = harness(), ui = clearUiHarness(t, h, async () => ({ ok: true }));
  await ui.feature.clearCloudConfig(); assert.deepEqual(ui.toasts, []);
});
