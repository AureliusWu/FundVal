import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudArchiveFeature } from '../js/storage/cloud-archive-ui.js';

function harness(t, overrides = {}) {
  const originalDocument = globalThis.document;
  const originalConfirm = globalThis.confirm;
  const elements = Object.fromEntries(['gist-token', 'cloud-upload-btn', 'cloud-download-btn'].map(id => [id, { value: '', textContent: '', disabled: false }]));
  elements['gist-token'].value = 'synthetic-never-sent';
  const calls = [];
  let rows = [{ code: '000001' }];
  globalThis.document = { getElementById: id => elements[id] };
  globalThis.confirm = () => true;
  t.after(() => { globalThis.document = originalDocument; globalThis.confirm = originalConfirm; });
  const context = {
    getHoldingsDocument: () => ({ holdings: rows }), getHoldings: () => rows,
    setGistToken: () => calls.push('token'), getGistId: () => 'synthetic-id', setGistId: () => calls.push('id'),
    pushToCloud: async () => ({ ok: true }), pullFromCloud: async () => { rows = [...rows, { code: '000002' }]; return { ok: true }; },
    markSyncPending: () => calls.push('pending'), handleCloudFailure: () => calls.push('failure'),
    renderCloudStatus: () => calls.push('status'), showToast: message => calls.push(message), startAutoPull: () => calls.push('auto-pull'),
    GIST_TOKEN_KEY: 'synthetic_token', GIST_ID_KEY: 'synthetic_id', GIST_SYNC_TIME_KEY: 'synthetic_time', SYNC_META_KEY: 'synthetic_meta',
    safeRemoveItem: key => calls.push(key), resetCloudState: () => calls.push('reset'), ...overrides,
  };
  return { feature: createCloudArchiveFeature(context), elements, calls };
}

test('v16 lazy upload reads a Schema 3 document and restores the button after success', async t => {
  const { feature, calls, elements } = harness(t);
  await feature.uploadToCloud();
  assert.ok(calls.includes('已上传并通过云端读回校验'));
  assert.ok(calls.includes('auto-pull'));
  assert.equal(elements['cloud-upload-btn'].disabled, false);
  assert.equal(elements['cloud-upload-btn'].textContent, '上传到云端');
});

test('v16 lazy upload failure preserves pending changes and restores button state', async t => {
  const { feature, calls, elements } = harness(t, { pushToCloud: async () => ({ ok: false, reason: 'remote_write_failed' }) });
  await feature.uploadToCloud();
  assert.ok(calls.includes('pending'));
  assert.ok(calls.includes('failure'));
  assert.equal(elements['cloud-upload-btn'].disabled, false);
});

test('v16 lazy download counts the latest holdings after a merge', async t => {
  const { feature, calls, elements } = harness(t);
  await feature.downloadFromCloud();
  assert.ok(calls.includes('已合并，新增 1 条，共 2 条'));
  assert.equal(elements['cloud-download-btn'].disabled, false);
});

test('v16 lazy clear delegates root timer/pending state reset and deletes only config keys', t => {
  const { feature, calls, elements } = harness(t);
  feature.clearCloudConfig();
  assert.deepEqual(calls.slice(0, 5), ['synthetic_token', 'synthetic_id', 'synthetic_time', 'synthetic_meta', 'reset']);
  assert.equal(elements['gist-token'].value, '');
});

test('v16 lazy archive never creates a remote before explicit Schema 3 approval', async t => {
  const { feature } = harness(t);
  assert.deepEqual(await feature.createCloudArchive('synthetic-never-sent'), { ok: false, reason: 'remote_schema_upgrade_required', writeSchema: 2 });
});
