// Existing App sync-state/UI orchestration, not a new cloud protocol.
// All clients are injected lazy callbacks; constructing this controller performs no IO.
export function createSyncStatus(context) {
  const {
    TIMING, document, isUpdateApplying, getHoldingsDocument,
    getGistToken, getGistId, setGistId, getSyncTime, setSyncTime,
    loadSyncMeta, markSyncPending, loadCloudSyncFeature, findExistingGist,
    createGistRemoteAdapter, createCloudLocalAdapter, reloadHoldingsAfterCloud,
    renderHoldingsList, refresh, showToast, nowISO,
    setTimeout, clearTimeout, setInterval, clearInterval,
  } = context;
  let syncPending = false;
  let syncDebounceTimer = null;
  let autoPullTimer = null;
  let isSyncing = false;

  function hasCloudConfig() {
    return !!(getGistToken());  // 有 Token 即可，Gist ID 可自动发现
  }
  
  function renderCloudStatus() {
    var el = document.getElementById('cloud-status');
    if (!el) return;
    var syncTime = getSyncTime();
    if (syncTime) {
      var d = new Date(syncTime);
      el.textContent = '上次同步: ' + d.toLocaleString('zh-CN');
      el.style.color = 'var(--up)';
    } else {
      el.textContent = '配置 Token 后自动同步';
      el.style.color = 'var(--muted)';
    }
  }
  
  function handleCloudFailure(result, silent) {
    const reason = String(result?.reason || 'cloud_sync_failed');
    if (reason.includes('404')) {
      setGistId('');
      renderCloudStatus();
    }
    if (silent) return;
    if (reason.includes('401')) showToast('Token 无效，请检查');
    else if (reason === 'remote_schema_future') showToast('云端数据版本更高，已进入只读保护，未写入');
    else if (reason === 'remote_schema_upgrade_required') {
      showToast('当前变更需要创建隔离的 Schema 3 云端存档；旧版文件会保留且不能覆盖新格式。请手动上传并确认升级。');
    }
    else if (reason.includes('invalid') || reason.includes('missing') || reason.includes('truncated')) {
      showToast('云端持仓校验失败，已停止同步以保护数据');
    } else if (result?.patched && !result?.remoteVerified) {
      showToast('云端已响应但读回验证失败，状态待确认');
    } else {
      showToast('同步失败，变更已保留待重试');
    }
  }
  
  function hasPendingSync() {
    const meta = loadSyncMeta();
    return meta.pending === true || Boolean(meta.pending_hash && meta.pending_hash !== meta.last_push_hash);
  }
  
  async function resolveGistId(token) {
    let gistId = getGistId();
    if (gistId) return gistId;
    const found = await findExistingGist(token);
    if (!found) return '';
    setGistId(found);
    return found;
  }
  
  async function pullFromCloud(silent) {
    if (isUpdateApplying()) return { ok: false, reason: 'service_worker_update_pending' };
    if (isSyncing) return;
    const token = getGistToken();
    if (!token) return;
  
    isSyncing = true;
    try {
      const { pullHoldingsCloud } = await loadCloudSyncFeature();
      const gistId = await resolveGistId(token);
      if (!gistId) return;
      const result = await pullHoldingsCloud({
        remote: await createGistRemoteAdapter(token, gistId),
        local: await createCloudLocalAdapter(gistId),
        deviceId: getHoldingsDocument()?.deviceId,
      });
      if (!result.ok) {
        handleCloudFailure(result, silent);
        return result;
      }
      const reloaded = await reloadHoldingsAfterCloud();
      if (!reloaded.ok) {
        const failure = { ...result, ok: false, reason: reloaded.reason };
        handleCloudFailure(failure, silent);
        return failure;
      }
      setSyncTime(nowISO());
      if (result.changed) {
        renderHoldingsList();
        renderCloudStatus();
        refresh();
      }
      if (result.pending || hasPendingSync()) scheduleAutoPush();
      return result;
    } catch(e) {
      if (!silent) showToast('同步失败，变更已保留待重试');
      return { ok: false, reason: e?.message || 'cloud_pull_failed' };
    } finally {
      isSyncing = false;
    }
  }
  
  async function pushToCloud(silent, options = {}) {
    if (isUpdateApplying()) return { ok: false, reason: 'service_worker_update_pending' };
    if (isSyncing) return;
    const token = getGistToken();
    if (!token) return;
  
    isSyncing = true;
    try {
      const { synchronizeHoldingsCloud } = await loadCloudSyncFeature();
      const gistId = await resolveGistId(token);
      if (!gistId) return;
      const result = await synchronizeHoldingsCloud({
        remote: await createGistRemoteAdapter(token, gistId),
        local: await createCloudLocalAdapter(gistId),
        deviceId: getHoldingsDocument()?.deviceId,
        upgradeSchema: options.upgradeSchema === true,
      });
      if (!result.ok) {
        markSyncPending();
        handleCloudFailure(result, silent);
        return result;
      }
      const reloaded = await reloadHoldingsAfterCloud();
      if (!reloaded.ok) {
        const failure = { ...result, ok: false, reason: reloaded.reason };
        handleCloudFailure(failure, silent);
        return failure;
      }
      setSyncTime(nowISO());
      renderCloudStatus();
      if (result.pending || hasPendingSync()) scheduleAutoPush();
      return result;
    } catch(e) {
      // 保留持久化待同步标记，以便网络恢复或下次启动后补推。
      markSyncPending();
      return { ok: false, reason: e?.message || 'cloud_push_failed' };
    } finally {
      isSyncing = false;
    }
  }
  
  function scheduleAutoPush() {
    if (!hasCloudConfig()) return;
    markSyncPending();
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(function() {
      pushToCloud(true);
    }, TIMING.AUTO_PUSH_DELAY);
  }
  
  function startAutoPull() {
    if (autoPullTimer) clearInterval(autoPullTimer);
    autoPullTimer = setInterval(function() {
      pullFromCloud(true);
      if (hasPendingSync()) scheduleAutoPush();
    }, TIMING.AUTO_PULL_INTERVAL);
  }
  
  async function autoPullOnLoad() {
    if (!hasCloudConfig()) return;
    await pullFromCloud(true);
    if (hasPendingSync()) scheduleAutoPush();
  }

  // Manual clear historically clears timers/pending, not the active network operation.
  function resetCloudState() {
    syncPending = false;
    if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
    if (autoPullTimer) { clearInterval(autoPullTimer); autoPullTimer = null; }
  }
  function setSyncPending(value) { syncPending = value; }

  return {
    hasCloudConfig, renderCloudStatus, handleCloudFailure, hasPendingSync,
    resolveGistId, pullFromCloud, pushToCloud, scheduleAutoPush, startAutoPull, autoPullOnLoad,
    resetCloudState, setSyncPending,
    isSyncing: () => isSyncing,
    isPending: () => syncPending,
  };
}

