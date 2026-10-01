import { TIMING } from "../config.js";
import { normalizeHoldingsDocumentV3 } from "./holdings-schema.js";
import { backupCloudSyncSnapshot, backupRepositoryState, loadHoldingsRepository, persistHoldingsDocument, withHoldingsLock } from "./holdings-repository.js";

// On-demand manual cloud actions only. Repository locking and readback policy
// stay identical; v16 sync-state/credential changes belong to M4.
export function createCloudArchiveFeature(context) {
  const { CACHE_KEY, getHoldingsDocument, getHoldings, loadCloudSyncFeature, loadGistRemoteModule,
    GIST_TOKEN_KEY, GIST_ID_KEY, GIST_SYNC_TIME_KEY, SYNC_META_KEY, safeRemoveItem, resetCloudState,
    nowISO, fetchWithTimeout, setGistId, createGistRemoteAdapter, loadSyncMeta, saveSyncMeta, setSyncTime,
    setSyncPending, installHoldingsDocument, setGistToken, getGistId, pushToCloud, pullFromCloud,
    markSyncPending, handleCloudFailure, renderCloudStatus, showToast, startAutoPull, findExistingGist } = context;
// ── 首次创建 Gist（手动触发） ──────────────────────────────
async function createCloudArchive(token, options = {}) {
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
  const gistRuntime = await loadGistRemoteModule();
  const targetFilename = gistRuntime.v3GistFilename(uploadDocument.deviceId);
  const payload = makeCloudWritePayload(uploadDocument, targetSchema);
  const backup = await withHoldingsLock(() => {
    if (!backupRepositoryState(undefined, { now: Date.now() })) return { ok: false, reason: 'local_backup_failed' };
    return backupCloudSyncSnapshot(undefined, {
      phase: 'cloud-create', localDocument: uploadDocument, remoteAbsent: true,
    }, { now: Date.now() });
  });
  if (!backup.ok) return backup;
  const response = await fetchWithTimeout('https://api.github.com/gists', {
    method: 'POST',
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
  }, TIMING.CLOUD_SYNC_TIMEOUT);
  if (!response.ok) return { ok: false, reason: 'remote_create_http_' + response.status };
  const created = await response.json();
  const gistId = String(created?.id || '').trim();
  if (!gistId) return { ok: false, reason: 'remote_create_id_missing', patched: true };
  // Keep the id even when verification is inconclusive so the created archive
  // remains discoverable and the next retry performs a normal guarded sync.
  setGistId(gistId);
  const remote = await createGistRemoteAdapter(token, gistId, { deviceId: uploadDocument.deviceId });
  const readback = await remote.get({ phase: 'create-readback' });
  if (!readback.ok) return { ok: false, reason: readback.reason, patched: true };
  if (readback.requiresPatch) {
    return { ok: false, reason: 'remote_target_readback_mismatch', patched: true };
  }
  try {
    if (canonicalCloudPayload(readback.raw, targetSchema) !== canonicalCloudPayload(payload, targetSchema)) {
      return { ok: false, reason: 'remote_readback_mismatch', patched: true };
    }
  } catch (_) {
    return { ok: false, reason: 'remote_readback_invalid', patched: true };
  }
  return withHoldingsLock(() => {
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
    return { ok: true, gistId, remoteVerified: true, pending: finalized.pending };
  });
}

async function uploadToCloud() {
  const holdingsDocument = getHoldingsDocument();
  var token = document.getElementById('gist-token').value.trim();
  if (!token) { showToast('请输入 GitHub Token'); return; }
  if (!holdingsDocument || !holdingsDocument.holdings.length) { showToast('没有持仓数据可上传'); return; }
  setGistToken(token);

  var uploadBtn = document.getElementById('cloud-upload-btn');
  uploadBtn.textContent = '上传中...';
  uploadBtn.disabled = true;

  var gistId = getGistId();

  try {
    let result = gistId ? await pushToCloud(false) : await createCloudArchive(token);
    if (!result?.ok && result.reason === 'remote_schema_upgrade_required') {
      const approved = confirm(
        '为保护删除记录和多设备冲突，需要创建独立的 Schema 3 云端存档。' +
        '旧版文件会保留，v14 或更早版本的写入不会覆盖新格式；旧版新增变更会在新版下次同步时安全合并。是否继续？'
      );
      if (approved) {
        result = gistId
          ? await pushToCloud(false, { upgradeSchema: true })
          : await createCloudArchive(token, { targetSchema: 3 });
      }
    }
    if (!result?.ok) {
      markSyncPending();
      handleCloudFailure(result, false);
      return;
    }
    renderCloudStatus();
    showToast('已上传并通过云端读回校验');
    startAutoPull();
  } catch (e) {
    if (e.name === 'AbortError') {
      showToast('请求超时，api.github.com 可能被墙，需科学上网');
    } else {
      showToast('网络错误: ' + (e.message || '连接失败，检查网络'));
    }
  } finally {
    uploadBtn.textContent = '上传到云端';
    uploadBtn.disabled = false;
  }
}

// ── 手动从云端下载（完整覆盖 + 合并） ─────────────────────
async function downloadFromCloud() {
  var token = document.getElementById('gist-token').value.trim();
  if (!token) { showToast('请输入 GitHub Token'); return; }
  setGistToken(token);

  var gistId = getGistId();
  if (!gistId) {
    // 没有本地记录，尝试搜索已有云端存档
    showToast('正在搜索云端存档...');
    gistId = await findExistingGist(token);
    if (!gistId) { showToast('未找到云端存档，请先在另一台设备上传'); return; }
    setGistId(gistId);
  }

  var downloadBtn = document.getElementById('cloud-download-btn');
  downloadBtn.textContent = '下载中...';
  downloadBtn.disabled = true;

  try {
    var before = getHoldings().length;
    const result = await pullFromCloud(false);
    if (!result?.ok) return;
    if (getHoldings().length > before) {
      showToast('已合并，新增 ' + (getHoldings().length - before) + ' 条，共 ' + getHoldings().length + ' 条');
    } else {
      showToast('已完成云端校验，共 ' + getHoldings().length + ' 条');
    }
    startAutoPull();
  } catch (e) {
    if (e.name === 'AbortError') {
      showToast('请求超时，api.github.com 可能被墙，需科学上网');
    } else {
      showToast('下载失败: ' + (e.message || '连接失败，检查网络'));
    }
  } finally {
    downloadBtn.textContent = '从云端下载';
    downloadBtn.disabled = false;
  }
}


function clearCloudConfig() {
  if (!confirm('清除云端同步配置？（不会删除云端 Gist 数据）')) return;
  safeRemoveItem(GIST_TOKEN_KEY);
  safeRemoveItem(GIST_ID_KEY);
  safeRemoveItem(GIST_SYNC_TIME_KEY);
  safeRemoveItem(SYNC_META_KEY);
  document.getElementById('gist-token').value = '';
  resetCloudState();
  renderCloudStatus();
  showToast('已清除云端配置');
}
function createCloudLocalAdapter(gistId) {
  let expectedDocument = null;
  return {
    async load() {
      const loaded = await withHoldingsLock(() => loadHoldingsRepository(undefined, { cacheKey: CACHE_KEY }));
      if (!loaded.ok) return loaded;
      expectedDocument = loaded.document;
      installHoldingsDocument(loaded.document);
      return loaded;
    },
    async backup(snapshot) {
      return withHoldingsLock(() => {
        if (!backupRepositoryState(undefined, { now: Date.now() })) return { ok: false, reason: 'local_backup_failed' };
        return backupCloudSyncSnapshot(undefined, { ...snapshot, gistId }, { now: Date.now() });
      });
    },
    async persist(document) {
      const saved = await withHoldingsLock(() => persistHoldingsDocument(undefined, document, {
        cacheKey: CACHE_KEY,
        expectedDocument,
      }));
      if (saved.ok) {
        expectedDocument = saved.document;
        installHoldingsDocument(saved.document);
      }
      return saved;
    },
    async markPending(pending, details) {
      const { finalizeCloudSyncMetadata } = await loadCloudSyncFeature();
      return withHoldingsLock(() => {
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
  return { createCloudArchive, uploadToCloud, downloadFromCloud, clearCloudConfig, createCloudLocalAdapter };
}
