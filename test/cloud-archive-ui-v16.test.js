import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudArchiveFeature } from '../js/storage/cloud-archive-ui.js';

function harness(t, overrides = {}) {
  const originalDocument = globalThis.document;
  const originalConfirm = globalThis.confirm;
  const elements = Object.fromEntries(['gist-token', 'gist-remember-token', 'cloud-upload-btn', 'cloud-download-btn'].map(id => [id, { value: '', textContent: '', disabled: false, checked: false }]));
  elements['gist-token'].value = 'synthetic-never-sent';
  const calls = [];
  let rows = [{ code: '000001' }];
  globalThis.document = { getElementById: id => elements[id] };
  globalThis.confirm = () => true;
  t.after(() => { globalThis.document = originalDocument; globalThis.confirm = originalConfirm; });
  const context = {
    getHoldingsDocument: () => ({ holdings: rows }), getHoldings: () => rows,
    setGistToken: (token, options) => { calls.push(['token', options]); return { ok: true }; }, getGistId: () => 'abcdef', setGistId: () => { calls.push('id'); return true; },
    pushToCloud: async () => ({ ok: true, remoteVerified: true }), pullFromCloud: async () => { rows = [...rows, { code: '000002' }]; return { ok: true, remoteVerified: true }; },
    markSyncPending: () => calls.push('pending'), handleCloudFailure: () => calls.push('failure'),
    renderCloudStatus: () => calls.push('status'), showToast: message => calls.push(message), startAutoPull: () => calls.push('auto-pull'),
    GIST_TOKEN_KEY: 'synthetic_token', GIST_ID_KEY: 'synthetic_id', GIST_SYNC_TIME_KEY: 'synthetic_time', SYNC_META_KEY: 'synthetic_meta',
    clearGistCredentials: async () => { calls.push('credentials-clear'); return { ok: true, current: true }; },
    setArchiveCandidates: rows => calls.push(['candidates', rows]),
    runManualOperation: async action => action({ isCurrent: () => true }),
    captureCloudConfigurationScope: () => ({ isCurrent: () => true }),
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

test('v16 lazy upload failure preserves pending without recording the controller failure twice', async t => {
  const { feature, calls, elements } = harness(t, { pushToCloud: async () => ({ ok: false, reason: 'remote_write_failed' }) });
  await feature.uploadToCloud();
  assert.ok(calls.includes('pending'));
  assert.equal(calls.includes('failure'), false);
  assert.equal(elements['cloud-upload-btn'].disabled, false);
});

test('v16 lazy download counts the latest holdings after a merge', async t => {
  const { feature, calls, elements } = harness(t);
  await feature.downloadFromCloud();
  assert.ok(calls.includes('已合并，新增 1 条，共 2 条'));
  assert.equal(elements['cloud-download-btn'].disabled, false);
});

test('v16 lazy clear delegates to the sole App configuration owner without duplicate cleanup', async t => {
  const { feature, calls, elements } = harness(t);
  await feature.clearCloudConfig();
  assert.equal(calls[0], 'credentials-clear');
  assert.equal(calls.includes('reset'), false);
  assert.equal(calls.includes('synthetic_id'), false);
  assert.equal(calls.some(item => Array.isArray(item) && item[0] === 'candidates'), false);
});

test('M4 failed credential deletion warns that refreshing can restore the retained credential', async t => {
  const { feature, calls } = harness(t, { clearGistCredentials: async () => ({ ok: false, current: true }) });
  await feature.clearCloudConfig();
  assert.ok(calls.some(value => typeof value === 'string' && value.includes('刷新或重开可能恢复旧凭证')));
});

test('M4 upload uses session credentials by default and persistence only on explicit selection', async t => {
  const { feature, calls, elements } = harness(t);
  await feature.uploadToCloud();
  assert.deepEqual(calls.find(item => Array.isArray(item) && item[0] === 'token'), ['token', { persist: false }]);
  calls.length = 0; elements['gist-remember-token'].checked = true;
  await feature.uploadToCloud();
  assert.deepEqual(calls.find(item => Array.isArray(item) && item[0] === 'token'), ['token', { persist: true }]);
});

test('M4 an acknowledged-only result cannot display verified upload success', async t => {
  const { feature, calls } = harness(t, { pushToCloud: async () => ({ ok: true }) });
  await feature.uploadToCloud();
  assert.equal(calls.includes('已上传并通过云端读回校验'), false);
  assert.ok(calls.includes('变更已保留，仍有内容待同步或待核验'));
});

test('M4 multiple archives stop upload rather than creating or writing an arbitrary archive', async t => {
  let writes = 0;
  const { feature, elements } = harness(t, { getGistId: () => '',
    resolveGistId: async () => ({ ok: false, reason: 'archive_selection_required' }),
    pushToCloud: async () => { writes++; }, fetchWithTimeout: async () => { writes++; },
  });
  await feature.uploadToCloud();
  assert.equal(writes, 0); assert.equal(elements['cloud-upload-btn'].disabled, false);
});

test('M4 an unknown prior POST cannot blindly create another archive even after empty discovery', async t => {
  const { feature, calls } = harness(t, { getGistId: () => '', getSyncStatus: () => ({ readFirst: true }),
    resolveGistId: async () => ({ ok: false, reason: 'remote_archive_missing' }),
    fetchWithTimeout: () => assert.fail('must not create another archive') });
  await feature.uploadToCloud();
  assert.ok(calls.includes('上次创建结果尚未确认，已阻止重复创建。请稍后刷新档案列表并明确选择。'));
});

test('M4 credential save failure prevents all cloud IO', async t => {
  const { feature, calls } = harness(t, { setGistToken: async () => ({ ok: false, reason: 'credential_write_failed' }),
    pushToCloud: () => assert.fail('must not write') });
  await feature.uploadToCloud();
  assert.ok(calls.includes('凭证保存或旧凭证清除失败，请检查浏览器存储后重试'));
});

test('M4 network exception details never reach the visible toast', async t => {
  const { feature, calls } = harness(t, { pushToCloud: async () => { throw new Error('synthetic-private-user-content'); } });
  await feature.uploadToCloud();
  assert.equal(JSON.stringify(calls).includes('synthetic-private-user-content'), false);
});

test('M4 stale local adapters refuse queued repository work after configuration changes', async t => {
  const { feature, calls } = harness(t);
  const adapter = feature.createCloudLocalAdapter('abcdef', { isCurrent: () => false });
  for (const result of [await adapter.load(), await adapter.backup({}), await adapter.persist({}), await adapter.markPending(true, {})]) {
    assert.equal(result.ok, false); assert.equal(result.reason, 'cloud_configuration_changed');
  }
  assert.equal(calls.includes('pending'), false);
});

test('v16 lazy archive never creates a remote before explicit Schema 3 approval', async t => {
  const { feature } = harness(t);
  assert.deepEqual(await feature.createCloudArchive('synthetic-never-sent'), { ok: false, reason: 'remote_schema_upgrade_required', writeSchema: 2 });
});
