import { safeGetItem } from '../storage.js';
import { HOLDINGS_SCHEMA_VERSION, canonicalHoldingsDocument } from '../storage/holdings-schema.js';
import { mergeParsedHoldings, parseAndMigrateHoldings } from '../storage/holdings-migration.js';
import { HOLDINGS_BACKUP_LATEST_KEY, HOLDINGS_V3_KEY, HOLDINGS_V1_COMPAT_KEY, persistHoldingsDocument, withHoldingsLock } from '../storage/holdings-repository.js';

export function createHoldingsTransfer({ getHoldingsDocument, getHoldings, installHoldingsDocument, scheduleAutoPush, renderHoldingsList, refresh, showToast, CACHE_KEY }) {
  async function exportData() {
    const { loadAccuracy } = await import('../accuracy.js');
    if (!getHoldingsDocument()) { showToast('持仓数据未通过校验，无法导出'); return; }
    const blob = new Blob([JSON.stringify({
      ...JSON.parse(canonicalHoldingsDocument(getHoldingsDocument())),
      overseasAccuracy: loadAccuracy()
    }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fuyu-holdings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast('已导出持仓文件');
  }

  function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const migrated = parseAndMigrateHoldings(parsed);
        if (!migrated.ok || migrated.readonly || !migrated.document) throw new Error('invalid holdings document');
        if (migrated.empty) {
          showToast('空持仓文件不会自动覆盖现有数据');
          return;
        }
        if (!getHoldingsDocument()) throw new Error('local holdings unavailable');
        const expectedDocument = getHoldingsDocument();
        const merged = mergeParsedHoldings({
          ok: true,
          sourceSchema: 3,
          readonly: false,
          document: expectedDocument,
        }, migrated, { deviceId: expectedDocument.deviceId });
        const saved = await withHoldingsLock(() => persistHoldingsDocument(undefined, merged.document, {
          cacheKey: CACHE_KEY,
          expectedDocument,
        }));
        if (!saved.ok) { showToast('导入保存失败，持仓未覆盖，请刷新后重试'); return; }
        installHoldingsDocument(saved.document);
        scheduleAutoPush();
        renderHoldingsList();
        showToast('已安全合并导入文件，共 ' + getHoldings().length + ' 条');
        refresh();
      } catch (_) { showToast('文件格式错误'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function isFutureSchema(value) {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      const schema = Number(parsed?.schema);
      return Number.isSafeInteger(schema) && schema > HOLDINGS_SCHEMA_VERSION;
    } catch (_) { return false; }
  }

  async function restoreLatestBackup() {
    try {
      const expectedDocument = getHoldingsDocument();
      // A damaged document has no canonical CAS baseline. Capture raw bytes
      // before waiting so a repair by another tab cannot be overwritten.
      const storage = globalThis.localStorage;
      const keys = [HOLDINGS_V3_KEY, HOLDINGS_V1_COMPAT_KEY];
      const expectedRaw = keys.map(key => storage.getItem(key));
      const saved = await withHoldingsLock(() => {
        if (keys.some((key, index) => storage.getItem(key) !== expectedRaw[index])) {
          return { ok: false, reason: 'restore_conflict' };
        }
        const readBackup = key => {
          try { return JSON.parse(safeGetItem(key) || 'null'); }
          catch (_) { return null; }
        };
        const repositoryBackup = readBackup(HOLDINGS_BACKUP_LATEST_KEY);
        const legacyBackup = readBackup('fuyu_backup_latest');
        // A newer authoritative backup must not silently fall through to its
        // lossy old compatibility projection (or an unrelated older backup).
        if ([repositoryBackup, repositoryBackup?.v3Raw, repositoryBackup?.v1Raw, legacyBackup].some(isFutureSchema)) {
          return { ok: false, reason: 'backup_future_schema' };
        }
        const parsed = [
          repositoryBackup?.v3Raw,
          repositoryBackup?.v1Raw,
          legacyBackup?.holdings,
        ].map(candidate => parseAndMigrateHoldings(candidate))
          .find(result => result.ok && !result.readonly && result.document);
        if (!parsed?.ok || parsed.readonly || !parsed.document) return { ok: false, reason: 'backup_invalid' };
        return persistHoldingsDocument(storage, parsed.document, {
          cacheKey: CACHE_KEY,
          expectedDocument,
        });
      });
      if (!saved.ok) throw new Error(saved.reason || 'restore_failed');
      installHoldingsDocument(saved.document);
      renderHoldingsList();
      scheduleAutoPush();
      refresh();
      showToast('已恢复最近备份');
    } catch (error) {
      showToast(error?.message === 'backup_future_schema'
        ? '备份由较新版本创建，已停止恢复，请更新应用后重试'
        : error?.message === 'restore_conflict' ? '其他页面已更新持仓，请刷新后重新确认恢复'
        : '备份恢复失败，请检查可用备份及存储权限');
    }
  }

  return { exportData, importData, restoreLatestBackup };
}
