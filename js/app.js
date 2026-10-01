import { APP_VERSION } from './version.js';
import { TIMING, TTL, refreshInterval } from './config.js';
import { safeGetItem, safeRemoveItem, safeSetItem } from './storage.js';
import { resolveQuoteBaseNav } from './calculator.js';
import { classifyFundMarket, refreshDelayForMarkets } from './freshness.js';
import {
  buildFundQuoteCandidates,
  legacyFreshnessFromQuote,
  normalizeCachedQuote,
  normalizeExistingQuoteFreshness,
  normalizeOfficialNavQuote,
  selectPreferredQuote,
} from './runtime/quote-normalizer.js';
import { normalizeQuoteDate, nullableNumber, parseQuoteTimestamp, quoteStatusRank } from './runtime/quote-contract.js';
import { marketClock } from './runtime/market-clock.js';
import { createValuationPeriod } from './runtime/valuation-period.js';
import { holdingQuoteAmounts } from './runtime/holding-quote-amounts.js';
import { indexQuoteStatus, normalizeGoldQuote } from './runtime/index-quote.js';
import { createQuotePresentation } from './runtime/quote-presentation.js';
import { classifyAssetKind, classifyMarketKind } from './runtime/market-session.js';
import { DATA_SOURCE_REGISTRY } from './runtime/source-registry.js';
import { RefreshCoordinator } from './runtime/refresh-coordinator.js';
import { isRefreshAbort } from './runtime/refresh-generation.js';
import { createRequestSignal, throwIfAborted } from './runtime/request-signal.js';
import { activeHoldingCodes, retainActiveFundData } from './runtime/active-holdings.js';
import {
  canonicalHoldingsDocument,
  normalizeHoldingsDocumentV3,
  toLegacyHoldings,
} from './storage/holdings-schema.js';
import {
  loadHoldingsRepository,
  withHoldingsLock,
} from './storage/holdings-repository.js';

const CACHE_KEY = 'fuyu_funds_cache_v1';
const GIST_TOKEN_KEY = 'fuyu_gist_token';
const GIST_ID_KEY = 'fuyu_gist_id';
const GIST_SYNC_TIME_KEY = 'fuyu_gist_sync_time';
const SYNC_META_KEY = 'fuyu_sync_meta_v1';
const OCR_IMPORT_PENDING_KEY = 'fuyu_ocr_import_pending_v1';
const GOLD_CACHE_KEY = 'fuyu_gold_cache_v2';
const NOTIFY_DATE_KEY = 'fuyu_notify_1430_date_v1';
// ── 缓存持久化黑名单（这些字段为瞬时 UI 状态，不写入 localStorage） ──
const SKIP_CACHE_KEYS = ['_cached', 'message', 'quoteCandidates'];
// ── 指数行情配置（腾讯 JSONP + 黄金 AU9999 独立源） ──
const INDEX_CONFIG = [
  { code: 'AU9999',   name: '黄金9999', source: 'gold' },
  { code: 'sh000001', name: '上证' },
  { code: 'sh000300', name: '沪深300' },
  { code: 'usNDX',    name: '纳指100' },
  { code: 'usINX',    name: '标普500' }
];

let indexCache = INDEX_CONFIG.map(function(cfg) {
  return { name: cfg.name, price: NaN, changePct: NaN, observedAt: null, status: 'unavailable', cached: false };
});
let holdings = [];
let holdingsDocument = null;
let holdingsStorageError = '';
let fundsData = [];
let editingCode = null;
let editingSnapshot = null;
let isSavingHolding = false;
let sortBy = 'est_change_desc';
let expandedFund = null;
const holdingsCache = {};
const holdingsMetaCache = {};
const fundHoldingsRequests = new Map();
let fundTypeCache = {};      // 基金类型/基本信息缓存
let fundFeeCache = {};       // 费率信息缓存
let loadingDetails = null;   // 当前正在加载详情的基金代码（防重入）
let quoteBridge = null;
let quoteBridgePromise = null;
let isRefreshing = false;
const refreshCoordinator = new RefreshCoordinator({
  sources: DATA_SOURCE_REGISTRY,
  execute: runRefresh,
  onStateChange: function(snapshot) { isRefreshing = Boolean(snapshot.active); },
});
let autoRefreshTimer = null;
let syncPending = false;       // 是否有待推送的本地变更
let syncDebounceTimer = null;  // 防抖定时器
let autoPullTimer = null;      // 定时拉取
let isSyncing = false;         // 是否正在同步中
let pendingServiceWorker = null;
let serviceWorkerUpdateApplying = false;
let serviceWorkerReloadPending = false;
let serviceWorkerUpdateChannel = null;
let reloadingForServiceWorkerUpdate = false;
let fundRenderFrame = null;
let overseasModelsPromise = null;
let fundHoldingsModulePromise = null;
let estimateModulePromise = null;
let modelRuntime = null;
let holdingsEstimateModulePromise = null;
let holdingsEstimateRuntime = null;
let cloudSyncModulePromise = null;
let notificationControllerPromise = null;
let quoteDiagnosticsRuntime = null;
let quoteDiagnosticsPromise = null;
let detailToggleGeneration = 0;

function loadQuoteBridgeFeature() {
  if (!quoteBridgePromise) {
    quoteBridgePromise = import('./runtime/quote-bridge-client.js').then(function(module) {
      quoteBridge = module.createQuoteBridgeClient();
      return quoteBridge;
    });
  }
  return quoteBridgePromise;
}

function loadFundHoldingsFeature() {
  if (!fundHoldingsModulePromise) fundHoldingsModulePromise = import('./fund-holdings.js').catch(error => { fundHoldingsModulePromise = null; throw error; });
  return fundHoldingsModulePromise;
}

async function fetchEstimateRows(...args) {
  if (!estimateModulePromise) estimateModulePromise = import('./eastmoney-estimate.js').catch(error => { estimateModulePromise = null; throw error; });
  return (await estimateModulePromise).fetchEstimateRows(...args);
}


async function loadOverseasModels() {
  modelRuntime = await import('./runtime/fund-model-enrichment.js');
  return modelRuntime.loadOverseasModels();
}
function getOverseasConfig() { return modelRuntime?.getOverseasConfig() || { models: {}, rules: {} }; }
function selectOverseasModel(...args) { return modelRuntime?.selectOverseasModel(...args) || null; }

function loadHoldingsEstimateFeature() {
  if (!holdingsEstimateModulePromise) holdingsEstimateModulePromise = import('./holdings-estimate.js').then(function(module) {
    holdingsEstimateRuntime = module;
    return module;
  }).catch(error => { holdingsEstimateModulePromise = null; throw error; });
  return holdingsEstimateModulePromise;
}
function normalizeTencentQuoteTime(...args) { return holdingsEstimateRuntime.normalizeTencentQuoteTime(...args); }
function formatChinaQuoteTime(...args) { return holdingsEstimateRuntime.formatChinaQuoteTime(...args); }

function loadCloudSyncFeature() {
  if (!cloudSyncModulePromise) cloudSyncModulePromise = import('./storage/cloud-sync.js');
  return cloudSyncModulePromise;
}

function notificationPermissionLabel(permission) {
  return {
    granted: '通知已启用；仅发送当日有效盘中估值',
    denied: '通知权限已被浏览器拒绝，请在站点设置中调整',
    default: '仅在你主动启用后请求通知权限',
    unsupported: '当前浏览器不支持网页通知',
  }[permission] || '通知状态待确认';
}

function updateNotificationStatus(permission) {
  const status = document.getElementById('notification-status');
  const button = document.getElementById('notification-enable-btn');
  if (status) status.textContent = notificationPermissionLabel(permission);
  if (button) {
    button.disabled = permission === 'granted' || permission === 'unsupported';
    button.textContent = permission === 'granted' ? '通知已启用' : '启用 14:30 通知';
  }
}

function loadNotificationFeature() {
  if (!notificationControllerPromise) {
    notificationControllerPromise = import('./notifications/notification-controller.js').then(function(module) {
      const controller = module.createNotificationController({
        getHoldings: function() { return holdings; },
        getFunds: function() { return fundsData; },
        refresh: function() { return refresh({ force: true, reason: 'notification' }); },
        readLastSent: function() { return safeGetItem(NOTIFY_DATE_KEY); },
        writeLastSent: function(value) { return safeSetItem(NOTIFY_DATE_KEY, value); },
        intervalMs: TIMING.DAILY_NOTIFY_CHECK_MS,
        onPermissionChange: updateNotificationStatus,
      });
      controller.start();
      return controller;
    });
  }
  return notificationControllerPromise;
}

async function enableDailyNotifications() {
  try {
    const controller = await loadNotificationFeature();
    const permission = await controller.enable();
    if (permission === 'granted') showToast('可信行情通知已启用');
    else if (permission === 'denied') showToast('浏览器已拒绝通知权限');
    else if (permission === 'unsupported') showToast('当前浏览器不支持网页通知');
  } catch (_) {
    showToast('通知功能暂时无法启用');
  }
}

function scheduleNotificationFeature() {
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  updateNotificationStatus(permission);
  if (permission !== 'granted') return;
  const load = function() { loadNotificationFeature().catch(function() {}); };
  if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 3000 });
  else setTimeout(load, 1500);
}


// ── 持仓存取 ─────────────────────────────────────────────
async function loadHoldings() {
  const loaded = await withHoldingsLock(() => loadHoldingsRepository(undefined, { cacheKey: CACHE_KEY }));
  if (!loaded.ok) {
    holdingsStorageError = loaded.reason || 'holdings_load_failed';
    holdingsDocument = null;
    holdings = [];
    return false;
  }
  holdingsStorageError = '';
  holdingsDocument = loaded.document;
  holdings = loaded.legacy;
  return true;
}

async function saveHoldingEdit(edit) {
  const { commitHoldingEdit } = await import('./runtime/holding-edit.js');
  const saved = await commitHoldingEdit(undefined, edit, { cacheKey: CACHE_KEY });
  if (saved.ok || (saved.reason === 'edit_conflict' && saved.document)) installHoldingsDocument(saved.document);
  if (!saved.ok) holdingsStorageError = saved.reason || 'holdings_save_failed';
  return saved;
}

function installHoldingsDocument(value) {
  holdingsDocument = normalizeHoldingsDocumentV3(value);
  holdings = toLegacyHoldings(holdingsDocument);
  holdingsStorageError = '';
  reconcileActiveFundState();
}

function reconcileActiveFundState(options = {}) {
  const activeCodes = activeHoldingCodes(holdings);
  const active = new Set(activeCodes);
  fundsData = retainActiveFundData(holdings, fundsData);
  fundsData.forEach(fund => Object.assign(fund, holdingQuoteAmounts(fund.quote, holdings.find(holding => holding.code === fund.code))));
  [holdingsCache, holdingsMetaCache, fundTypeCache, fundFeeCache].forEach(function(cache) {
    Object.keys(cache).forEach(function(code) {
      if (!active.has(code)) delete cache[code];
    });
  });
  [fundHoldingsRequests].forEach(function(requests) {
    Array.from(requests.keys()).forEach(function(code) {
      if (!active.has(code)) requests.delete(code);
    });
  });
  if (expandedFund && !active.has(expandedFund)) expandedFund = null;
  // An external deletion must not silently discard the open form/baseline.
  if (!activeCodes.length && options.persistCache !== false) safeRemoveItem(CACHE_KEY);
  else if (options.persistCache !== false) saveCache(fundsData);
  if (options.render !== false) {
    renderFundList(fundsData);
    renderHoldingsList();
  }
  return activeCodes;
}

function toNonNegativeNumber(value, options = {}) {
  if (value == null || String(value).trim() === '') return options.nullable ? null : 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : (options.nullable ? undefined : null);
}

function isRealFundName(name, code) {
  const value = String(name || '').trim();
  return Boolean(value && value !== code);
}

function nowISO() { return new Date().toISOString(); }

async function fetchWithTimeout(url, options = {}, timeout = TIMING.CLOUD_SYNC_TIMEOUT) {
  const requestSignal = createRequestSignal(options.signal, timeout);
  try {
    return await fetch(url, { ...options, signal: requestSignal.signal });
  } catch (error) {
    throw requestSignal.normalizeError(error);
  } finally {
    requestSignal.cleanup();
  }
}
// ── 导出 / 导入 ───────────────────────────────────────────
let holdingsTransferFeature;
async function runHoldingsTransfer(action, event) {
  try {
    if (!holdingsTransferFeature) holdingsTransferFeature = import('./runtime/holdings-transfer.js').then(module => module.createHoldingsTransfer({
      getHoldingsDocument: () => holdingsDocument, getHoldings: () => holdings,
      installHoldingsDocument, scheduleAutoPush, renderHoldingsList, refresh, showToast, CACHE_KEY,
    }));
    return await (await holdingsTransferFeature)[action](event);
  } catch (_) { holdingsTransferFeature = null; showToast('持仓工具暂不可用，请重试'); }
}
function exportData() { return runHoldingsTransfer('exportData'); }
function importData(event) { return runHoldingsTransfer('importData', event); }
function restoreLatestBackup() { return runHoldingsTransfer('restoreLatestBackup'); }

// ── 云同步 (GitHub Gist) — 双向自动同步 ────────────────────
function getGistToken() { return safeGetItem(GIST_TOKEN_KEY) || ''; }
function setGistToken(t) { return safeSetItem(GIST_TOKEN_KEY, t); }
function getGistId() { return safeGetItem(GIST_ID_KEY) || ''; }
function setGistId(id) { return safeSetItem(GIST_ID_KEY, id); }
function getSyncTime() { return safeGetItem(GIST_SYNC_TIME_KEY) || ''; }
function setSyncTime(t) { return safeSetItem(GIST_SYNC_TIME_KEY, t); }

// 同步元数据：记录上次 push 时数据的快照 hash，用于判断是否需要推送
function loadSyncMeta() {
  try {
    var raw = safeGetItem(SYNC_META_KEY);
    return raw ? JSON.parse(raw) : { last_push_hash: '', last_pull: '' };
  } catch(e) { return { last_push_hash: '', last_pull: '' }; }
}
function saveSyncMeta(meta) {
  return safeSetItem(SYNC_META_KEY, JSON.stringify(meta));
}

// 完整语义指纹：名称、null 成本、revision、设备与 tombstone 都参与。
function holdingsHash(h) {
  if (h === holdings && holdingsDocument) return canonicalHoldingsDocument(holdingsDocument);
  return JSON.stringify((Array.isArray(h) ? h : []).map(function(x) {
    return {
      code: x.code,
      name: x.name,
      shares: x.shares,
      cost: x.cost == null ? null : x.cost,
      updated_at: x.updated_at || '',
      deleted: x.deleted === true,
      revision: x.revision || 0,
      device_id: x.device_id || '',
      deleted_at: x.deleted_at || null,
      note: x.note == null ? null : x.note,
    };
  }).sort(function(a, b) { return a.code.localeCompare(b.code); }));
}

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

let gistRemoteModulePromise = null;
function loadGistRemoteModule() {
  if (!gistRemoteModulePromise) gistRemoteModulePromise = import('./storage/gist-remote.js');
  return gistRemoteModulePromise;
}

function gistRequest(url, options) {
  return fetchWithTimeout(url, options, TIMING.CLOUD_SYNC_TIMEOUT);
}

async function createGistRemoteAdapter(token, gistId, options = {}) {
  const runtime = await loadGistRemoteModule();
  return runtime.createGistRemoteAdapter({
    token,
    gistId,
    deviceId: options.deviceId || holdingsDocument?.deviceId,
    request: gistRequest,
    now: nowISO,
  });
}

async function createCloudLocalAdapter(gistId) { return (await loadCloudArchiveFeature()).createCloudLocalAdapter(gistId); }

function reloadHoldingsAfterCloud() {
  return withHoldingsLock(() => {
    const loaded = loadHoldingsRepository(undefined, { cacheKey: CACHE_KEY });
    if (loaded.ok) installHoldingsDocument(loaded.document);
    return loaded;
  });
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

function markSyncPending() {
  syncPending = true;
  const meta = loadSyncMeta();
  meta.pending = true;
  meta.pending_hash = holdingsHash(holdings);
  saveSyncMeta(meta);
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

// ── 从云端拉取并合并 ───────────────────────────────────────
async function pullFromCloud(silent) {
  if (serviceWorkerUpdateApplying) return { ok: false, reason: 'service_worker_update_pending' };
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
      deviceId: holdingsDocument?.deviceId,
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

// ── 推送本地变更到云端 ─────────────────────────────────────
async function pushToCloud(silent, options = {}) {
  if (serviceWorkerUpdateApplying) return { ok: false, reason: 'service_worker_update_pending' };
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
      deviceId: holdingsDocument?.deviceId,
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

// ── 防抖：数据变更后延迟推送 ──────────────────────────────
function scheduleAutoPush() {
  if (!hasCloudConfig()) return;
  markSyncPending();
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(function() {
    pushToCloud(true);
  }, TIMING.AUTO_PUSH_DELAY);
}

// ── 后台定时拉取 ──────────────────────────────────────────
function startAutoPull() {
  if (autoPullTimer) clearInterval(autoPullTimer);
  autoPullTimer = setInterval(function() {
    pullFromCloud(true);
    if (hasPendingSync()) scheduleAutoPush();
  }, TIMING.AUTO_PULL_INTERVAL);
}

// ── 页面启动时拉取 ────────────────────────────────────────
async function autoPullOnLoad() {
  if (!hasCloudConfig()) return;
  await pullFromCloud(true);
  if (hasPendingSync()) scheduleAutoPush();
}

// Manual cloud actions are not part of the cold-start graph.
let cloudArchiveFeature;
function loadCloudArchiveFeature() {
    if (!cloudArchiveFeature) cloudArchiveFeature = import("./storage/cloud-archive-ui.js").then(module => module.createCloudArchiveFeature({
      CACHE_KEY, getHoldingsDocument: () => holdingsDocument, getHoldings: () => holdings,
      GIST_TOKEN_KEY, GIST_ID_KEY, GIST_SYNC_TIME_KEY, SYNC_META_KEY, safeRemoveItem,
      resetCloudState: () => {
        syncPending = false;
        if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
        if (autoPullTimer) { clearInterval(autoPullTimer); autoPullTimer = null; }
      },
      loadCloudSyncFeature, loadGistRemoteModule, nowISO, fetchWithTimeout, setGistId, createGistRemoteAdapter,
      loadSyncMeta, saveSyncMeta, setSyncTime, setSyncPending: value => { syncPending = value; },
      installHoldingsDocument, setGistToken, getGistId, pushToCloud, pullFromCloud, markSyncPending,
      handleCloudFailure, renderCloudStatus, showToast, startAutoPull, findExistingGist,
    })).catch(error => { cloudArchiveFeature = null; throw error; });
  return cloudArchiveFeature;
}
async function runCloudArchiveAction(action) {
  try {
    return await (await loadCloudArchiveFeature())[action]();
  } catch (_) { cloudArchiveFeature = null; showToast("云端工具暂不可用，请重试"); }
}
function uploadToCloud() { return runCloudArchiveAction("uploadToCloud"); }
function downloadFromCloud() { return runCloudArchiveAction("downloadFromCloud"); }

// ── 搜索已存在的云端存档 ──────────────────────────────────
async function findExistingGist(token) {
  try {
    const runtime = await loadGistRemoteModule();
    return await runtime.findExistingHoldingsGist({ token, request: gistRequest, maxPages: 5 }) || null;
  } catch(e) { return null; }
}


function clearCloudConfig() { return runCloudArchiveAction("clearCloudConfig"); }

// ── 缓存 ──────────────────────────────────────────────────
function loadCache() {
  try {
    const raw = safeGetItem(CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    if (!cache.data || !Array.isArray(cache.data) || !cache.data.length) return null;
    if (cache.data.some(item => !item || !/^\d{6}$/.test(item.code)) || new Set(cache.data.map(item => item.code)).size !== cache.data.length) return null;
    if (cache.holdingsHash !== holdingsHash(holdings)) return null;
    return { data: cache.data, time: cache.fetchedAt || cache.time || 0, expiresAt: cache.expiresAt || null, fresh: Date.now() < (cache.expiresAt || 0) };
  } catch(e) { return null; }
}

function slimFundCache(data) {
  return data.map(d => Object.fromEntries(Object.entries(d).filter(([key]) => !SKIP_CACHE_KEYS.includes(key))));
}

function saveCache(data) {
  // Holdings edits update projections, not market acquisition timestamps.
  try {
    const previous = JSON.parse(safeGetItem(CACHE_KEY));
    if (!previous || !Array.isArray(previous.data)) return;
    safeSetItem(CACHE_KEY, JSON.stringify({ ...previous, data: slimFundCache(data), holdingsHash: holdingsHash(holdings) }));
  } catch (_) {}
}



async function fetchLatestNavMoveRaw(code, signal) {
  try {
    const bridge = await loadQuoteBridgeFeature();
    const result = await bridge.officialFundData(code, {
      signal: signal,
      timeoutMs: TIMING.FUND_JSONP_TIMEOUT,
    });
    const prev = result.points[0];
    const cur = result.points[1];
    if (!isUsableNav(cur.nav) || !isUsableNav(prev.nav)) return null;
    return {
      date: cur.date,
      prevDate: prev.date,
      nav: cur.nav,
      prevNav: prev.nav,
      change: (cur.nav - prev.nav) / prev.nav * 100,
      changeAmt: cur.nav - prev.nav,
      fundName: result.fundName || '',
      meta: {
        scale: Number.isFinite(result.meta.scale) ? result.meta.scale + ' 亿' : '',
        manager: result.meta.managerName || '',
        managerWorkTime: result.meta.managerWorkTime || '',
        managerId: result.meta.managerId || '',
        sourceRate: result.meta.sourceRate || '',
        currentRate: result.meta.currentRate || '',
      },
    };
  } catch (error) {
    if (signal && signal.aborted) {
      const abort = new Error('正式净值请求已取消');
      abort.name = 'AbortError';
      throw abort;
    }
    return null;
  }
}

// A six-digit fund code is never reinterpreted as an A-share secid.
function officialFundFallback(code, navMove) {
  return {
    code, name: '', status: 'ok_official', last_nav: navMove.prevNav,
    est_nav: navMove.nav, est_change: navMove.change, nav_date: navMove.prevDate, est_time: navMove.date,
    base_nav: navMove.prevNav, base_nav_date: navMove.prevDate, value_date: navMove.date,
    est_kind: 'official_nav', est_label: '最新正式净值', est_realtime: false,
    latest_nav_move: navMove,
    source_quote: normalizeOfficialNavQuote(navMove, { fundCode: code, now: Date.now() }),
  };
}

function buildFundData(r, h, modelQuotes) {
  const fetchedName = (r.status === 'ok' || r.status === 'ok_fallback') && isRealFundName(r.name, h.code) ? String(r.name).trim() : '';
  const d = {
    ...r,
    name: fetchedName || String(h.name || '').trim() || h.code,
    shares: h.shares == null ? 0 : h.shares,
    cost: h.cost == null ? null : h.cost,
  };
  applyOverseasModelEstimate(d, modelQuotes || {});
  if (!isUsableNav(d.est_nav) && isUsableNav(d.last_nav) && Number.isFinite(d.est_change)) d.est_nav = d.last_nav * (1 + d.est_change / 100);
  d.updatedAt = Date.now();
  d.market = classifyMarketKind(d.name);
  d.assetKind = classifyAssetKind(d.name, d.market);
  d.quoteCandidates = buildFundQuoteCandidates(d, {
    fundCode: d.code,
    fundName: d.name,
    market: d.market,
    assetKind: d.assetKind,
    fetchedAt: new Date(d.updatedAt).toISOString(),
    now: d.updatedAt,
  });
  d.quote = selectPreferredQuote(d.quoteCandidates, {
    fundCode: d.code,
    fundName: d.name,
    market: d.market,
    assetKind: d.assetKind,
  }, { now: d.updatedAt });
  // The display contract is the only authority for quote kind and freshness.
  // Legacy NAV-pair fields remain only as calculation inputs, never as a
  // second decision path for labelling a quote as official.
  d.primary_change = d.quote.changePct == null ? NaN : d.quote.changePct;
  d.primary_nav = d.quote.value == null ? NaN : d.quote.value;
  d.primary_base_nav = resolveQuoteBaseNav(d, d.quote);
  d.primary_label = ({
    official_nav: '净',
    model_estimate: '模',
    holding_lookthrough_estimate: '重仓估',
    intraday_estimate: d.quote.status === 'realtime' ? '估' : '延迟估值',
  })[d.quote.valueKind] || '';
  d.primary_note = d.quote.valueKind === 'official_nav'
    ? '最新公布净值涨跌：' + [d.quote.baseNavDate, d.quote.targetDate].filter(Boolean).join(' → ')
    : '';
  d.today_is_latest_nav = d.quote.valueKind === 'official_nav';
  Object.assign(d, holdingQuoteAmounts(d.quote, h, d.updatedAt));
  d.display = {
    nav: d.quote.value,
    change: d.quote.changePct,
    kind: d.quote.valueKind,
    label: d.primary_label,
    stale: ['stale', 'unavailable'].includes(d.quote.status),
  };
  d.loading = false; d.stale = ['stale', 'unavailable'].includes(d.quote.status); d.error = null; d._cached = d.quote.sourceTier === 'cache';
  d.freshness = legacyFreshnessFromQuote(d.quote);
  return { data: d, fetchedName };
}

function upsertFundData(code, data) {
  var index = fundsData.findIndex(function(item) { return item.code === code; });
  if (index >= 0) fundsData[index] = data; else fundsData.push(data);
  scheduleFundRender();
}

function updateFundStatus(code, status) {
  var old = fundsData.find(function(item) { return item.code === code; });
  if (!old) return;
  Object.assign(old, status);
  scheduleFundRender();
}

function scheduleFundRender() {
  if (fundRenderFrame != null) return;
  var schedule = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : function(callback) { return setTimeout(callback, 0); };
  fundRenderFrame = schedule(function() {
    fundRenderFrame = null;
    renderFundList(fundsData);
  });
}

// ── 刷新所有持仓数据 ─────────────────────────────────────
function refresh(options) {
  var opts = options || {};
  var trigger = opts.reason || 'data-change';
  if (serviceWorkerUpdateApplying) {
    return Promise.resolve({ status: 'skipped', reason: 'service_worker_update_pending', trigger: trigger });
  }
  return refreshCoordinator.request({
    trigger: trigger,
    payload: opts,
    // Only timer ticks coalesce. Manual/visibility/online actions always start
    // a real generation so force/payload changes cannot be ignored.
    coalesce: opts.coalesce == null ? trigger === 'timer' : Boolean(opts.coalesce),
  });
}

function makeRefreshAbortError() {
  var error = new Error('刷新请求已被新的代际替代');
  error.name = 'AbortError';
  return error;
}

function requireCurrentRefresh(context) {
  if (!context || !context.isCurrent() || context.signal.aborted) throw makeRefreshAbortError();
}

async function fetchRefreshEstimateRows(snapshot, options, context, dispatch) {
  var sourceId = 'sinan-estimate-proxy';
  var claim = context.claimSourceAttempt(sourceId);
  if (!claim.allowed) {
    context.recordDiagnostic('source_cooldown', { sourceId: sourceId, reason: 'circuit_breaker_open' });
    return new Map();
  }
  var startedAt = Date.now();
  try {
    var rows = await dispatch(() => fetchEstimateRows(
      snapshot.map(function(h) { return h.code; }),
      { force: options.force !== false, signal: context.signal }
    ));
    var usableCount = Array.from(rows.values()).filter(function(row) {
      return row && row.status === 'ok' && row.source_quote && !['stale', 'unavailable'].includes(row.source_quote.status);
    }).length;
    var responseMs = Math.max(0, Date.now() - startedAt);
    if (usableCount === snapshot.length) {
      context.recordSourceSuccess(sourceId, { responseMs: responseMs });
    } else if (usableCount > 0) {
      context.recordSourcePartial(sourceId, {
        responseMs: responseMs,
        reason: 'partial_coverage_' + usableCount + '_of_' + snapshot.length,
      });
      context.recordDiagnostic('source_partial', {
        sourceId: sourceId, usable: usableCount, requested: snapshot.length,
      });
    } else {
      context.recordSourceFailure(sourceId, {
        code: 'BUSINESS_EMPTY', reason: 'no_usable_quotes', responseMs: responseMs,
      });
      context.recordDiagnostic('source_empty', { sourceId: sourceId, requested: snapshot.length });
    }
    return rows;
  } catch (error) {
    if (isRefreshAbort(error, context.signal)) {
      // A cancelled half-open probe is released without treating cancellation
      // as another upstream failure.
      context.recordSourceFailure(sourceId, { name: 'AbortError', aborted: true });
      throw error;
    }
    context.recordSourceFailure(sourceId, { error: error, responseMs: Math.max(0, Date.now() - startedAt) });
    context.recordDiagnostic('source_failed', { sourceId: sourceId, reason: error.name || error.message || 'request_failed' });
    return new Map();
  }
}

function commitRefreshedFund(context, holding, built) {
  return context.commit(function() {
    upsertFundData(holding.code, built.data);
    if (isOverseasLikeFund(built.data)) {
      import('./accuracy.js').then(({ updateFundAccuracy }) => {
        context.commit(() => updateFundAccuracy(built.data));
      }).catch(() => {});
    }
    if (built.fetchedName) {
      var current = holdings.find(function(item) { return item.code === holding.code; });
      if (current && !isRealFundName(current.name, current.code)) {
        const baseline = holdingsDocument?.holdings.find(row => row.fundCode === current.code);
        saveHoldingEdit({ code: current.code, baseline, operation: 'name',
          values: { name: built.fetchedName }, signal: context.signal,
        }).then(saved => { if (saved.ok) scheduleAutoPush(); }).catch(() => {});
      }
    }
  });
}

function commitRefreshFailure(context, holding, error) {
  var old = fundsData.find(function(item) { return item.code === holding.code; });
  var failedAt = Date.now();
  var identity = {
    fundCode: holding.code,
    fundName: (old && old.name) || holding.name || holding.code,
    market: (old && old.market) || classifyMarketKind((old && old.name) || holding.name),
    assetKind: (old && old.assetKind) || classifyAssetKind((old && old.name) || holding.name),
  };
  var failed = {
    loading: false,
    stale: true,
    error: error.message || '更新失败',
    message: error.message || '更新失败',
    _cached: Boolean(old),
    status: old ? old.status : 'error',
  };
  failed.quote = old && old.quote
    ? normalizeCachedQuote({ ...old.quote, reasonCodes: [...(old.quote.reasonCodes || []), 'refresh_failed'] }, { fresh: false, now: failedAt, fallbackIdentity: identity })
    : selectPreferredQuote([], identity, { now: failedAt });
  failed.freshness = legacyFreshnessFromQuote(failed.quote);
  context.recordDiagnostic('fund_failed', { key: holding.code, reason: failed.error });
  return context.commit(function() {
    if (old) updateFundStatus(holding.code, failed);
    else upsertFundData(holding.code, {
      code: holding.code,
      name: holding.name || holding.code,
      shares: holding.shares == null ? 0 : holding.shares,
      cost: holding.cost == null ? null : holding.cost,
      ...failed,
    });
  });
}


async function runRefresh(context, options) {
  try {
    requireCurrentRefresh(context);
    reconcileActiveFundState({ render: false, persistCache: false });
    const snapshot = holdings.filter(h => !h.deleted).map(h => ({ ...h }));
    context.commit(() => {
      snapshot.forEach(h => {
        const old = fundsData.find(item => item.code === h.code);
        if (old) updateFundStatus(h.code, { loading: true, error: null });
        else upsertFundData(h.code, { ...h, status: 'loading', loading: true });
      });
      renderFundList(fundsData);
    });
    const [execution, holdingModule, estimateModule] = await Promise.all([
      import('./runtime/refresh-execution.js'), loadFundHoldingsFeature(), loadHoldingsEstimateFeature(),
    ]);
    requireCurrentRefresh(context);
    let previous;
    try { previous = JSON.parse(safeGetItem(CACHE_KEY)); } catch (_) { previous = null; }
    const legacyNavMoves = {};
    snapshot.forEach(h => {
      try { legacyNavMoves[h.code] = JSON.parse(safeGetItem('fuyu_nav_move_' + h.code)); } catch (_) {}
    });
    return await execution.executeRefreshPlan({
      context, snapshot, options: options || {}, previous, legacyNavMoves,
      storage: { setItem: (key, value) => safeSetItem(key, value) },
      clients: {
        estimates: fetchRefreshEstimateRows,
        nav: fetchLatestNavMoveRaw,
        holdings: (code, signal) => holdingModule.fetchFundHoldings(code, { signal }),
        qualifyHoldings: (holding, items) => items.map(stock => ({
          ...stock, quoteCode: holdingModule.holdingQuoteCode(stock, {
            allowMainland: ['cn', 'cn-index'].includes(classifyFundMarket(holding.name)),
          }),
        })),
        models: async active => {
          await overseasModelsPromise;
          requireCurrentRefresh(context);
          return active.map(h => selectOverseasModel(h.code, h.name)).filter(Boolean);
        },
        calculateHoldings: (items, reportDate) => estimateModule.calculateHoldingsEstimate(items, {
          now: Date.now(), reportDate, requireCurrentReport: true,
        }),
        normalizeTime: normalizeTencentQuoteTime,
        eastmoney: async (codes, signal) => {
          const secids = codes.map(code => (code.startsWith('sh') ? '1.' : '0.') + code.slice(2));
          const response = await fetchWithTimeout(
            'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f13,f2,f3,f124&secids=' + secids.join(',') + '&_=' + Date.now(),
            { signal }, TIMING.INDEX_JSONP_TIMEOUT);
          if (!response.ok) throw new Error('证券行情 HTTP ' + response.status);
          return response.json();
        },
        bridge: async (operation, codes, signal) => {
          const bridge = await loadQuoteBridgeFeature();
          return bridge[operation](codes, { signal, timeoutMs: TIMING.INDEX_JSONP_TIMEOUT });
        },
        indices: async (codes, signal) => {
          const bridge = await loadQuoteBridgeFeature();
          const result = await bridge.indexQuotes(codes, { signal, timeoutMs: TIMING.INDEX_JSONP_TIMEOUT });
          return result.quotes.map(quote => {
            const observedAt = normalizeTencentQuoteTime(quote.sourceTimeRaw, quote.code);
            return { code: quote.code, price: quote.price, changePct: quote.changePct,
              observedAt, status: indexQuoteStatus(observedAt) };
          });
        },
        gold: fetchGoldFromEastmoney,
      },
      ui: {
        primary: (holding, raw, navMove) => {
          if (raw?.status === 'ok') return raw;
          if (!navMove) return null;
          return officialFundFallback(holding.code, navMove);
        },
        publish: (holding, raw) => commitRefreshedFund(context, holding, buildFundData(raw, holding, {})),
        enriched: (holding, raw, officialNavMove, holdingsEstimate, modelQuotes) => {
          const enriched = estimateModule.composeFundEnrichment(raw, { officialNavMove, holdingsEstimate });
          upsertFundData(holding.code, buildFundData(enriched, holding, modelQuotes).data);
          updateLatestSourceSummary();
        },
        failure: (holding, error) => commitRefreshFailure(context, holding, error),
        holdings: (code, payload) => {
          holdingsCache[code] = payload.items.map(item => ({ ...item }));
          const { items, ...metadata } = payload;
          holdingsMetaCache[code] = metadata;
          scheduleFundRender();
        },
        metadata: (code, meta) => {
          const fund = fundsData.find(item => item.code === code) || holdings.find(item => item.code === code);
          fundTypeCache[code] = { type: inferFundType(fund?.name), ...meta };
          fundFeeCache[code] = meta.currentRate || meta.sourceRate ? {
            buyFee: meta.currentRate ? meta.currentRate + '%' : '',
            sourceBuyFee: meta.sourceRate ? meta.sourceRate + '%' : '',
          } : null;
          scheduleFundRender();
        },
        market: (indexEntry, goldEntry, components) => {
          const quotes = new Map((indexEntry?.payload.quotes || []).map(quote => [quote.code, quote]));
          indexCache = INDEX_CONFIG.map((cfg, index) => {
            if (cfg.source === 'gold') {
              if (!components.gold) return indexCache[index];
              const quote = goldEntry?.payload;
              if (!quote) return loadGoldCache() || staleIndexItem(indexCache[index], cfg.name);
              return { ...quote, name: cfg.name, cached: true,
                status: Date.now() < goldEntry.expiresAt ? indexQuoteStatus(quote.observedAt) : 'stale' };
            }
            if (!components.indices) return indexCache[index];
            const quote = quotes.get(cfg.code);
            return quote ? { ...quote, name: cfg.name, cached: true,
              status: Date.now() < indexEntry.expiresAt ? indexQuoteStatus(quote.observedAt) : 'stale' }
              : staleIndexItem(indexCache[index], cfg.name);
          });
          renderIndexBar(indexCache);
        },
        cacheData: () => slimFundCache(fundsData),
        holdingsHash: () => holdingsHash(holdings),
        complete: updateLatestSourceSummary,
      },
    });
  } catch (error) {
    if (isRefreshAbort(error, context.signal)) throw error;
    context.recordDiagnostic('refresh_failed', { reason: error.code || error.name || 'request_failed' });
    context.commit(() => { if (!fundsData.length && !tryShowCache()) renderFundList([]); });
    throw error;
  }
}

function updateLatestSourceSummary() {
  var usable = fundsData.map(function(f) {
    var quote = f && f.quote;
    if (!quote || quote.status === 'unavailable' || quote.status === 'stale') return null;
    var timestamp = parseQuoteTimestamp(quote.observedAt);
    if (timestamp == null && /^\d{4}-\d{2}-\d{2}$/.test(String(quote.officialNavDate || ''))) {
      timestamp = Date.parse(quote.officialNavDate + 'T00:00:00+08:00');
    }
    return Number.isFinite(timestamp) ? { quote: quote, timestamp: timestamp } : null;
  }).filter(Boolean);
  var latest = usable.sort(function(a, b) { return b.timestamp - a.timestamp; })[0] || null;
  var todayCount = fundsData.filter(function(f) {
    return createValuationPeriod(f.quote, { now: Date.now(), shares: f.shares }).isTodayEstimate;
  }).length;
  var staleCount = fundsData.filter(function(f) { return f.quote && f.quote.status === 'stale'; }).length;
  var staleLabel = staleCount ? ' · 旧数据 ' + staleCount : '';
  document.getElementById('last-upd').textContent = latest
    ? '最新可信数据 ' + createQuotePresentation(latest.quote, { now: Date.now() }).dataTimeLabel
      + ' · 今日估算 ' + todayCount + '/' + fundsData.length + staleLabel
    : '暂无当前行情' + staleLabel;
}

function tryShowCache() {
  const cache = loadCache();
  if (!cache) return false;
  fundsData = cache.data.map(function(d) {
    var market = d.quote && d.quote.market || d.market || classifyMarketKind(d.name);
    var assetKind = d.quote && d.quote.assetKind || d.assetKind || classifyAssetKind(d.name, market);
    var fallbackIdentity = { fundCode: d.code, fundName: d.name || d.code, market, assetKind };
    var sourceQuote = d.quote || selectPreferredQuote(buildFundQuoteCandidates(d, {
      ...fallbackIdentity,
      fetchedAt: cache.time ? new Date(cache.time).toISOString() : new Date(0).toISOString(),
    }), fallbackIdentity);
    var quote = normalizeCachedQuote(sourceQuote, {
      fresh: cache.fresh && navigator.onLine !== false,
      fetchedAt: cache.time ? new Date(cache.time).toISOString() : new Date(0).toISOString(),
      cachedAt: cache.time, expiresAt: cache.expiresAt,
      fallbackIdentity,
    });
    const holding = holdings.find(item => item.code === d.code);
    return {
      ...d,
      ...holdingQuoteAmounts(quote, holding, Date.now()),
      market,
      assetKind,
      quote,
      primary_change: quote.changePct == null ? NaN : quote.changePct,
      primary_nav: quote.value == null ? NaN : quote.value,
      display: { nav: quote.value, change: quote.changePct, kind: quote.valueKind, stale: quote.status === 'stale' },
      stale: true,
      _cached: true,
      freshness: legacyFreshnessFromQuote(quote),
    };
  });
  renderFundList(fundsData);
  const ct = new Date(cache.time);
  document.getElementById('last-upd').textContent =
    `缓存数据 ${pad(ct.getMonth()+1)}/${pad(ct.getDate())} ${pad(ct.getHours())}:${pad(ct.getMinutes())}`;
  return true;
}

function pad(n) { return String(n).padStart(2,'0'); }
function isUsableNav(n) { return Number.isFinite(n) && n > 0; }
function parseNav(value) {
  return nullableNumber(value) ?? NaN;
}

function isOverseasFundEstimate(name, estTime) {
  var text = String(name || '');
  var isOverseasFund = /QDII|全球|海外|新兴市场|纳斯达克|标普|恒生|港股|美元|国际|日经|德国|越南|印度|香港/i.test(text);
  var m = String(estTime || '').match(/\s(\d{1,2}):(\d{2})$/);
  var hour = m ? Number(m[1]) : NaN;
  return isOverseasFund && Number.isFinite(hour) && (hour < 9 || hour >= 15);
}

function isOverseasLikeFund(fund) {
  if (fund && (fund.est_kind === 'overseas' || fund.est_kind === 'overseas_model')) return true;
  var text = String((fund && (fund.name || fund.type)) || '');
  return /QDII|全球|海外|新兴市场|纳斯达克|标普|恒生|港股|美元|国际|日经|德国|越南|印度|香港/i.test(text);
}

function latestNavMoveOf(fund) {
  if (fund && fund.latest_nav_move && Number.isFinite(fund.latest_nav_move.change)) return fund.latest_nav_move;
  return null;
}

function preferredDailyMove(fund) {
  var move = latestNavMoveOf(fund);
  if (fund && fund.est_model && !fund.est_model_stale && Number.isFinite(fund.est_change)) {
    var modelBaseNav = isUsableNav(fund.est_model_base_nav)
      ? fund.est_model_base_nav
      : (move && isUsableNav(move.nav) ? move.nav : fund.last_nav);
    if (isUsableNav(modelBaseNav)) {
      return {
        change: fund.est_change,
        baseNav: modelBaseNav,
        nav: isUsableNav(fund.est_nav) ? fund.est_nav : modelBaseNav * (1 + fund.est_change / 100),
        label: '模',
        sourceNote: fund.est_note || '下一净值海外市场模型估算',
        isLatestNav: false
      };
    }
  }
  if (move && isOverseasLikeFund(fund)) {
    return {
      change: move.change,
      baseNav: move.prevNav,
      nav: move.nav,
      label: '净',
      sourceNote: '最新公布净值涨跌' + (move.prevDate || move.date ? '：' + [move.prevDate, move.date].filter(Boolean).join(' → ') : ''),
      isLatestNav: true
    };
  }
  if (fund && fund.est_kind === 'official_nav' && Number.isFinite(fund.est_change) && isUsableNav(fund.last_nav)) {
    return {
      change: fund.est_change,
      baseNav: fund.last_nav,
      nav: isUsableNav(fund.est_nav) ? fund.est_nav : fund.last_nav * (1 + fund.est_change / 100),
      label: '净',
      sourceNote: fund.est_note || '最近公布正式净值涨跌',
      isLatestNav: true
    };
  }
  if (fund && Number.isFinite(fund.est_change) && isUsableNav(fund.last_nav)) {
    return {
      change: fund.est_change,
      baseNav: fund.last_nav,
      nav: isUsableNav(fund.est_nav) ? fund.est_nav : fund.last_nav * (1 + fund.est_change / 100),
      label: fund.est_kind === 'holdings_model' ? '重仓估' : (fund.est_realtime === false ? '海外非实时' : '估'),
      sourceNote: fund.est_note || '',
      isLatestNav: false
    };
  }
  return null;
}

function applyOverseasModelEstimate(...args) { return modelRuntime?.applyOverseasModelEstimate(...args); }

// ── 排序 ─────────────────────────────────────────────────
function safeN(v, fallback) { return Number.isFinite(v) ? v : fallback; }
function displayChangeOf(fund) {
  if (!fund || !fund.quote || fund.quote.status === 'unavailable' || fund.quote.changePct == null) return NaN;
  return Number.isFinite(Number(fund.quote.changePct)) ? Number(fund.quote.changePct) : NaN;
}

function sortFunds(data) {
  const sorted = [...data];
  sorted.sort((a, b) => {
    const qualityDifference = quoteStatusRank(b && b.quote) - quoteStatusRank(a && a.quote);
    if (qualityDifference) return qualityDifference;
    if (sortBy.startsWith('today_profit_') || sortBy.startsWith('est_change_')) {
      const intervalDifference = String(a.period?.comparisonKey || '~').localeCompare(String(b.period?.comparisonKey || '~'));
      if (intervalDifference) return intervalDifference;
    }
    switch (sortBy) {
      case 'est_change_desc': return safeN(displayChangeOf(b), -Infinity) - safeN(displayChangeOf(a), -Infinity);
      case 'est_change_asc':  return safeN(displayChangeOf(a),  Infinity) - safeN(displayChangeOf(b),  Infinity);
      case 'today_profit_desc': return safeN(b.today_profit, -Infinity) - safeN(a.today_profit, -Infinity);
      case 'today_profit_asc':  return safeN(a.today_profit,  Infinity) - safeN(b.today_profit,  Infinity);
      case 'curr_value_desc': return safeN(b.curr_value, 0) - safeN(a.curr_value, 0);
      case 'curr_value_asc':  return safeN(a.curr_value, 0) - safeN(b.curr_value, 0);
      case 'total_profit_desc': return safeN(b.total_profit, -Infinity) - safeN(a.total_profit, -Infinity);
      case 'total_profit_asc':  return safeN(a.total_profit,  Infinity) - safeN(b.total_profit,  Infinity);
      case 'profit_rate_desc': return safeN(b.total_profit_rate, -Infinity) - safeN(a.total_profit_rate, -Infinity);
      case 'profit_rate_asc':  return safeN(a.total_profit_rate,  Infinity) - safeN(b.total_profit_rate,  Infinity);
      default: return 0;
    }
  });
  return sorted;
}

function toggleEstSort() {
  sortBy = (sortBy === 'est_change_desc') ? 'est_change_asc' : 'est_change_desc';
  renderFundList(fundsData);
}

function updateSortBar() {
  var btn = document.getElementById('sort-est-btn');
  if (btn) btn.textContent = '可信等级优先 · 涨跌 ' + (sortBy === 'est_change_desc' ? '↓' : '↑');
}

// ── 重仓股 ───────────────────────────────────────────────
function holdingsCacheIsFresh(meta) {
  const cachedAt = Number(meta && meta.cachedAt);
  return Number.isFinite(cachedAt) && cachedAt > 0 && Date.now() - cachedAt < TTL.HOLDINGS;
}

async function loadFundHoldings(code, options) {
  var opts = options || {};
  var persist = opts.persist !== false;
  throwIfAborted(opts.signal);
  if (persist && holdingsCache[code] !== undefined
    && holdingsMetaCache[code]?.status !== 'error'
    && holdingsCacheIsFresh(holdingsMetaCache[code])) {
    return { items: holdingsCache[code], ...holdingsMetaCache[code] };
  }
  if (persist && !opts.signal && fundHoldingsRequests.has(code)) return fundHoldingsRequests.get(code);

  var request = loadFundHoldingsFeature().then(function(module) {
    return module.fetchFundHoldings(code, { signal: opts.signal, force: opts.force });
  }).then(function(result) {
    var metadata = {
      status: result.status,
      reportDate: result.reportDate,
      source: result.source,
      sourceStatus: result.sourceStatus,
      wireVersion: result.wireVersion,
      fetchedAt: result.fetchedAt,
      cachedAt: Date.now()
    };
    if (persist) {
      holdingsCache[code] = result.items;
      holdingsMetaCache[code] = metadata;
    }
    return { items: result.items, ...metadata };
  }).catch(function(error) {
    if (persist && !(opts.signal && opts.signal.aborted)) {
      holdingsCache[code] = [];
      holdingsMetaCache[code] = { status: 'error', reportDate: '', source: '', fetchedAt: '' };
    }
    throw error;
  }).finally(function() {
    if (fundHoldingsRequests.get(code) === request) fundHoldingsRequests.delete(code);
  });
  if (persist) fundHoldingsRequests.set(code, request);
  return request;
}


async function toggleFundDetail(code) {
  const generation = ++detailToggleGeneration;
  if (expandedFund === code) {
    expandedFund = null;
    loadingDetails = null;
    renderFundList(fundsData);
    return;
  }
  try {
    if (!quoteDiagnosticsPromise) quoteDiagnosticsPromise = import('./runtime/quote-diagnostics.js');
    quoteDiagnosticsRuntime = await quoteDiagnosticsPromise;
  } catch (_) {
    quoteDiagnosticsPromise = null;
    showToast('数据说明暂不可用，请重试');
    return;
  }
  if (generation !== detailToggleGeneration) return;
  if (holdingsMetaCache[code]?.status === 'error') {
    delete holdingsCache[code];
    delete holdingsMetaCache[code];
  }
  expandedFund = code;
  renderFundList(fundsData);
  if (loadingDetails !== code) fetchFundDetails(code);
}

// ── 顺序加载基金详情（重仓股 → 基金类型 → 费率） ──
async function fetchFundDetails(code) {
  loadingDetails = code;
  try {
    // 1. 重仓股：通过服务端代理补齐东方财富要求的 Referer。
    if (holdingsCache[code] === undefined) {
      try {
        await loadFundHoldings(code);
      } catch(e) {
        holdingsCache[code] = [];
        holdingsMetaCache[code] = { status: 'error', reportDate: '', source: '' };
      }
      if (expandedFund !== code) return;
      renderFundList(fundsData);

      if (holdingsCache[code].length) {
        await fetchHoldingsQuotes(code, holdingsCache[code]);
        if (expandedFund !== code) return;
        renderFundList(fundsData);
      }
    }

    // 2. 基金信息：来自已加载的 pingzhongdata。旧 jjxx 接口目前返回残缺脚本。
    if (fundTypeCache[code] === undefined) {
      var currentFund = fundsData.find(function(item) { return item.code === code; });
      var meta = currentFund && currentFund.latest_nav_move && currentFund.latest_nav_move.meta || {};
      fundTypeCache[code] = {
        type: inferFundType(currentFund && currentFund.name),
        scale: meta.scale || '',
        manager: meta.manager || '',
        managerWorkTime: meta.managerWorkTime || '',
        managerId: meta.managerId || ''
      };
      if (expandedFund !== code) return;
      renderFundList(fundsData);
    }

    // 3. 申购费率同样来自 pingzhongdata，避免已失效的 jjfl 入口。
    if (fundFeeCache[code] === undefined) {
      var fundForFee = fundsData.find(function(item) { return item.code === code; });
      var feeMeta = fundForFee && fundForFee.latest_nav_move && fundForFee.latest_nav_move.meta || {};
      fundFeeCache[code] = feeMeta.currentRate || feeMeta.sourceRate ? {
        buyFee: feeMeta.currentRate ? feeMeta.currentRate + '%' : '',
        sourceBuyFee: feeMeta.sourceRate ? feeMeta.sourceRate + '%' : ''
      } : null;
      if (expandedFund !== code) return;
      renderFundList(fundsData);
    }
  } finally {
    if (loadingDetails === code) loadingDetails = null;
  }
}

function inferFundType(name) {
  var text = String(name || '');
  if (/QDII|全球|海外|美国|香港|恒生|纳斯达克|标普/i.test(text)) return 'QDII';
  if (/指数|ETF|联接/.test(text)) return '指数型';
  if (/债券|纯债|可转债/.test(text)) return '债券型';
  if (/货币/.test(text)) return '货币型';
  if (/股票/.test(text)) return '股票型';
  if (/混合/.test(text)) return '混合型';
  return '基金';
}

// ── 重仓股实时涨跌幅（jjcc 接口本身只有「占净值比例」，不含涨跌幅，需额外查一次行情） ──
async function fetchHoldingsQuotes(code, stocks, signal) {
  await loadHoldingsEstimateFeature();
  var module = await loadFundHoldingsFeature();
  var fund = fundsData.find(function(item) { return item.code === code; }) || holdings.find(function(item) { return item.code === code; });
  var allowMainland = Boolean(fund?.name) && ['cn', 'cn-index'].includes(classifyFundMarket(fund.name));
  stocks.forEach(function(stock) {
    stock.quoteCode = module.holdingQuoteCode(stock, { allowMainland: allowMainland });
    if (!stock.quoteCode) { delete stock.change; delete stock.quoteTime; }
  });
  await fetchAStockHoldingQuotes(stocks, signal);
  var missing = stocks.filter(function(stock) {
    return !Number.isFinite(stock.change) || !stock.quoteTime;
  });
  if (missing.length) await fetchTencentHoldingQuotes(missing, signal);
}

async function fetchAStockHoldingQuotes(stocks, signal) {
  var aStocks = stocks.filter(function(s) { return /^(sh|sz)\d{6}$/.test(s.quoteCode); });
  if (!aStocks.length) return;
  var secids = aStocks.map(function(s) { return (s.quoteCode.startsWith('sh') ? '1.' : '0.') + s.code; });
  try {
    var resp = await fetchWithTimeout(
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f12,f3,f124&secids=' + secids.join(',') + '&_=' + Date.now(),
      { signal: signal },
      TIMING.INDEX_JSONP_TIMEOUT);
    if (!resp.ok) return;
    var json = await resp.json();
    var diff = json && json.data && json.data.diff;
    if (!diff) return;
    var list = Array.isArray(diff) ? diff : Object.keys(diff).map(function(k) { return diff[k]; });
    var changeMap = {};
    list.forEach(function(item) {
      changeMap[item.f12] = {
        change: parseNav(item.f3),
        quoteTime: formatChinaQuoteTime(item.f124)
      };
    });
    aStocks.forEach(function(s) {
      var quote = changeMap[s.code];
      if (quote && Number.isFinite(quote.change)) {
        s.change = quote.change;
        s.quoteTime = quote.quoteTime;
      }
    });
  } catch(e) {
    if (signal && signal.aborted) throw e;
    // 静默失败，涨跌幅列保持 '--'
  }
}

async function fetchTencentHoldingQuotes(stocks, signal) {
  var items = stocks.map(function(s) {
    return { stock: s, quoteCode: s.quoteCode };
  }).filter(function(item) { return item.quoteCode; });

  if (!items.length) return;
  try {
    const bridge = await loadQuoteBridgeFeature();
    const result = await bridge.securityQuotes(items.map(function(item) { return item.quoteCode; }), {
      signal: signal,
      timeoutMs: TIMING.INDEX_JSONP_TIMEOUT,
    });
    const byCode = new Map(result.quotes.map(function(quote) { return [quote.code, quote]; }));
    items.forEach(function(item) {
      const quote = byCode.get(item.quoteCode);
      if (quote && quote.changePct != null) {
        item.stock.change = quote.changePct;
        item.stock.quoteTime = normalizeTencentQuoteTime(quote.sourceTimeRaw, item.quoteCode);
      }
    });
  } catch (error) {
    if (signal && signal.aborted) {
      const abort = new Error('重仓行情请求已取消');
      abort.name = 'AbortError';
      throw abort;
    }
  }
}

function fmtQuoteNav(value) {
  return Number.isFinite(value) ? Number(value).toFixed(4) : '--';
}

function renderQuoteDiagnostics(presentation) { return quoteDiagnosticsRuntime.renderQuoteDiagnostics(presentation, esc); }

// ── 渲染基金列表 ─────────────────────────────────────────
function renderFundList(data) {
  var list = document.getElementById('fund-list');
  var focusedToggleCode = document.activeElement && document.activeElement.getAttribute
    ? document.activeElement.getAttribute('data-fund-toggle')
    : null;
  if (!data || data.length === 0) {
    list.innerHTML = '<div class="empty-hint">暂无持仓<br>在「持仓」页添加基金代码</div>';
    return;
  }

  const now = Date.now();
  data.forEach(function(fund) {
    fund.quote = normalizeExistingQuoteFreshness(fund.quote, { now });
    Object.assign(fund, holdingQuoteAmounts(fund.quote, holdings.find(holding => holding.code === fund.code), now));
  });
  var sorted = sortFunds(data);
  var html = '';

  sorted.forEach(function(f) {
    var presentation = createQuotePresentation(f.quote, { now, shares: f.shares, period: f.period });
    var displayChange = displayChangeOf(f);
    var hasEst = Number.isFinite(displayChange);
    var cc = hasEst ? (displayChange > 0 ? 'up' : displayChange < 0 ? 'down' : 'flat') : '';
    var sign = hasEst && displayChange >= 0 ? '+' : '';
    var hasToday = Number.isFinite(f.today_profit);
    var hasProfit = Number.isFinite(f.total_profit);
    var hasRate = Number.isFinite(f.total_profit_rate);
    var estimateLabel = presentation.kindLabel;
    var latestOfficialDate = presentation.officialNavDate || f.nav_date || '待更新';
    var targetNavHtml = presentation.targetNavLabel
      ? ' · 目标净值 ' + esc(presentation.targetNavLabel)
      : '';
    var trustHtml = presentation.trustText
      ? '<span class="quote-trust-copy">' + esc(presentation.trustText) + '</span>'
      : '';
    var currentNavValue = f.quote && Number.isFinite(f.quote.value) ? f.quote.value : null;
    var baseNavValue = Number.isFinite(f.primary_base_nav) ? f.primary_base_nav : null;

    var profitRateHtml = hasRate
      ? ' <span class="profit-rate ' + (f.total_profit_rate >= 0 ? 'up' : 'down') + '">' + (f.total_profit_rate >= 0 ? '+' : '') + fmt(f.total_profit_rate) + '%</span>'
      : '';

    var isExpanded = expandedFund === f.code;
    var isWatchOnly = !f.shares;
    var toggleId = 'fund-toggle-' + f.code;
    var detailId = 'fund-detail-' + f.code;

    var watchTag = isWatchOnly ? ' <span class="watch-tag">仅关注</span>' : '';

    html += '<article class="fund-card ' + cc + (isExpanded ? ' expanded' : '') + (isWatchOnly ? ' watch-only' : '') + '">';
    html += '<button type="button" class="fund-card-toggle" id="' + toggleId + '" data-action="toggle-fund" data-fund-toggle="' + esc(f.code) + '" aria-expanded="' + (isExpanded ? 'true' : 'false') + '" aria-controls="' + detailId + '" title="' + (isExpanded ? '收起数据说明与详情' : '展开数据说明与详情') + '">';
    html += '<span class="fund-main">';
    html += '<span class="fund-id"><span class="fund-name">' + esc(f.name || f.code) + watchTag + '</span><span class="fund-code">' + esc(f.code) + ' · 最新正式净值 ' + esc(latestOfficialDate) + targetNavHtml + '</span></span>';
    html += '<span class="fund-est"><span class="fund-pct ' + cc + '">' + (hasEst ? sign + fmt(displayChange) + '%' : '--') + '</span><span class="quote-binding"><span class="quote-kind">' + esc(presentation.kindLabel) + '</span><span aria-hidden="true">·</span><span class="quote-time">' + esc(presentation.dataTimeLabel) + '</span></span><span class="quote-trust"><span class="quote-status ' + presentation.statusClass + '">' + esc(presentation.statusLabel) + '</span>' + trustHtml + '</span></span>';
    html += '<span class="fund-nav"><span class="nav-cur">' + fmtQuoteNav(currentNavValue) + '</span><span class="nav-prev">' + fmtQuoteNav(baseNavValue) + '</span></span>';
    html += '</span></button>';

    if (isExpanded) {
      var estimateNote = f.est_note && !f.today_is_latest_nav ? '<div class="cache-note">' + esc(f.est_note) + '</div>' : '';
      var primaryNote = f.primary_note && f.primary_note !== f.est_note ? '<div class="cache-note">' + esc(f.primary_note) + '</div>' : '';
      var modelNote = f.today_is_latest_nav && f.est_model && Number.isFinite(f.est_change)
        ? '<div class="cache-note">下一净值模型：' + (f.est_change >= 0 ? '+' : '') + fmt(f.est_change) + '%，估算净值 ' + fmt4(f.est_nav) + '。' + esc(f.est_note || '') + '</div>'
        : '';
      var officialMove = latestNavMoveOf(f);
      var officialNote = !f.today_is_latest_nav && officialMove && Number.isFinite(officialMove.change)
        ? '<div class="cache-note">最近正式净值涨跌：' + (officialMove.change >= 0 ? '+' : '') + fmt(officialMove.change) + '%'
          + ([officialMove.prevDate, officialMove.date].filter(Boolean).length ? '（' + [officialMove.prevDate, officialMove.date].filter(Boolean).join(' → ') + '）' : '')
          + '</div>'
        : '';
      var refCols = f.shares > 0 ? 3 : 2;
      html += '<div class="holdings-detail" id="' + detailId + '">';
      html += renderQuoteDiagnostics(presentation);

      // 折叠的次要数据：盘中/上一净值（手机端，PC 已在行内列显示故隐藏）+ 持仓金额
      html += '<div class="detail-stats">';
      html += '<div class="detail-nav stats-grid" style="grid-template-columns:repeat(' + refCols + ',1fr)">';
      html += '<div><div class="stat-label">' + estimateLabel + '</div><div class="stat-val">' + fmtQuoteNav(currentNavValue) + '</div>' + primaryNote + estimateNote + modelNote + officialNote + '</div>';
      html += '<div><div class="stat-label">基准净值</div><div class="stat-val">' + fmtQuoteNav(baseNavValue) + '</div></div>';
      if (f.shares > 0) {
        html += '<div><div class="stat-label">持有份额</div><div class="stat-val">' + fmt(f.shares) + '</div></div>';
      }
      html += '</div>';
      if (f.shares > 0) {
        html += '<div class="detail-money stats-grid">';
        html += '<div><div class="stat-label">' + esc(presentation.periodLabel) + '</div><div class="stat-val money ' + (hasToday ? (f.today_profit>=0?'up':'down') : '') + '">' + (hasToday ? fmtM(f.today_profit) : '--') + '</div></div>';
        html += '<div><div class="stat-label">累计盈亏</div><div class="stat-val money ' + (hasProfit ? (f.total_profit>=0?'up':'down') : '') + '">' + (hasProfit ? fmtM(f.total_profit) + profitRateHtml : '--') + '</div></div>';
        html += '</div>';
      }
      html += '</div>';

      html += '<div class="holdings-actions"><button class="edit-holdings-btn" type="button" data-action="edit-fund" data-code="' + esc(f.code) + '">编辑持仓</button></div>';

      // 重仓股
      if (holdingsCache[f.code] === undefined) {
        html += '<div class="holdings-loading">加载重仓股...</div>';
      } else if (holdingsMetaCache[f.code]?.status === 'error') {
        html += '<div class="holdings-empty">重仓数据获取失败，重新展开可重试</div>';
      } else if (!holdingsCache[f.code] || !holdingsCache[f.code].length) {
        html += '<div class="holdings-empty">暂无公开重仓数据</div>';
      } else {
        var reportDate = holdingsMetaCache[f.code]?.reportDate || '';
        html += '<div class="holdings-table">';
        if (reportDate) html += '<div class="holdings-report-date">十大重仓 · 截止 ' + esc(reportDate) + '</div>';
        html += '<div class="holdings-header"><span>股票名称</span><span>占比</span><span>涨跌幅</span></div>';
        holdingsCache[f.code].forEach(function(s) {
          var sc = Number.isFinite(s.change) ? (s.change >= 0 ? 'up' : 'down') : '';
          html += '<div class="holdings-row"><span class="stock-name">' + esc(s.name) + '<em>' + esc(s.code) + '</em></span><span>' + fmt(s.ratio) + '%</span><span class="' + sc + '">' + (Number.isFinite(s.change) ? (s.change >= 0 ? '+' : '') + fmt(s.change) + '%' : '--') + '</span></div>';
        });
        html += '</div>';
      }

      // 基金信息 & 费率
      var hasType = fundTypeCache[f.code] !== undefined;
      var hasFee = fundFeeCache[f.code] !== undefined;
      if (!hasType && !hasFee) {
        html += '<div class="rules-section">';
        html += '<div class="rules-section-title">基金信息</div>';
        html += '<div class="rules-loading">加载中...</div>';
        html += '</div>';
      } else if (fundTypeCache[f.code] === null && fundFeeCache[f.code] === null) {
        html += '<div class="rules-section">';
        html += '<div class="rules-section-title">基金信息</div>';
        html += '<div class="rules-empty">暂无数据</div>';
        html += '</div>';
      } else {
        html += '<div class="rules-section">';
        html += '<div class="rules-section-title">基金信息</div>';
        if (fundTypeCache[f.code]) {
          var ti = fundTypeCache[f.code];
          html += '<div class="rules-table">';
          if (ti.type) html += '<div class="rules-row"><span class="rules-label">基金类型</span><span class="rules-val">' + esc(ti.type) + '</span></div>';
          if (ti.setupDate) html += '<div class="rules-row"><span class="rules-label">成立日期</span><span class="rules-val">' + esc(ti.setupDate) + '</span></div>';
          if (ti.scale) html += '<div class="rules-row"><span class="rules-label">基金规模</span><span class="rules-val">' + esc(ti.scale) + '</span></div>';
          if (ti.manager) html += '<div class="rules-row"><span class="rules-label">基金经理</span><span class="rules-val">' + esc(ti.manager + (ti.managerWorkTime ? ' · ' + ti.managerWorkTime : '')) + '</span></div>';
          if (ti.company) html += '<div class="rules-row"><span class="rules-label">管理人</span><span class="rules-val">' + esc(ti.company) + '</span></div>';
          if (ti.benchmark) html += '<div class="rules-row"><span class="rules-label">跟踪标的</span><span class="rules-val">' + esc(ti.benchmark) + '</span></div>';
          html += '</div>';
        }
        if (fundFeeCache[f.code]) {
          var fi = fundFeeCache[f.code];
          html += '<div class="rules-table" style="margin-top:6px">';
          if (fi.buyFee) html += '<div class="rules-row"><span class="rules-label">申购费率</span><span class="rules-val">' + esc(fi.buyFee) + '</span></div>';
          if (fi.sourceBuyFee && fi.sourceBuyFee !== fi.buyFee) html += '<div class="rules-row"><span class="rules-label">原申购费率</span><span class="rules-val">' + esc(fi.sourceBuyFee) + '</span></div>';
          if (fi.sellFee) html += '<div class="rules-row"><span class="rules-label">赎回费率</span><span class="rules-val">' + esc(fi.sellFee) + '</span></div>';
          if (fi.manageFee) html += '<div class="rules-row"><span class="rules-label">管理费率</span><span class="rules-val">' + esc(fi.manageFee) + '</span></div>';
          if (fi.custodyFee) html += '<div class="rules-row"><span class="rules-label">托管费率</span><span class="rules-val">' + esc(fi.custodyFee) + '</span></div>';
          html += '</div>';
        }
        html += '</div>';
      }

      html += '</div>';
    }

    html += '</article>';
  });

  list.innerHTML = html;

  if (focusedToggleCode) {
    requestAnimationFrame(function() {
      var target = document.querySelector('[data-fund-toggle="' + focusedToggleCode + '"]');
      if (target) target.focus({ preventScroll: true });
    });
  }

  updateSortBar();
}

function fmt(n)  { return isNaN(n) ? '--' : Number(n).toFixed(2); }
function fmt4(n) { return isNaN(n) ? '--' : Number(n).toFixed(4); }
function fmtM(n) {
  if (isNaN(n)) return '--';
  const s = n >= 0 ? '+' : '';
  const a = Math.abs(n);
  return s + (a >= 10000 ? (n/10000).toFixed(2)+'万' : n.toFixed(2));
}
function esc(s) {
  return String(s||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// ── 持仓编辑 ─────────────────────────────────────────────
function renderHoldingsList() {
  const list = document.getElementById('holdings-list');
  if (!holdings.filter(h => !h.deleted).length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:4px 0">暂无持仓</div>';
    return;
  }
  list.innerHTML = holdings.filter(h => !h.deleted).map(h => `
    <div class="holding-item" data-action="edit-fund" data-code="${esc(h.code)}" style="cursor:pointer">
      <div>
        <div class="h-name">${esc(h.name||h.code)}</div>
        <div class="h-detail">${h.code} · ${h.shares}份 · 成本${h.cost == null ? '未知' : h.cost}</div>
      </div>
      <button class="del-btn" type="button" data-action="delete-fund" data-code="${esc(h.code)}" aria-label="删除 ${esc(h.name || h.code)}">×</button>
    </div>`).join('');
}

function editFund(code) {
  if (isSavingHolding) return;
  if (hasUnsavedHoldingEditorInput() && !confirm('放弃当前未保存的输入？')) return;
  const fund = holdings.find(h => h.code === code);
  if (!fund) return;
  editingCode = code;
  editingSnapshot = { record: holdingsDocument?.holdings.find(row => row.fundCode === code), legacy: { ...fund } };
  document.getElementById('i-code').value = fund.code;
  document.getElementById('i-code').disabled = true;
  document.getElementById('i-name').value = fund.name !== fund.code ? fund.name : '';
  document.getElementById('i-shares').value = fund.shares;
  document.getElementById('i-cost').value = fund.cost == null ? '' : fund.cost;
  document.getElementById('add-btn').textContent = '✓ 保存修改';
  document.getElementById('cancel-edit-btn').style.display = 'block';
  switchPage('edit');
}

function cancelEdit() {
  if (isSavingHolding) return;
  editingCode = null;
  editingSnapshot = null;
  document.getElementById('i-code').value = '';
  document.getElementById('i-code').disabled = false;
  document.getElementById('i-name').value = '';
  document.getElementById('i-shares').value = '';
  document.getElementById('i-cost').value = '';
  document.getElementById('add-btn').textContent = '+ 添加';
  document.getElementById('cancel-edit-btn').style.display = 'none';
}

async function saveFund() {
  if (isSavingHolding) return;
  const code = document.getElementById('i-code').value.trim();
  const name = document.getElementById('i-name').value.trim();
  const shares = toNonNegativeNumber(document.getElementById('i-shares').value);
  const cost = toNonNegativeNumber(document.getElementById('i-cost').value, { nullable: true });
  if (!code || !/^\d{6}$/.test(code)) { showToast('请输入6位数字基金代码'); return; }
  if (shares == null) { showToast('份额必须是非负数字'); return; }
  if (cost === undefined) { showToast('成本净值需为非负数字，或留空表示未知'); return; }

  const baseline = editingCode ? editingSnapshot?.record
    : holdingsDocument?.holdings.find(row => row.fundCode === code) || null;
  isSavingHolding = true;
  const controls = ['i-code', 'i-name', 'i-shares', 'i-cost', 'add-btn', 'cancel-edit-btn'].map(id => document.getElementById(id));
  controls.forEach(input => { input.disabled = true; });
  try {
    const saved = await saveHoldingEdit({ code, baseline, operation: editingCode ? 'edit' : 'add', values: { name: name || code, shares, cost } });
    if (!saved.ok) {
      showToast(saved.reason === 'edit_conflict' ? '持仓已在别处更新，请取消编辑后重新打开，未覆盖新数据'
        : saved.reason === 'holding_exists' ? '该基金已在列表中' : '保存失败，输入已保留，原持仓未覆盖');
      return;
    }
    scheduleAutoPush();
    renderHoldingsList();
    isSavingHolding = false;
    cancelEdit();
    showToast('已保存 ' + (name || code));
    refresh();
  } catch (_) { showToast('保存失败，输入已保留'); }
  finally {
    isSavingHolding = false;
    controls.forEach(input => { input.disabled = false; });
    document.getElementById('i-code').disabled = Boolean(editingCode);
  }
}

function openScreenshotImport() {
  // OCR runs in a separate document that deliberately does not load this
  // page's third-party market JSONP scripts. It returns only after the user
  // confirms a locally saved, canonical holdings batch.
  window.location.assign('ocr-import.html');
}

async function delFund(code) {
  if (isSavingHolding) return;
  const h = holdings.find(item => item.code === code);
  if (!h || h.deleted) return;
  if (!confirm(`删除「${h.name||h.code}」？`)) return;
  const baseline = holdingsDocument?.holdings.find(row => row.fundCode === code);
  const saved = await saveHoldingEdit({ code, baseline, operation: 'delete' }).catch(() => ({ ok: false }));
  if (!saved.ok) {
    renderHoldingsList();
    showToast('删除失败或持仓已更新，请刷新后重试');
    return;
  }
  reconcileActiveFundState();
  scheduleAutoPush();
  refresh();
}

// ── 页面切换 ─────────────────────────────────────────────
let lastEditPull = 0;
function switchPage(name) {
  var page = document.getElementById('page-' + name);
  var nav = document.getElementById('nav-' + name);
  if (!page || !nav) return;
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  page.classList.add('active');
  nav.classList.add('active');
  if (name==='edit') {
    renderHoldingsList();
    renderCloudStatus();
    if (hasCloudConfig() && Date.now() - lastEditPull > TIMING.CLOUD_COOLDOWN_MS) {
      lastEditPull = Date.now();
      pullFromCloud(true);
    }
  }
  // Switching panels preserves the draft and its original conflict baseline.
}

// ── 指数行情条（腾讯 JSONP 仅在无同源存储权限的隔离 Bridge 内执行） ────
// ── 黄金 AU9999 实时金价（复刻司南基金：东方财富 push2 + 持久缓存兜底） ──
function loadGoldCache() {
  try {
    var raw = safeGetItem(GOLD_CACHE_KEY);
    var cache = raw ? JSON.parse(raw) : null;
    if (!cache || !Number.isFinite(cache.price)) return null;
    if (Date.now() - (cache.time || 0) > 7 * 24 * 60 * 60 * 1000) return null;
    return {
      name: '黄金9999', price: cache.price, changePct: cache.changePct,
      observedAt: cache.observedAt || null,
      status: 'stale', cached: true,
    };
  } catch(e) { return null; }
}


async function fetchGoldFromEastmoneySecid(secid, signal) {
  try {
    var resp = await fetchWithTimeout(
      'https://push2.eastmoney.com/api/qt/stock/get?secid=' + secid + '&fields=f43,f60,f170,f124&fltt=2&_=' + Date.now(),
      { signal: signal },
      TIMING.INDEX_JSONP_TIMEOUT
    );
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    var json = await resp.json();
    return normalizeGoldQuote(json?.data);
  } catch (error) {
    if (signal && signal.aborted) throw error;
    return null;
  }
}

async function fetchGoldFromEastmoney(signal, dispatch = operation => operation(signal)) {
  var secids = ['118.AU9999', '113.AU9999', '114.AU9999'];
  for (var i = 0; i < secids.length; i++) {
    var result = await dispatch(requestSignal => fetchGoldFromEastmoneySecid(secids[i], requestSignal));
    if (result && Number.isFinite(result.price)) return result;
  }
  return null;
}


function staleIndexItem(item, fallbackName) {
  if (!item || !Number.isFinite(item.price)) {
    return { name: fallbackName, price: NaN, changePct: NaN, observedAt: null, status: 'unavailable', cached: false };
  }
  return { ...item, name: item.name || fallbackName, status: 'stale', cached: true };
}


function renderIndexBar(data) {
  var el = document.getElementById('index-bar-inner');
  if (!el || !data.length) return;
  var html = '';
  data.forEach(function(idx) {
    var hasData = Number.isFinite(idx.price);
    var hasChange = Number.isFinite(idx.changePct);
    var cc = hasChange ? (idx.changePct > 0 ? 'up' : idx.changePct < 0 ? 'down' : 'flat') : '';
    var sign = hasChange && idx.changePct >= 0 ? '+' : '';
    var staleTag = idx.status === 'stale' ? '<span class="index-stale">旧</span>' : '';
    html += '<div class="index-item">';
    html += '<div class="index-name">' + esc(idx.name) + staleTag + '</div>';
    html += '<div class="index-price">' + (hasData ? fmtIndexPrice(idx.price) : '--') + '</div>';
    html += '<div class="index-change ' + cc + '">' + (hasChange ? sign + fmt(idx.changePct) + '%' : '--') + '</div>';
    html += '</div>';
  });
  el.innerHTML = html;
}

function fmtIndexPrice(n) {
  if (!Number.isFinite(n)) return '--';
  return Math.round(n).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}


// ── 市场状态 ─────────────────────────────────────────────
function updateMktStatus() {
  const clock = marketClock('cn');
  let s = ({ holiday: '休市', break: '午间休市', preopen: '盘前', closed: '已收盘', unknown: '交易日待确认' })[clock.marketState];
  if (clock.isTradingDay === false) s = '休市';
  if (clock.marketState === 'open') s = clock.minute < 690 ? '上午盘' : '下午盘';
  document.getElementById('mkt-status').textContent = s;
  document.getElementById('mkt-status').title = clock.calendarVersion || '交易所日历缺失或已过期，不推断交易日';
}

// ── 智能自动刷新 ─────────────────────────────────────────
function getRefreshInterval() {
  return refreshInterval(new Date());
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(function() {
    if (!document.hidden) refresh({ force: true, reason: 'timer' });
    startAutoRefresh();
  }, refreshDelayForMarkets(holdings.filter(function(h) { return !h.deleted; }).map(function(h) { return classifyFundMarket(h.name); }), new Date()));
}

// ── 下拉刷新 ─────────────────────────────────────────────
function initPullToRefresh() {
  var tip = document.getElementById('pull-refresh');
  if (!tip) return;
  var startY = 0;
  var pulling = false;
  var threshold = 72;

  window.addEventListener('touchstart', function(e) {
    if (window.scrollY > 0 || isRefreshing || !e.touches.length) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  window.addEventListener('touchmove', function(e) {
    if (!pulling || !e.touches.length) return;
    var distance = e.touches[0].clientY - startY;
    if (distance <= 0) return;
    var height = Math.min(48, distance * 0.45);
    tip.style.height = height + 'px';
    tip.textContent = distance >= threshold ? '松开刷新' : '下拉刷新';
    tip.classList.toggle('ready', distance >= threshold);
    tip.classList.add('visible');
  }, { passive: true });

  window.addEventListener('touchend', function(e) {
    if (!pulling) return;
    pulling = false;
    var endY = e.changedTouches && e.changedTouches.length ? e.changedTouches[0].clientY : startY;
    var shouldRefresh = endY - startY >= threshold;
    if (shouldRefresh) {
      tip.style.height = '34px';
      tip.textContent = '刷新中...';
      refresh({ force: true, reason: 'manual' }).finally(function() {
        tip.style.height = '0px';
        tip.classList.remove('ready', 'visible');
        tip.textContent = '下拉刷新';
      });
    } else {
      tip.style.height = '0px';
      tip.classList.remove('ready', 'visible');
      tip.textContent = '下拉刷新';
    }
  }, { passive: true });
}

// ── Toast ────────────────────────────────────────────────
function showToast(msg, ms=2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), ms);
}

let diagnosticsFeature;
async function runDiagnostics(action) {
  try {
    if (!diagnosticsFeature) diagnosticsFeature = import('./runtime/diagnostics-ui.js').then(module => module.createDiagnosticsCenter({
      getHoldings: () => holdings, getHoldingsDocument: () => holdingsDocument,
      refreshCoordinator, showToast, esc,
    }));
    return await (await diagnosticsFeature)[action]();
  } catch (_) { diagnosticsFeature = null; showToast('诊断暂不可用，请重试'); }
}
function refreshDiagnosticsCenter() { return runDiagnostics('refreshDiagnosticsCenter'); }
function copyDiagnosticsSummary() { return runDiagnostics('copyDiagnosticsSummary'); }

function holdingEditorValue(id) {
  var input = document.getElementById(id);
  return input ? String(input.value || '').trim() : '';
}

function hasUnsavedHoldingEditorInput() {
  var code = holdingEditorValue('i-code');
  var name = holdingEditorValue('i-name');
  var shares = holdingEditorValue('i-shares');
  var cost = holdingEditorValue('i-cost');
  if (!editingCode) return Boolean(code || name || shares || cost);

  var fund = editingSnapshot?.legacy;
  if (!fund) return true;
  var originalName = fund.name !== fund.code ? String(fund.name || '') : '';
  var originalShares = fund.shares == null ? '' : String(fund.shares);
  var originalCost = fund.cost == null ? '' : String(fund.cost);
  return code !== String(fund.code || '')
    || name !== originalName
    || shares !== originalShares
    || cost !== originalCost;
}

function hasUnsavedPageInput() {
  var tokenInput = document.getElementById('gist-token');
  var tokenChanged = tokenInput
    ? String(tokenInput.value || '').trim() !== String(safeGetItem(GIST_TOKEN_KEY) || '').trim()
    : false;
  return hasUnsavedHoldingEditorInput() || tokenChanged;
}

function hasServiceWorkerUpdateBlocker() {
  return hasUnsavedPageInput() || isSyncing || isSavingHolding;
}

function setupServiceWorkerUpdateChannel() {
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    var channel = new BroadcastChannel('fuyu_sw_update_v1');
    channel.addEventListener('message', function(event) {
      var message = event.data || {};
      if (message.type !== 'prepare' || !message.requestId || !hasServiceWorkerUpdateBlocker()) return;
      channel.postMessage({ type: 'blocked', requestId: message.requestId });
    });
    return channel;
  } catch (_) {
    return null;
  }
}

async function otherPageBlocksServiceWorkerUpdate() {
  if (!serviceWorkerUpdateChannel) return false;
  var requestId = 'sw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  var blocked = false;
  function onMessage(event) {
    var message = event.data || {};
    if (message.type === 'blocked' && message.requestId === requestId) blocked = true;
  }
  serviceWorkerUpdateChannel.addEventListener('message', onMessage);
  serviceWorkerUpdateChannel.postMessage({ type: 'prepare', requestId: requestId });
  await new Promise(function(resolve) { setTimeout(resolve, 450); });
  serviceWorkerUpdateChannel.removeEventListener('message', onMessage);
  return blocked;
}

function showServiceWorkerUpdate(worker) {
  if (worker) pendingServiceWorker = worker;
  var banner = document.getElementById('update-banner');
  var text = document.getElementById('update-banner-text');
  var button = document.getElementById('update-now-btn');
  if (!banner || !text || !button || !pendingServiceWorker) return;
  banner.hidden = false;
  text.textContent = serviceWorkerReloadPending
    ? '新版本已激活；保存当前输入后重新载入'
    : (hasServiceWorkerUpdateBlocker()
      ? (isSyncing ? '新版本已就绪；云同步完成后即可更新' : '新版本已就绪；请先保存或清空当前输入')
      : '新版本已就绪，可安全更新');
  button.disabled = false;
  button.textContent = serviceWorkerReloadPending ? '重新载入' : '安全更新';
}

function handleActivatedServiceWorker(worker) {
  if (reloadingForServiceWorkerUpdate) return;
  if (hasServiceWorkerUpdateBlocker()) {
    serviceWorkerReloadPending = true;
    serviceWorkerUpdateApplying = false;
    pendingServiceWorker = worker || navigator.serviceWorker.controller;
    showServiceWorkerUpdate(pendingServiceWorker);
    showToast('新版本已激活；当前输入已保留，请保存后重新载入', 7000);
    return;
  }
  reloadingForServiceWorkerUpdate = true;
  pendingServiceWorker = null;
  location.reload();
}

async function applyPendingServiceWorkerUpdate() {
  var worker = pendingServiceWorker;
  if ((!worker && !serviceWorkerReloadPending) || serviceWorkerUpdateApplying) return;
  var text = document.getElementById('update-banner-text');
  var button = document.getElementById('update-now-btn');
  if (hasServiceWorkerUpdateBlocker()) {
    if (text) text.textContent = isSyncing
      ? '云同步仍在进行，完成后才能安全更新'
      : '为避免丢失，请先保存或清空当前输入';
    showToast(isSyncing ? '云同步进行中，已暂停更新' : '当前页面有未保存输入，已暂停更新');
    return;
  }

  if (serviceWorkerReloadPending) {
    serviceWorkerUpdateApplying = true;
    location.reload();
    return;
  }
  if (await otherPageBlocksServiceWorkerUpdate()) {
    if (text) text.textContent = '其他已打开页面有未保存输入，更新已暂停';
    showToast('请先处理其他页面中的未保存输入');
    return;
  }

  serviceWorkerUpdateApplying = true;
  if (autoRefreshTimer) {
    clearTimeout(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (text) text.textContent = '正在停止旧刷新任务并更新…';
  if (button) {
    button.disabled = true;
    button.textContent = '更新中';
  }
  try {
    await refreshCoordinator.stopAndDrain('service-worker-update');
    if (hasServiceWorkerUpdateBlocker()) {
      serviceWorkerUpdateApplying = false;
      showServiceWorkerUpdate(worker);
      if (text) text.textContent = '检测到未保存编辑，更新仍已暂停';
      startAutoRefresh();
      return;
    }
    worker.postMessage({ type: 'SKIP_WAITING' });
  } catch (_) {
    serviceWorkerUpdateApplying = false;
    showServiceWorkerUpdate(worker);
    if (text) text.textContent = '安全更新未完成，可稍后重试';
    startAutoRefresh();
  }
}

function consumeOcrImportReturn() {
  var returned = false;
  try {
    var url = new URL(window.location.href);
    returned = url.searchParams.get('ocr_import') === '1';
    if (returned) {
      url.searchParams.delete('ocr_import');
      window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
    }
  } catch (_) {}
  const pending = safeGetItem(OCR_IMPORT_PENDING_KEY) === '1';
  if (pending) safeRemoveItem(OCR_IMPORT_PENDING_KEY);
  return returned || pending;
}

// ── Service Worker（含自动更新检测） ──────────────────────
if ('serviceWorker' in navigator) {
  serviceWorkerUpdateChannel = setupServiceWorkerUpdateChannel();
  navigator.serviceWorker.register('sw.js').then(function(reg) {
    if (reg.waiting && navigator.serviceWorker.controller) showServiceWorkerUpdate(reg.waiting);
    // 监听新版本安装完成
    reg.addEventListener('updatefound', function() {
      var newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', function() {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showServiceWorkerUpdate(newWorker);
        }
      });
    });
    // 每 30 分钟主动检查更新
    setInterval(function() { reg.update(); }, TIMING.SW_UPDATE_MS);
  }).catch(function() {});
  navigator.serviceWorker.addEventListener('message', function(event) {
    var message = event.data || {};
    if (message.type === 'UPDATE_ACTIVATED') handleActivatedServiceWorker(event.source);
  });
  navigator.serviceWorker.addEventListener('controllerchange', function() {
    handleActivatedServiceWorker(navigator.serviceWorker.controller);
  });
}

// ── 页面可见性：切回标签页立即拉取（30s 冷却） ──────────
let lastVisibilityPull = 0;
document.addEventListener('visibilitychange', function() {
  if (document.hidden) {
    clearTimeout(autoRefreshTimer);
    return;
  }
  startAutoRefresh();
  refresh({ force: true, reason: 'visibility' });
  if (!document.hidden && hasCloudConfig() && Date.now() - lastVisibilityPull > TIMING.CLOUD_COOLDOWN_MS) {
    lastVisibilityPull = Date.now();
    pullFromCloud(true);
  }
});

// ── 初始化 ───────────────────────────────────────────────
function handleAppAction(event) {
  const target = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
  if (!target) return;
  const action = target.dataset.action;
  if (!action) return;
  event.preventDefault();
  if (action === 'apply-update') applyPendingServiceWorkerUpdate();
  else if (action === 'toggle-sort') toggleEstSort();
  else if (action === 'open-ocr') openScreenshotImport();
  else if (action === 'save-fund') saveFund();
  else if (action === 'cancel-edit') cancelEdit();
  else if (action === 'cloud-upload') uploadToCloud();
  else if (action === 'cloud-download') downloadFromCloud();
  else if (action === 'restore-backup') restoreLatestBackup();
  else if (action === 'clear-cloud') clearCloudConfig();
  else if (action === 'export-data') exportData();
  else if (action === 'pick-import') document.getElementById('imp-file')?.click();
  else if (action === 'refresh-diagnostics') refreshDiagnosticsCenter();
  else if (action === 'copy-diagnostics') copyDiagnosticsSummary();
  else if (action === 'enable-notifications') enableDailyNotifications();
  else if (action === 'switch-page') switchPage(target.dataset.page);
  else if (action === 'toggle-fund') toggleFundDetail(target.dataset.fundToggle);
  else if (action === 'edit-fund') editFund(target.dataset.code);
  else if (action === 'delete-fund') delFund(target.dataset.code);
}

function initActionBindings() {
  document.addEventListener('click', handleAppAction);
  document.getElementById('imp-file')?.addEventListener('change', importData);
  document.getElementById('diagnostics-center')?.addEventListener('toggle', function(event) {
    if (event.currentTarget.open) refreshDiagnosticsCenter();
  });
}

initActionBindings();

window.addEventListener('beforeunload', function(event) {
  if (!hasServiceWorkerUpdateBlocker()) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener('pagehide', function(event) {
  if (!event.persisted && quoteBridge) quoteBridge.destroy();
}, { once: true });

window.addEventListener('online', function() {
  refresh({ force: true, reason: 'online' });
  if (hasPendingSync()) scheduleAutoPush();
});

var returnedFromOcrImport = consumeOcrImportReturn();
await loadHoldings();
document.documentElement.dataset.appReady = 'true';
if (holdingsStorageError) {
  showToast('持仓存储校验失败，已停止写入，请先使用备份恢复');
}
var appVersionLabel = document.getElementById('app-version-label');
if (appVersionLabel) appVersionLabel.textContent = APP_VERSION;
updateMktStatus();
setInterval(updateMktStatus, TIMING.MKT_STATUS_MS);
tryShowCache();
overseasModelsPromise = loadOverseasModels().catch(function() { return getOverseasConfig(); });
if (returnedFromOcrImport) {
  renderHoldingsList();
  scheduleAutoPush();
  showToast('截图导入已保存，正在刷新估值');
  refresh({ force: true, reason: 'ocr-import' });
} else {
  refresh({ force: true, reason: 'startup' });
}
startAutoRefresh();
initPullToRefresh();
scheduleNotificationFeature();
autoPullOnLoad();
startAutoPull();
if (getGistToken()) document.getElementById('gist-token').value = getGistToken();
