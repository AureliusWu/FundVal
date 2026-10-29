import { syncOutcome, syncRetry } from './sync-policy.js';

// Lazy clients remain injected. Construction performs no storage, DOM or network IO.
export function createSyncStatus(context) {
  const {
    TIMING, document, isUpdateApplying, getHoldingsDocument,
    getGistToken, getGistId, setGistId, setSyncTime,
    loadSyncMeta, markSyncPending, loadCloudSyncFeature,
    createGistRemoteAdapter, createCloudLocalAdapter, reloadHoldingsAfterCloud,
    renderHoldingsList, refresh, showToast, nowISO,
    setTimeout, clearTimeout, setInterval, clearInterval,
    now = Date.now, random = Math.random,
  } = context;
  let syncPending = false, syncDebounceTimer = null, autoPullTimer = null;
  let isSyncing = false, configEpoch = 0, activeOperation = null, disposed = false;
  let state = 'local-only', code = 'local_only', retryAttempt = 0, retryAt = null;
  let autoStopped = false, readFirst = false;
  const recorded = new WeakSet();
  const validId = value => typeof value === 'string' && /^[a-f\d]{1,64}$/i.test(value);
  const cancelled = () => ({ ok: false, reason: 'cloud_config_changed' });
  const labels = {
    'local-only': '仅保存在本机；配置会话凭证后可同步',
    pending: '变更待同步或远端读回验证待确认', syncing: '正在同步，请稍候',
    verified: '远端读回验证一致', readonly: '云端版本更高；只读保护，未写入',
    conflict: '同步冲突；请检查后手动重试', failed: '同步失败；本地变更已保留',
  };
  const reasons = {
    auth: '凭证无效，请重新配置', permission: '缺少访问权限，请检查凭证',
    missing: '档案不存在或无权访问；请核对所选档案',
    rate_limit: '请求受限，请等待重试时间', unavailable: '远端暂不可用，等待退避重试',
    network: '网络失败，等待退避重试', validation: '数据校验失败，已停止自动同步',
    invalid_response: '远端响应无效，已停止自动同步', invalid_request: '同步请求无效，已停止自动同步',
    upgrade_required: '需要手动确认创建隔离的新版档案',
    archive_selection_required: '发现多个兼容档案，请明确选择',
    remote_discovery_incomplete: '档案列表不完整，不能自动选择',
    remote_archive_missing: '没有兼容档案，请手动确认创建',
  };

  function hasCloudConfig() { return !disposed && Boolean(getGistToken()); }
  function captureConfigurationScope(token = getGistToken()) {
    const epoch = configEpoch;
    return Object.freeze({ isCurrent: () => !disposed && configEpoch === epoch && getGistToken() === token });
  }
  function hasPendingSync() {
    const meta = loadSyncMeta();
    return meta.pending === true || Boolean(meta.pending_hash && meta.pending_hash !== meta.last_push_hash);
  }
  function getStatus() {
    const id = getGistId();
    return { state, code, gistId: validId(id) ? id : '', retryAt, retryAttempt, readFirst, busy: isSyncing };
  }
  function renderCloudStatus() {
    const element = document.getElementById('cloud-status');
    if (!element) return;
    const status = getStatus();
    element.textContent = labels[state] + (reasons[code] ? '；' + reasons[code] : '')
      + (retryAt !== null ? ' · 可重试时间 ' + new Date(retryAt).toLocaleTimeString('zh-CN') : '')
      + (status.gistId ? ' · 档案 ' + status.gistId : '');
    element.style.color = state === 'verified' ? 'var(--up)' : 'var(--muted)';
  }
  function clearPushTimer() {
    if (syncDebounceTimer !== null) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
  function markPending() {
    syncPending = true;
    // A persistence callback failure must not recurse or erase the in-memory pending flag.
    try { markSyncPending(); } catch (_) { /* Retry still requires explicit verified readback. */ }
  }
  function makeOperation(token) {
    const epoch = configEpoch, controller = new AbortController();
    const operation = { token, id: getGistId(), controller, closed: false };
    const sameConfiguration = () => !operation.closed && !disposed && configEpoch === epoch && !controller.signal.aborted && getGistToken() === token;
    const isCurrent = () => sameConfiguration() && getGistId() === operation.id;
    operation.scope = Object.freeze({
      isCurrent,
      signal: controller.signal,
      adoptGistId(id) {
        if (operation.id || !validId(id) || !isCurrent()) return false;
        let saved;
        try { saved = setGistId(id); } catch (_) { return false; }
        if (saved === false || !sameConfiguration() || getGistId() !== id) return false;
        operation.id = id;
        return true;
      },
    });
    return operation;
  }
  function queue(delay, direction) {
    clearPushTimer();
    const epoch = configEpoch;
    const timer = setTimeout(async () => {
      if (syncDebounceTimer !== timer) return;
      syncDebounceTimer = null;
      if (disposed || epoch !== configEpoch || autoStopped) return;
      await run(direction, true, {}, true);
    }, delay);
    syncDebounceTimer = timer;
  }
  function recordResult(result, silent, direction = 'pull') {
    if (disposed || activeOperation && !activeOperation.scope.isCurrent()) return result;
    if (result && typeof result === 'object') {
      if (recorded.has(result)) return result;
      recorded.add(result);
    }
    let pending;
    try { pending = result?.pending === true || hasPendingSync(); }
    catch (_) { result = { ok: false, reason: 'local_snapshot_unstable' }; pending = true; }
    const outcome = syncOutcome(result, pending);
    state = outcome.state; code = outcome.code;
    readFirst = readFirst || outcome.readFirst || result?.remoteVerified !== true
      && (result?.writeUnknown === true || result?.patched === true || result?.patchAcknowledged === true);
    clearPushTimer();
    if (result?.ok === true) {
      syncPending = pending;
      retryAt = null; retryAttempt = 0; autoStopped = false;
      if (result.remoteVerified === true) readFirst = false;
      if (state === 'verified') setSyncTime(nowISO());
      if (pending && !readFirst && result.remoteVerified === true) queue(TIMING.AUTO_PUSH_DELAY, 'push');
    } else {
      if (direction === 'push' || outcome.readFirst) markPending();
      if (['archive_selection_required', 'remote_discovery_incomplete', 'remote_archive_missing'].includes(result?.reason)) code = result.reason;
      if (outcome.retryable) {
        const retry = syncRetry({ attempt: retryAttempt, now: now(), random, retryAfterMs: outcome.retryAfterMs });
        retryAt = retry.retryAt; autoStopped = retry.exhausted;
        if (!retry.exhausted) { retryAttempt++; queue(retry.delayMs, readFirst ? 'pull' : direction); }
      } else { retryAt = null; autoStopped = true; }
      if (!silent) showToast(labels[state] + (reasons[code] ? '；' + reasons[code] : ''));
    }
    renderCloudStatus();
    return result;
  }
  function handleCloudFailure(result, silent) { return recordResult(result, silent, 'push'); }
  function recordExternalResult(result) { return recordResult(result, true); }

  async function resolveGistId(token) {
    const operation = activeOperation?.token === token ? activeOperation : makeOperation(token);
    const { isCurrent } = operation.scope;
    if (!isCurrent()) return cancelled();
    if (operation.id) return operation.id;
    let discovery;
    if (typeof context.listGists === 'function') discovery = await context.listGists(token);
    else {
      // Compatibility only; the App supplies the complete explicit-candidate API.
      const found = await context.findExistingGist?.(token);
      discovery = { ok: true, complete: true, candidates: found ? [{ id: found }] : [] };
    }
    if (!isCurrent()) return cancelled();
    const candidates = Array.isArray(discovery?.candidates) ? discovery.candidates : [];
    const valid = candidates.every(candidate => validId(candidate?.id));
    const safe = valid ? candidates.map(candidate => ({ id: candidate.id,
      schema: Number.isInteger(candidate.schema) ? candidate.schema : null,
      updatedAt: typeof candidate.updatedAt === 'string' && Number.isFinite(Date.parse(candidate.updatedAt))
        ? new Date(candidate.updatedAt).toISOString() : null,
    })) : [];
    context.setArchiveCandidates?.(safe);
    if (!isCurrent()) return cancelled();
    if (discovery?.ok !== true) {
      const outcome = syncOutcome(discovery);
      const reason = typeof discovery?.reason === 'string' && /^(?:remote_http_\d{3}|remote_network|remote_discovery_incomplete)$/.test(discovery.reason)
        ? discovery.reason : 'remote_discovery_incomplete';
      return { ok: false, reason, failure: { code: outcome.code, retryAfterMs: outcome.retryAfterMs } };
    }
    if (discovery.complete !== true || !valid) return { ok: false, reason: 'remote_discovery_incomplete' };
    if (safe.length !== 1) return { ok: false, reason: safe.length ? 'archive_selection_required' : 'remote_archive_missing' };
    return operation.scope.adoptGistId(safe[0].id) ? operation.id : cancelled();
  }

  function begin(automatic) {
    if (isUpdateApplying()) return { blocked: { ok: false, reason: 'service_worker_update_pending' } };
    if (isSyncing) return { blocked: undefined };
    if (!hasCloudConfig()) return { blocked: undefined };
    if (retryAt !== null && now() < retryAt) return { blocked: { ok: false, reason: 'sync_retry_cooldown' } };
    if (automatic && autoStopped) return { blocked: undefined };
    if (!automatic && autoStopped) { autoStopped = false; retryAttempt = 0; }
    const operation = makeOperation(getGistToken());
    activeOperation = operation; isSyncing = true; state = 'syncing'; code = 'syncing';
    renderCloudStatus();
    return { operation };
  }
  async function withOperation(automatic, work, onError) {
    const started = begin(automatic);
    if (!started.operation) return started.blocked;
    const operation = started.operation, { scope } = operation;
    try { return await work(operation, scope); }
    catch (_) { return scope.isCurrent() ? onError() : cancelled(); }
    finally {
      // Invalidating a configuration never pretends its IO has settled early.
      operation.closed = true;
      if (activeOperation === operation) { activeOperation = null; isSyncing = false; }
    }
  }
  async function run(direction, silent, options, automatic = false) {
    const actualDirection = readFirst ? 'pull' : direction;
    return withOperation(automatic, async (operation, scope) => {
      const client = await loadCloudSyncFeature();
      if (!scope.isCurrent()) return cancelled();
      const gistId = await resolveGistId(operation.token);
      if (!scope.isCurrent()) return cancelled();
      if (typeof gistId !== 'string') return recordResult(gistId, silent, actualDirection);
      const remote = await createGistRemoteAdapter(operation.token, gistId, scope);
      if (!scope.isCurrent()) return cancelled();
      const local = await createCloudLocalAdapter(gistId, scope);
      if (!scope.isCurrent()) return cancelled();
      const input = { remote, local, deviceId: getHoldingsDocument()?.deviceId };
      if (actualDirection === 'push') input.upgradeSchema = options.upgradeSchema === true;
      const result = await (actualDirection === 'push' ? client.synchronizeHoldingsCloud(input) : client.pullHoldingsCloud(input));
      if (!scope.isCurrent()) return cancelled();
      if (!result?.ok) return recordResult(result, silent, actualDirection);
      const reloaded = await reloadHoldingsAfterCloud(scope);
      if (!scope.isCurrent()) return cancelled();
      if (!reloaded?.ok) return recordResult({ ...result, ok: false, reason: 'local_reload_failed' }, silent, actualDirection);
      const settled = recordResult(result, silent, actualDirection);
      if (settled?.ok !== true) return settled;
      if (actualDirection === 'pull' && result.changed) { renderHoldingsList(); refresh(); }
      return result;
    }, () => recordResult({ ok: false, reason: actualDirection === 'push' ? 'cloud_push_failed' : 'cloud_pull_failed' }, silent, actualDirection));
  }
  async function pullFromCloud(silent) { return run('pull', silent, {}); }
  async function pushToCloud(silent, options = {}) { return run('push', silent, options); }
  async function runManualOperation(callback) {
    return withOperation(false, async (_, scope) => {
      const result = await callback(scope);
      if (!scope.isCurrent()) return cancelled();
      return recordResult(result, true);
    }, () => recordResult({ ok: false, reason: 'cloud_push_failed', writeUnknown: true }, true));
  }
  function scheduleAutoPush() {
    if (!hasCloudConfig()) return;
    markPending();
    if (autoStopped || retryAt !== null && now() < retryAt) return;
    if (!isSyncing) { state = 'pending'; code = 'pending'; renderCloudStatus(); }
    queue(TIMING.AUTO_PUSH_DELAY, 'push');
  }
  function startAutoPull() {
    if (disposed) return;
    if (autoPullTimer !== null) clearInterval(autoPullTimer);
    const epoch = configEpoch;
    const timer = setInterval(async () => {
      if (autoPullTimer !== timer || disposed || epoch !== configEpoch) return;
      await run('pull', true, {}, true);
    }, TIMING.AUTO_PULL_INTERVAL);
    autoPullTimer = timer;
  }
  async function autoPullOnLoad() {
    if (hasCloudConfig()) return run('pull', true, {}, true);
  }
  function resetCloudState(options = {}) {
    const keepBackoff = options.preserveBackoff === true && code === 'rate_limit' && retryAt !== null && now() < retryAt;
    configEpoch++; activeOperation?.controller.abort();
    syncPending = false; autoStopped = false;
    if (!keepBackoff) { retryAttempt = 0; retryAt = null; state = 'local-only'; code = 'local_only'; }
    clearPushTimer();
    if (autoPullTimer !== null) clearInterval(autoPullTimer);
    autoPullTimer = null;
    // readFirst is intentionally sticky: reconfiguration must not authorize a blind replay.
  }
  function setSyncPending(value) { syncPending = value === true; }
  function dispose() { resetCloudState(); disposed = true; }

  return {
    hasCloudConfig, renderCloudStatus, handleCloudFailure, hasPendingSync,
    resolveGistId, pullFromCloud, pushToCloud, scheduleAutoPush, startAutoPull, autoPullOnLoad,
    resetCloudState, setSyncPending, getStatus, recordExternalResult, runManualOperation, captureConfigurationScope, dispose,
    isSyncing: () => isSyncing, isPending: () => syncPending,
  };
}
