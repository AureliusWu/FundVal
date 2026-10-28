import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCloudArchiveFeature } from '../js/storage/cloud-archive-ui.js';

// Independent original functions captured before sharing the action skeleton.
// The actual module factory below is the candidate; it is not compared with a
// second new wrapper. Creation/readback internals are unchanged and separately
// covered by cloud-sync-readback tests; here the approved manual callback is a
// boundary stub, deliberately not an alternative reimplementation of creation.
const FROZEN_ACTIONS = "async function prepareCredentials() {\n  const token = document.getElementById('gist-token').value.trim();\n  if (!token) { showToast('请输入 GitHub Token'); return null; }\n  const saved = await setGistToken(token, { persist: document.getElementById('gist-remember-token')?.checked === true });\n  if (saved === false || saved?.ok === false) {\n    showToast('凭证保存或旧凭证清除失败，请检查浏览器存储后重试'); return null;\n  }\n  return token;\n}\n\nasync function discoverForSync(token) {\n  if (getGistId()) return { ok: true, gistId: getGistId() };\n  return runManualOperation(async () => {\n    const found = await resolveGistId(token);\n    return typeof found === 'string' && found\n      ? { ok: true, pending: true, gistId: found }\n      : found || { ok: false, reason: 'remote_archive_missing' };\n  });\n}\n\nasync function uploadToCloud() {\n  const holdingsDocument = getHoldingsDocument();\n  const token = await prepareCredentials();\n  if (!token) return;\n  if (!holdingsDocument || !holdingsDocument.holdings.length) { showToast('没有持仓数据可上传'); return; }\n\n  var uploadBtn = document.getElementById('cloud-upload-btn');\n  uploadBtn.textContent = '上传中...';\n  uploadBtn.disabled = true;\n\n  try {\n    const discovered = await discoverForSync(token);\n    const gistId = discovered?.gistId;\n    let result;\n    if (!discovered?.ok && discovered?.reason !== 'remote_archive_missing') return;\n    if (!gistId && getSyncStatus?.().readFirst) {\n      showToast('上次创建结果尚未确认，已阻止重复创建。请稍后刷新档案列表并明确选择。'); return;\n    }\n    if (gistId) result = await pushToCloud(false);\n    else result = { ok: false, reason: 'remote_schema_upgrade_required' };\n    if (!result?.ok && result?.reason === 'remote_schema_upgrade_required') {\n      const approved = confirm(\n        '为保护删除记录和多设备冲突，需要创建独立的 Schema 3 云端存档。' +\n        '旧版文件会保留，v14 或更早版本的写入不会覆盖新格式；旧版新增变更会在新版下次同步时安全合并。是否继续？'\n      );\n      if (approved) {\n        result = gistId\n          ? await pushToCloud(false, { upgradeSchema: true })\n          : await runManualOperation(scope => createCloudArchive(token, { targetSchema: 3, scope }));\n      }\n    }\n    if (!result?.ok) {\n      markSyncPending();\n      return;\n    }\n    renderCloudStatus();\n    showToast(result.remoteVerified === true && !result.pending ? '已上传并通过云端读回校验' : '变更已保留，仍有内容待同步或待核验');\n    startAutoPull();\n  } catch (_) {\n    markSyncPending();\n    showToast('云同步未完成，变更已保留，请检查网络后重试');\n  } finally {\n    uploadBtn.textContent = '上传到云端';\n    uploadBtn.disabled = false;\n  }\n}\n\nasync function downloadFromCloud() {\n  const token = await prepareCredentials();\n  if (!token) return;\n\n  var downloadBtn = document.getElementById('cloud-download-btn');\n  downloadBtn.textContent = '下载中...';\n  downloadBtn.disabled = true;\n\n  try {\n    const discovered = await discoverForSync(token);\n    if (!discovered?.ok) return;\n    var before = getHoldings().length;\n    const result = await pullFromCloud(false);\n    if (!result?.ok) return;\n    if (result.remoteVerified !== true || result.pending) {\n      showToast('下载已处理，仍有内容待同步或待核验');\n    } else if (getHoldings().length > before) {\n      showToast('已合并，新增 ' + (getHoldings().length - before) + ' 条，共 ' + getHoldings().length + ' 条');\n    } else {\n      showToast('已完成云端校验，共 ' + getHoldings().length + ' 条');\n    }\n    startAutoPull();\n  } catch (_) {\n    showToast('下载未完成，请检查网络后重试；本地持仓不会删除');\n  } finally {\n    downloadBtn.textContent = '从云端下载';\n    downloadBtn.disabled = false;\n  }\n}";
const ORIGINAL_ACTIONS_SHA256 = '960bed7f59218c43b34ad324d51fb802f63501697c3b5439aad85859bd0654a5';
const bindings = 'const {getHoldingsDocument,getHoldings,setGistToken,getGistId,runManualOperation,resolveGistId,getSyncStatus,pushToCloud,pullFromCloud,markSyncPending,renderCloudStatus,showToast,startAutoPull}=context;';
function originalFactory(context, document, confirm, source = FROZEN_ACTIONS) {
  return new Function('context', 'document', 'confirm', bindings + source
    + '\nreturn {uploadToCloud,downloadFromCloud};')(context, document, confirm);
}

function harness(options = {}) {
  const trace = [];
  let rows = Array.from({ length: options.rows ?? 1 }, (_, index) => ({ code: String(index) }));
  let manualCalls = 0, pushes = 0, toasted = 0;
  const buttons = {};
  for (const id of ['cloud-upload-btn', 'cloud-download-btn']) {
    buttons[id] = new Proxy({ textContent: 'original', disabled: false }, {
      set(object, key, value) { trace.push(['button', id, key, value]); object[key] = value; return true; },
    });
  }
  const document = { getElementById(id) {
    trace.push(['element', id]);
    if (id === 'gist-token') return { value: options.noToken ? ' ' : ' synthetic-token ' };
    if (id === 'gist-remember-token') return options.missingCheckbox ? null : { checked: options.persist === true };
    return buttons[id];
  } };
  const confirm = text => { trace.push(['confirm', text]); return options.approved !== false; };
  const checkpoint = async label => { trace.push(['await-start', label]); await Promise.resolve(); trace.push(['await-end', label]); };
  const context = {
    captureCloudConfigurationScope: () => ({ isCurrent: () => true }),
    getHoldingsDocument() { trace.push('get-document'); return options.noDocument ? null : { holdings: rows }; },
    getHoldings() { trace.push(['get-holdings', rows.length]); return rows; },
    async setGistToken(token, saveOptions) {
      trace.push(['save-credentials', token === 'synthetic-token', saveOptions.persist]);
      await checkpoint('credentials');
      if (options.credentialRows !== undefined) rows = Array.from({ length: options.credentialRows }, () => ({}));
      if (options.credentialsThrow) throw new Error('synthetic-private-error');
      return options.credentialsFail ? { ok: false } : { ok: true };
    },
    getGistId() { trace.push('get-id'); return options.missingId ? '' : 'abcdef'; },
    async runManualOperation(action) {
      trace.push(['manual', ++manualCalls]);
      if (options.manualFail) return { ok: false, reason: 'cloud_configuration_changed' };
      if (manualCalls === 2) { await checkpoint('manual-create'); return options.createResult || { ok: true, remoteVerified: true }; }
      return action({ isCurrent: () => true });
    },
    async resolveGistId() {
      trace.push('discover'); await checkpoint('discovery');
      if (options.discoveryThrow) throw new Error('synthetic-private-error');
      return options.discoveryResult ?? 'abcdef';
    },
    getSyncStatus() { trace.push('sync-status'); return { readFirst: options.readFirst === true }; },
    cloudCreateIntentStore: { read() { trace.push('create-intent-read'); return { ok: true, intent: null }; } },
    async pushToCloud(silent, upgrade) {
      trace.push(['push', silent, upgrade || null]); await checkpoint('push');
      if (options.pushThrow) throw new Error('synthetic-private-error');
      return options.pushResults ? options.pushResults[pushes++] : { ok: true, remoteVerified: true };
    },
    async pullFromCloud(silent) {
      trace.push(['pull', silent]); await checkpoint('pull');
      if (options.pullThrow) throw new Error('synthetic-private-error');
      rows = Array.from({ length: options.afterRows ?? 2 }, () => ({}));
      return options.pullResult ?? { ok: true, remoteVerified: true };
    },
    markSyncPending() { trace.push('pending'); },
    renderCloudStatus() { trace.push('render-status'); if (options.renderThrow) throw new Error('synthetic-private-error'); },
    showToast(text) { trace.push(['toast', text]); if (options.toastThrow && toasted++ === 0) throw new Error('synthetic-private-error'); },
    startAutoPull() { trace.push('auto-pull'); if (options.autoThrow) throw new Error('synthetic-private-error'); },
  };
  return { trace, buttons, document, confirm, context };
}

async function observe(factory, direction, options) {
  const current = harness(options);
  const previousDocument = globalThis.document, previousConfirm = globalThis.confirm;
  globalThis.document = current.document; globalThis.confirm = current.confirm;
  let completion;
  try {
    const feature = factory(current.context, current.document, current.confirm);
    const returned = feature[direction === 'upload' ? 'uploadToCloud' : 'downloadFromCloud']();
    assert.equal(typeof returned?.then, 'function', 'public action remains promise-returning');
    try { const value = await returned; completion = value === undefined ? 'undefined' : 'value'; }
    catch (error) { completion = ['rejected', error.name]; }
    return { trace: current.trace, completion, buttons: JSON.parse(JSON.stringify(current.buttons)) };
  } finally { globalThis.document = previousDocument; globalThis.confirm = previousConfirm; }
}
const candidateFactory = context => createCloudArchiveFeature(context);
const missing = { ok: false, reason: 'remote_archive_missing' };
const upgrade = { ok: false, reason: 'remote_schema_upgrade_required' };
const cases = [
  ['upload', 'missing token', { noToken: true }],
  ['download', 'missing token', { noToken: true }],
  ['upload', 'credential failure', { credentialsFail: true }],
  ['download', 'credential failure', { credentialsFail: true }],
  ['upload', 'credential rejection remains outside button try', { credentialsThrow: true }],
  ['download', 'credential rejection remains outside button try', { credentialsThrow: true }],
  ['upload', 'missing document checked only after credentials', { noDocument: true }],
  ['upload', 'empty snapshot', { rows: 0 }],
  ['download', 'empty local holdings still allow pull', { rows: 0 }],
  ['upload', 'precredential document snapshot cannot be replaced by newly grown state', { rows: 0, credentialRows: 1 }],
  ['upload', 'precredential document snapshot survives replacement by empty state', { rows: 1, credentialRows: 0 }],
  ['upload', 'multiple archives stop without pending/write', { missingId: true, discoveryResult: { ok: false, reason: 'archive_selection_required' } }],
  ['download', 'multiple archives stop before counting', { missingId: true, discoveryResult: { ok: false, reason: 'archive_selection_required' } }],
  ['upload', 'manual discovery config changed', { missingId: true, manualFail: true }],
  ['download', 'manual discovery config changed', { missingId: true, manualFail: true }],
  ['upload', 'discovery throws safely', { missingId: true, discoveryThrow: true }],
  ['download', 'discovery throws safely', { missingId: true, discoveryThrow: true }],
  ['upload', 'unknown prior POST blocks confirmation', { missingId: true, discoveryResult: missing, readFirst: true }],
  ['upload', 'missing archive declined confirmation preserves pending', { missingId: true, discoveryResult: missing, approved: false }],
  ['upload', 'approved missing archive uses manual creation result', { missingId: true, discoveryResult: missing }],
  ['upload', 'unknown creation response stays pending', { missingId: true, discoveryResult: missing, createResult: { ok: false, writeUnknown: true } }],
  ['upload', 'verified ordinary push', {}],
  ['upload', 'explicit persistent opt-in and missing checkbox', { persist: true, missingCheckbox: true }],
  ['upload', 'explicit persistent opt-in', { persist: true }],
  ['upload', 'acknowledged-only push is not verified', { pushResults: [{ ok: true }] }],
  ['upload', 'pending verified push is not complete', { pushResults: [{ ok: true, remoteVerified: true, pending: true }] }],
  ['upload', 'failed push preserves pending', { pushResults: [{ ok: false }] }],
  ['upload', 'transport exception is safe and finally restores button', { pushThrow: true }],
  ['upload', 'legacy upgrade declined', { pushResults: [upgrade], approved: false }],
  ['upload', 'legacy upgrade explicitly approved', { pushResults: [upgrade, { ok: true, remoteVerified: true }] }],
  ['upload', 'legacy upgrade unknown response', { pushResults: [upgrade, { ok: false, writeUnknown: true }] }],
  ['upload', 'render failure follows upload catch and finally', { renderThrow: true }],
  ['upload', 'toast failure follows upload catch and finally', { toastThrow: true }],
  ['upload', 'start-auto failure follows upload catch and finally', { autoThrow: true }],
  ['download', 'failed pull does not mark upload pending', { pullResult: { ok: false } }],
  ['download', 'transport exception is safe and finally restores button', { pullThrow: true }],
  ['download', 'pending result bypasses post-download count reads', { pullResult: { ok: true, remoteVerified: true, pending: true } }],
  ['download', 'acknowledged-only result bypasses post-download count reads', { pullResult: { ok: true } }],
  ['download', 'growing merge counts latest state and preserves call order', {}],
  ['download', 'unchanged count', { afterRows: 1 }],
  ['download', 'shrinking count is not presented as added rows', { afterRows: 0 }],
  ['download', 'toast failure follows download catch without upload pending', { toastThrow: true }],
  ['download', 'start-auto failure follows download catch without upload pending', { autoThrow: true }],
];

// The original literal/SHA stays frozen. This safety fix adds exactly one
// observable local read after the old readFirst check, only for these cases.
const intentReadDeltaCases = new Set([
  'missing archive declined confirmation preserves pending',
  'approved missing archive uses manual creation result',
  'unknown creation response stays pending',
]);
function addApprovedIntentRead(expected, name) {
  if (!intentReadDeltaCases.has(name)) return expected;
  const position = expected.trace.indexOf('sync-status');
  assert.ok(position >= 0);
  assert.equal(expected.trace.lastIndexOf('sync-status'), position);
  expected.trace.splice(position + 1, 0, 'create-intent-read');
  return expected;
}

test('characterization oracle is the independently frozen original action source', () => {
  assert.equal(createHash('sha256').update(FROZEN_ACTIONS).digest('hex'), ORIGINAL_ACTIONS_SHA256);
});
for (const [direction, name, options] of cases) {
  test('shared cloud action preserves original ' + direction + ': ' + name, async () => {
    const expected = addApprovedIntentRead(await observe(originalFactory, direction, options), name);
    const actual = await observe(candidateFactory, direction, options);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual.trace).includes('synthetic-private-error'), false);
  });
}
test('original-function oracle detects loss of pending and button finally safety', async () => {
  const options = { pushResults: [{ ok: false }] };
  const expected = await observe(originalFactory, 'upload', options);
  const broken = FROZEN_ACTIONS.replace('markSyncPending();', '').replace("uploadBtn.disabled = false;", '');
  const changed = await observe((context, document, confirm) => originalFactory(context, document, confirm, broken), 'upload', options);
  assert.notDeepEqual(changed, expected);
  assert.equal(changed.buttons['cloud-upload-btn'].disabled, true);
});

test('approved intent-read delta rejects an omitted read without filtering other trace events', async () => {
  const name = 'approved missing archive uses manual creation result';
  const options = { missingId: true, discoveryResult: missing };
  const expected = addApprovedIntentRead(await observe(originalFactory, 'upload', options), name);
  const missingRead = context => {
    context.cloudCreateIntentStore.read = () => ({ ok: true, intent: null });
    return createCloudArchiveFeature(context);
  };
  assert.notDeepEqual(await observe(missingRead, 'upload', options), expected);
  const actual = await observe(candidateFactory, 'upload', options);
  assert.deepEqual(actual, expected);
  assert.equal(actual.trace.filter(value => value === 'create-intent-read').length, 1);
});
