import { normalizeHoldingsDocumentV3 } from '../storage/holdings-schema.js';
import { loadHoldingsRepository, saveLegacyHoldingsTransaction, withHoldingsLock } from '../storage/holdings-repository.js';
import { applyHoldingImportPlan, validateHoldingImportPlan } from '../holding-import-plan.js';

// The baseline is captured when candidates are shown, never re-based at click
// time. Compare only selected identities so unrelated new holdings survive.
export function validateImportBaseline(baseline, current, rows) {
  let before;
  let after;
  try {
    before = normalizeHoldingsDocumentV3(baseline).holdings;
    after = normalizeHoldingsDocumentV3(current).holdings;
  } catch {
    return { ok: false, reason: 'missing_import_baseline' };
  }
  const validation = validateHoldingImportPlan(rows);
  if (!validation.ok) return validation;
  for (const { code } of validation.values) {
    const previous = before.find(item => item.fundCode === code) || null;
    const latest = after.find(item => item.fundCode === code) || null;
    if (JSON.stringify(previous) !== JSON.stringify(latest) || latest?.deletedAt) {
      return { ok: false, reason: 'stale_local_document' };
    }
  }
  return { ok: true };
}

export async function commitConfirmedImport(storage, rows, baseline, { cacheKey, locks, beforeSave } = {}) {
  return withHoldingsLock(() => {
    const loaded = loadHoldingsRepository(storage, { cacheKey });
    if (!loaded.ok) return loaded;
    const checked = validateImportBaseline(baseline, loaded.document, rows);
    if (!checked.ok) return checked;
    const result = applyHoldingImportPlan(loaded.legacy, rows);
    if (!result.ok || !result.applied) return result;
    if (beforeSave && beforeSave() !== true) return { ok: false, reason: 'pending_flag_failed' };
    const saved = saveLegacyHoldingsTransaction(storage, result.holdings, {
      cacheKey,
      expectedDocument: loaded.document,
    });
    return { ...saved, applied: saved.ok ? result.applied : 0 };
  }, { locks });
}
