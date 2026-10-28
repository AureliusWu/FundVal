import { TIMING } from "../config.js";
import { normalizeHoldingsDocumentV3 } from "./holdings-schema.js";
import { createCloudCreateIntentStore } from "./cloud-create-intent.js";
import { backupCloudSyncSnapshot, backupRepositoryState, loadHoldingsRepository, persistHoldingsDocument, withHoldingsLock } from "./holdings-repository.js";

// On-demand cloud UI. Repository locking, isolated shards and readback remain
// authoritative; credentials and operation lifetimes are injected by the app.
export function createCloudArchiveFeature(context) {
  const { CACHE_KEY, getHoldingsDocument, getHoldings, loadCloudSyncFeature, loadGistRemoteModule,
    nowISO, fetchWithTimeout, setGistId, createGistRemoteAdapter, loadSyncMeta, saveSyncMeta, setSyncTime,
    setSyncPending, installHoldingsDocument, setGistToken, clearGistCredentials, getGistId, pushToCloud, pullFromCloud,
    markSyncPending, renderCloudStatus, showToast, startAutoPull, resolveGistId, listCloudArchives,
    setArchiveCandidates, runManualOperation, getSyncStatus, captureCloudConfigurationScope } = context;
  const buttonOwners = new WeakMap();
  const createIntent = context.cloudCreateIntentStore || createCloudCreateIntentStore();
// ── 首次创建 Gist（手动触发） ──────────────────────────────
async function createCloudArchive(token, options = {}) {
  const scope = options.scope || { isCurrent: () => true };
  const changed = () => ({ ok: false, reason: 'cloud_configuration_changed' });
  if (!scope.isCurrent()) return changed();
  const holdingsDocument = getHoldingsDocument();
  if (!holdingsDocument) return { ok: false, reason: 'local_read_failed' };
  if (options.targetSchema !== 3) {
    return { ok: false, reason: 'remote_schema_upgrade_required', writeSchema: 2 };
  }
  const targetSchema = 3;
  const uploadDocument = normalizeHoldingsDocumentV3(holdingsDocument);
  const {
    canonicalCloudPayload,
    finalizeCreatedArchiveState,
    makeCloudWritePayload,
  } = await loadCloudSyncFeature();
  if (!scope.isCurrent()) return changed();
  const gistRuntime = await loadGistRemoteModule();
  if (!scope.isCurrent()) return changed();
  const targetFilename = gistRuntime.v3GistFilename(uploadDocument.deviceId);
  const payload = makeCloudWritePayload(uploadDocument, targetSchema);
  const backup = await withHoldingsLock(() => {
    if (!scope.isCurrent()) return changed();
    if (!backupRepositoryState(undefined, { now: Date.now() })) return { ok: false, reason: 'local_backup_failed' };
    const saved = backupCloudSyncSnapshot(undefined, {
      phase: 'cloud-create', localDocument: uploadDocument, remoteAbsent: true,
    }, { now: Date.now() });
    if (!saved.ok) return saved;
    return createIntent.prepare();
  });
  if (!backup.ok) return backup;
  if (!scope.isCurrent()) return changed();
  let response;
  try { response = await fetchWithTimeout('https://api.github.com/gists', {
    method: 'POST',
    redirect: 'error',
    signal: scope.signal,
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      description: 'FundVal 持仓数据 | ' + nowISO(),
      public: false,
      files: { [targetFilename]: { content: JSON.stringify(payload, null, 2) } }
    })
  }, TIMING.CLOUD_SYNC_TIMEOUT); }
  catch (_) { return { ok: false, reason: 'remote_create_failed', writeUnknown: true,
    failure: { code: 'network', status: null, retryable: true, retryAfterMs: 0 } }; }
  if (!scope.isCurrent()) return changed();
  if (!response.ok) {
    const result = { ok: false, reason: 'remote_create_http_' + response.status,
      failure: gistRuntime.classifyGistHttpFailure(response, { phase: 'create' }),
      writeUnknown: !Number.isInteger(response.status) || response.status >= 500 };
    // Only these definite server rejections prove this POST did not create.
    // Unknown outcomes survive reload, cancellation and configuration resets.
    if ([400, 401, 403, 404, 422].includes(response.status)) {
      const cleared = await withHoldingsLock(() => scope.isCurrent()
        ? createIntent.clear(backup.intent.nonce) : changed());
      if (!scope.isCurrent()) return changed();
      if (!cleared.ok) result.intentPending = true;
    }
    return result;
  }
  let created;
  try { created = await response.json(); }
  catch (_) { return { ok: false, reason: 'remote_create_id_missing', patched: true, writeUnknown: true }; }
  if (!scope.isCurrent()) return changed();
  const gistId = String(created?.id || '').trim();
  if (!/^[a-f0-9]{1,64}$/i.test(gistId)) return { ok: false, reason: 'remote_create_id_missing', patched: true, writeUnknown: true };
  // Keep the id even when verification is inconclusive so the created archive
  // remains discoverable and the next retry performs a normal guarded sync.
  const adopted = scope.adoptGistId ? scope.adoptGistId(gistId) : setGistId(gistId);
  if (!adopted) return { ok: false, reason: 'cloud_archive_id_write_failed', patched: true, writeUnknown: true };
  const remote = await createGistRemoteAdapter(token, gistId, { deviceId: uploadDocument.deviceId, ...scope });
  if (!scope.isCurrent()) return changed();
  const readback = await remote.get({ phase: 'create-readback' });
  if (!scope.isCurrent()) return changed();
  if (!readback.ok) return { ok: false, reason: readback.reason, failure: readback.failure, patched: true };
  if (readback.requiresPatch) return { ok: false, reason: 'remote_target_readback_mismatch', patched: true };
  try {
    if (canonicalCloudPayload(readback.raw, targetSchema) !== canonicalCloudPayload(payload, targetSchema)) {
      return { ok: false, reason: 'remote_readback_mismatch', patched: true };
    }
  } catch (_) { return { ok: false, reason: 'remote_readback_invalid', patched: true }; }
  return withHoldingsLock(() => {
    if (!scope.isCurrent()) return changed();
    const currentLoaded = loadHoldingsRepository(undefined, { cacheKey: CACHE_KEY });
    if (!currentLoaded.ok || !currentLoaded.document) {
      return { ok: false, reason: currentLoaded.reason || 'local_read_failed', patched: true, remoteVerified: true };
    }
    const syncedAt = nowISO();
    const finalized = finalizeCreatedArchiveState(
      uploadDocument, currentLoaded.document, loadSyncMeta(),
      { remoteSchema: targetSchema, syncedAt }
    );
    if (!saveSyncMeta(finalized.meta) || !setSyncTime(syncedAt)) {
      setSyncPending(true);
      return { ok: false, reason: 'sync_meta_write_failed', patched: true, remoteVerified: true };
    }
    setSyncPending(finalized.pending);
    installHoldingsDocument(currentLoaded.document);
    if (!scope.isCurrent()) return changed();
    if (!createIntent.clear(backup.intent.nonce).ok) {
      setSyncPending(true);
      return { ok: false, reason: 'cloud_create_intent_clear_failed', patched: true, remoteVerified: true, pending: true };
    }
    return { ok: true, gistId, remoteVerified: true, pending: finalized.pending };
  });
}

async function prepareCredentials() {
  const token = document.getElementById('gist-token').value.trim();
  if (!token) { showToast('请输入 GitHub Token'); return null; }
  const saved = await setGistToken(token, { persist: document.getElementById('gist-remember-token')?.checked === true });
  if (saved === false || saved?.ok === false) {
    showToast('凭证保存或旧凭证清除失败，请检查浏览器存储后重试'); return null;
  }
  return token;
}

async function discoverForSync(token) {
  if (getGistId()) return { ok: true, gistId: getGistId() };
  return runManualOperation(async () => {
    const found = await resolveGistId(token);
    return typeof found === 'string' && found
      ? { ok: true, pending: true, gistId: found }
      : found || { ok: false, reason: 'remote_archive_missing' };
  });
}

async function refreshCloudArchives() {
  const token = await prepareCredentials();
  if (!token) return;
  const scope = captureCloudConfigurationScope?.(token);
  if (!scope?.isCurrent()) return;
  const result = await runManualOperation(async scope => {
    const listed = await listCloudArchives(token);
    if (!scope.isCurrent()) return { ok: false, reason: 'cloud_configuration_changed' };
    if (!listed.ok || !listed.complete) return { ...listed, ok: false, reason: listed.reason || 'remote_discovery_incomplete' };
    setArchiveCandidates(listed.candidates);
    return { ok: true, pending: true };
  });
  if (!scope.isCurrent()) return;
  if (result?.ok) showToast('档案列表已更新，请选择需要同步的档案');
}

async function runCloudAction(upload) {
  const holdingsDocument = upload ? getHoldingsDocument() : null;
  const token = await prepareCredentials();
  if (!token) return;
  const scope = captureCloudConfigurationScope?.(token);
  if (!scope?.isCurrent()) return;
  if (upload && (!holdingsDocument || !holdingsDocument.holdings.length)) { showToast('没有持仓数据可上传'); return; }

  const button = document.getElementById(upload ? 'cloud-upload-btn' : 'cloud-download-btn');
  const owner = {};
  buttonOwners.set(button, owner);
  button.textContent = upload ? '上传中...' : '下载中...';
  button.disabled = true;

  try {
    const discovered = await discoverForSync(token);
    if (!scope.isCurrent()) return;
    const gistId = upload ? discovered?.gistId : null;
    if (!discovered?.ok && (!upload || discovered?.reason !== 'remote_archive_missing')) return;
    if (upload) {
      let result;
      if (!gistId && (getSyncStatus?.().readFirst || (() => {
        const barrier = createIntent.read();
        return !barrier.ok || barrier.intent !== null;
      })())) {
        showToast('上次创建结果尚未确认，已阻止重复创建。请稍后刷新档案列表并明确选择。'); return;
      }
      if (gistId) result = await pushToCloud(false);
      else result = { ok: false, reason: 'remote_schema_upgrade_required' };
      if (!scope.isCurrent()) return;
      if (!result?.ok && result?.reason === 'remote_schema_upgrade_required') {
        const approved = confirm(
          '为保护删除记录和多设备冲突，需要创建独立的 Schema 3 云端存档。' +
          '旧版文件会保留，v14 或更早版本的写入不会覆盖新格式；旧版新增变更会在新版下次同步时安全合并。是否继续？'
        );
        if (approved) {
          result = gistId
            ? await pushToCloud(false, { upgradeSchema: true })
            : await runManualOperation(scope => createCloudArchive(token, { targetSchema: 3, scope }));
        }
      }
      if (!scope.isCurrent()) return;
      if (!result?.ok) {
        markSyncPending();
        return;
      }
      renderCloudStatus();
      showToast(result.remoteVerified === true && !result.pending ? '已上传并通过云端读回校验' : '变更已保留，仍有内容待同步或待核验');
    } else {
      var before = getHoldings().length;
      const result = await pullFromCloud(false);
      if (!scope.isCurrent()) return;
      if (!result?.ok) return;
      if (result.remoteVerified !== true || result.pending) {
        showToast('下载已处理，仍有内容待同步或待核验');
      } else if (getHoldings().length > before) {
        showToast('已合并，新增 ' + (getHoldings().length - before) + ' 条，共 ' + getHoldings().length + ' 条');
      } else {
        showToast('已完成云端校验，共 ' + getHoldings().length + ' 条');
      }
    }
    startAutoPull();
  } catch (_) {
    if (!scope.isCurrent()) return;
    if (upload) markSyncPending();
    showToast(upload ? '云同步未完成，变更已保留，请检查网络后重试' : '下载未完成，请检查网络后重试；本地持仓不会删除');
  } finally {
    // This is cleanup of the control still owned by this call, not permission
    // to mutate the new cloud configuration. A newer action/DOM owns its UI.
    if (buttonOwners.get(button) === owner) {
      buttonOwners.delete(button);
      if (button.isConnected !== false) {
        button.textContent = upload ? '上传到云端' : '从云端下载';
        button.disabled = false;
      }
    }
  }
}

function uploadToCloud() { return runCloudAction(true); }
function downloadFromCloud() { return runCloudAction(false); }

async function clearCloudConfig() {
  if (!confirm('清除云端同步配置？（不会删除云端 Gist 数据）')) return;
  const cleared = await clearGistCredentials();
  if (cleared?.current !== true) return;
  showToast(cleared.ok ? '已清除云端配置（未删除云端档案）' : '部分凭证未能清除；当前页面已停用，但刷新或重开可能恢复旧凭证。请清除此网站的浏览器存储。');
}
function createCloudLocalAdapter(gistId, options = {}) {
  const isCurrent = options.isCurrent || (() => true);
  const changed = () => ({ ok: false, reason: 'cloud_configuration_changed' });
  let expectedDocument = null;
  return {
    async load() {
      const loaded = await withHoldingsLock(() => isCurrent() ? loadHoldingsRepository(undefined, { cacheKey: CACHE_KEY }) : changed());
      if (!isCurrent()) return changed();
      if (!loaded.ok) return loaded;
      expectedDocument = loaded.document;
      installHoldingsDocument(loaded.document);
      return loaded;
    },
    async backup(snapshot) {
      return withHoldingsLock(() => {
        if (!isCurrent()) return changed();
        if (!backupRepositoryState(undefined, { now: Date.now() })) return { ok: false, reason: 'local_backup_failed' };
        return backupCloudSyncSnapshot(undefined, { ...snapshot, gistId }, { now: Date.now() });
      });
    },
    async persist(document) {
      const saved = await withHoldingsLock(() => isCurrent() ? persistHoldingsDocument(undefined, document, {
        cacheKey: CACHE_KEY,
        expectedDocument,
      }) : changed());
      if (!isCurrent()) return changed();
      if (saved.ok) {
        expectedDocument = saved.document;
        installHoldingsDocument(saved.document);
      }
      return saved;
    },
    async markPending(pending, details) {
      if (!isCurrent()) return changed();
      const { finalizeCloudSyncMetadata } = await loadCloudSyncFeature();
      return withHoldingsLock(() => {
        if (!isCurrent()) return changed();
        const loaded = loadHoldingsRepository(undefined, { cacheKey: CACHE_KEY });
        if (!loaded.ok) return loaded;
        const final = finalizeCloudSyncMetadata(loaded.document, loadSyncMeta(), {
          ...details, pending, syncedAt: nowISO(),
          remoteSchema: details.remoteSchema || details.writeSchema,
        });
        if (!saveSyncMeta(final.meta)) {
          setSyncPending(true);
          return { ok: false, reason: 'sync_meta_write_failed' };
        }
        setSyncPending(final.pending);
        installHoldingsDocument(loaded.document);
        return { ok: true, pending: final.pending, document: loaded.document };
      });
    }
  };
}
  return { createCloudArchive, uploadToCloud, downloadFromCloud, clearCloudConfig, createCloudLocalAdapter, refreshCloudArchives };
}
