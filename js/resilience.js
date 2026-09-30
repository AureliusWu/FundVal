import {
  appendDiagnostic,
  collectOrphanNavCacheKeys,
  reconcileFundCache,
  safeJsonParse
} from './integrity.js';
import {
  HOLDINGS_JOURNAL_KEY,
  HOLDINGS_V1_COMPAT_KEY,
  HOLDINGS_V3_KEY,
  loadHoldingsRepository,
  recoverPendingRepositoryTransaction,
  withHoldingsLock,
} from './storage/holdings-repository.js';

const FUNDS_CACHE_KEY = 'fuyu_funds_cache_v1';
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

/** Synchronous implementation; browser callers must already hold the repository lock. */
export function runStartupIntegrityChecks(storage = localStorage, now = Date.now()) {
  const nowISO = new Date(now).toISOString();
  const originalHoldingsRaw = safeGet(storage, HOLDINGS_V3_KEY)
    || safeGet(storage, HOLDINGS_V1_COMPAT_KEY)
    || '';
  const recovery = recoverPendingRepositoryTransaction(storage);
  const loaded = recovery.ok
    ? loadHoldingsRepository(storage, { now })
    : { ok: false, reason: recovery.reason, recovered: false, legacy: [] };

  if (!loaded.ok) {
    if (loaded.reason === 'future_schema_readonly') {
      // Older code must not even rotate backups/diagnostic copies of a newer
      // document: preserving all original bytes takes precedence over repair.
      return {
        holdings: [], recovered: false, recoverySource: loaded.reason,
        preservePrimary: true, cacheRepaired: false, orphanCacheCount: 0,
        transactionBlocked: true, readonly: true,
      };
    }
    const corruptRaw = safeGet(storage, HOLDINGS_V3_KEY) || safeGet(storage, HOLDINGS_V1_COMPAT_KEY) || '';
    if (corruptRaw) safeSet(storage, CORRUPT_HOLDINGS_KEY, String(corruptRaw).slice(0, 50000));
    safeSet(storage, RECOVERY_NOTICE_KEY, JSON.stringify({ time: nowISO, source: loaded.reason, manual: true }));
    rememberDiagnostic(storage, {
      time: nowISO,
      type: 'storage_transaction_blocked',
      message: `holdings repository blocked: ${loaded.reason || 'unknown'}`
    });
    return {
      holdings: [],
      recovered: false,
      recoverySource: loaded.reason || 'repository_blocked',
      preservePrimary: true,
      cacheRepaired: false,
      orphanCacheCount: 0,
      transactionBlocked: true,
    };
  }

  if (loaded.recovered) {
    if (originalHoldingsRaw) safeSet(storage, CORRUPT_HOLDINGS_KEY, String(originalHoldingsRaw).slice(0, 50000));
    safeSet(storage, RECOVERY_NOTICE_KEY, JSON.stringify({ time: nowISO, source: loaded.reason }));
    rememberDiagnostic(storage, {
      time: nowISO,
      type: 'storage_recovery',
      message: `holdings recovered from ${loaded.reason}`
    });
  }

  const resultHoldings = loaded.legacy || [];
  const activeCodes = new Set(resultHoldings.filter(item => !item.deleted).map(item => item.code));
  const cacheResult = reconcileFundCache(safeGet(storage, FUNDS_CACHE_KEY), activeCodes, now);
  if (cacheResult.remove) safeRemove(storage, FUNDS_CACHE_KEY);
  else if (cacheResult.changed) safeSet(storage, FUNDS_CACHE_KEY, JSON.stringify(cacheResult.cache));

  const orphanKeys = collectOrphanNavCacheKeys(storageKeys(storage), activeCodes);
  orphanKeys.forEach(key => safeRemove(storage, key));

  return {
    holdings: resultHoldings,
    recovered: Boolean(loaded.recovered),
    recoverySource: loaded.reason,
    preservePrimary: false,
    cacheRepaired: cacheResult.changed,
    orphanCacheCount: orphanKeys.length,
    transactionBlocked: false,
  };
}

export function runStartupIntegrityChecksLocked(storage = localStorage, now = Date.now(), options = {}) {
  return withHoldingsLock(() => runStartupIntegrityChecks(storage, now), options);
}

export function installRuntimeGuards(storage = localStorage) {
  document.documentElement.dataset.network = navigator.onLine === false ? 'offline' : 'online';

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
    if (![HOLDINGS_V1_COMPAT_KEY, HOLDINGS_V3_KEY, HOLDINGS_JOURNAL_KEY].includes(event.key)) return;
    // Other renderers may not yet have received every transaction key. A
    // notification is not authority to recover or roll back that mixed view.
    // Keep recovery at explicit startup/transaction entry points, never here.
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
    showSystemToast(notice.manual
      ? '检测到本地持仓字段异常，原始数据已保留，请从备份恢复或重新导入。'
      : '检测到本地数据异常，已自动从备份恢复', { duration: 9000 });
  }
}
