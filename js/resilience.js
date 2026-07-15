import {
  appendDiagnostic,
  collectOrphanNavCacheKeys,
  reconcileFundCache,
  repairHoldingsState,
  safeJsonParse
} from './integrity.js';

const HOLDINGS_KEY = 'fuyu_holdings_v1';
const FUNDS_CACHE_KEY = 'fuyu_funds_cache_v1';
const LATEST_BACKUP_KEY = 'fuyu_backup_latest';
const PREVIOUS_BACKUP_KEY = 'fuyu_backup_previous';
const CORRUPT_HOLDINGS_KEY = 'fuyu_corrupt_holdings_last_v1';
const DIAGNOSTICS_KEY = 'fuyu_diagnostics_v1';
const RECOVERY_NOTICE_KEY = 'fuyu_recovery_notice_v1';

function safeGet(storage, key) {
  try { return storage.getItem(key); }
  catch (_) { return null; }
}

function safeSet(storage, key, value) {
  try { storage.setItem(key, value); return true; }
  catch (_) { return false; }
}

function safeRemove(storage, key) {
  try { storage.removeItem(key); return true; }
  catch (_) { return false; }
}

function storageKeys(storage) {
  const keys = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
  } catch (_) {}
  return keys;
}

function rememberDiagnostic(storage, entry) {
  const diagnostics = appendDiagnostic(safeGet(storage, DIAGNOSTICS_KEY), entry);
  safeSet(storage, DIAGNOSTICS_KEY, JSON.stringify(diagnostics));
}

function showSystemToast(message, { reloadOnClick = false, duration = 6000 } = {}) {
  const render = () => {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    if (reloadOnClick) {
      toast.style.cursor = 'pointer';
      toast.onclick = () => location.reload();
    }
    setTimeout(() => {
      toast.classList.remove('show');
      if (reloadOnClick) {
        toast.onclick = null;
        toast.style.cursor = '';
      }
    }, duration);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
  else render();
}

export function runStartupIntegrityChecks(storage = localStorage, now = Date.now()) {
  const nowISO = new Date(now).toISOString();
  const primaryRaw = safeGet(storage, HOLDINGS_KEY);
  const result = repairHoldingsState({
    primaryRaw,
    latestBackupRaw: safeGet(storage, LATEST_BACKUP_KEY),
    previousBackupRaw: safeGet(storage, PREVIOUS_BACKUP_KEY),
    nowISO
  });

  if (result.corruptRaw) safeSet(storage, CORRUPT_HOLDINGS_KEY, result.corruptRaw);
  if (result.changed) safeSet(storage, HOLDINGS_KEY, JSON.stringify(result.holdings));
  if (result.recovered) {
    safeSet(storage, RECOVERY_NOTICE_KEY, JSON.stringify({ time: nowISO, source: result.source }));
    rememberDiagnostic(storage, {
      time: nowISO,
      type: 'storage_recovery',
      message: `holdings recovered from ${result.source}`
    });
  }

  const activeCodes = new Set(result.holdings.filter(item => !item.deleted).map(item => item.code));
  const cacheResult = reconcileFundCache(safeGet(storage, FUNDS_CACHE_KEY), activeCodes, now);
  if (cacheResult.remove) safeRemove(storage, FUNDS_CACHE_KEY);
  else if (cacheResult.changed) safeSet(storage, FUNDS_CACHE_KEY, JSON.stringify(cacheResult.cache));

  const orphanKeys = collectOrphanNavCacheKeys(storageKeys(storage), activeCodes);
  orphanKeys.forEach(key => safeRemove(storage, key));

  return {
    holdings: result.holdings,
    recovered: result.recovered,
    recoverySource: result.source,
    cacheRepaired: cacheResult.changed,
    orphanCacheCount: orphanKeys.length
  };
}

export function installRuntimeGuards(storage = localStorage) {
  window.addEventListener('error', event => {
    rememberDiagnostic(storage, {
      type: 'window_error',
      message: event.message || 'Unknown window error',
      stack: event.error && event.error.stack || ''
    });
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    rememberDiagnostic(storage, {
      type: 'unhandled_rejection',
      message: reason && reason.message || reason || 'Unhandled promise rejection',
      stack: reason && reason.stack || ''
    });
  });

  window.addEventListener('storage', event => {
    if (event.key !== HOLDINGS_KEY) return;
    runStartupIntegrityChecks(storage);
    showSystemToast('检测到其他页面更新持仓，点击刷新', { reloadOnClick: true, duration: 10000 });
  });

  window.addEventListener('offline', () => {
    document.documentElement.dataset.network = 'offline';
    showSystemToast('网络已断开，当前继续显示本地缓存');
  });

  window.addEventListener('online', () => {
    document.documentElement.dataset.network = 'online';
    showSystemToast('网络已恢复，行情将自动刷新');
  });

  const notice = safeJsonParse(safeGet(storage, RECOVERY_NOTICE_KEY), null);
  if (notice) {
    safeRemove(storage, RECOVERY_NOTICE_KEY);
    showSystemToast('检测到本地数据异常，已自动从备份恢复', { duration: 9000 });
  }
}
