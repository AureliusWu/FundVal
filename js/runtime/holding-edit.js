import { holdingRecordFingerprint } from '../storage/holdings-schema.js';
import { loadHoldingsRepository, saveLegacyHoldingsTransaction, withHoldingsLock } from '../storage/holdings-repository.js';

// Compare the record the user actually saw, not a baseline refreshed by cloud sync.
export async function commitHoldingEdit(storage, edit, options = {}) {
  return withHoldingsLock(() => {
    if (edit.signal?.aborted) return { ok: false, reason: 'edit_cancelled' };
    const loaded = loadHoldingsRepository(storage, options);
    if (!loaded.ok) return loaded;
    const current = loaded.document.holdings.find(row => row.fundCode === edit.code) || null;
    const fingerprint = row => row ? holdingRecordFingerprint(row) : null;
    if (fingerprint(current) !== fingerprint(edit.baseline)) {
      return { ok: false, reason: 'edit_conflict', document: loaded.document, legacy: loaded.legacy };
    }
    if (edit.operation !== 'add' && (!current || current.deletedAt)) return { ok: false, reason: 'edit_conflict' };
    if (edit.operation === 'add' && current && !current.deletedAt) return { ok: false, reason: 'holding_exists' };
    const candidate = loaded.legacy.map(row => ({ ...row }));
    let row = candidate.find(item => item.code === edit.code);
    if (!row) { row = { code: edit.code }; candidate.push(row); }
    if (edit.operation === 'delete') row.deleted = true;
    else Object.assign(row, edit.values, { code: edit.code, deleted: false });
    row.updated_at = new Date(options.now || Date.now()).toISOString();
    return saveLegacyHoldingsTransaction(storage, candidate, {
      ...options, expectedDocument: loaded.document,
      allowRestoreCodes: edit.operation === 'add' && current?.deletedAt ? [edit.code] : [],
    });
  }, options);
}
