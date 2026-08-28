import { safeGetItem, safeRemoveItem, safeSetItem } from './storage.js';

// This migration previously created a tombstone and attempted a cloud sync as
// soon as the module loaded. That behavior is retired: user holdings are never
// changed by this module, and cloud operations belong to an explicit sync flow.
export const LEGACY_MIGRATION_KEY = 'fuyu_migration_remove_017811_v1';
export const LEGACY_CLOUD_PENDING_KEY = 'fuyu_migration_remove_017811_cloud_pending_v1';
export const MIGRATION_REVIEW_KEY = 'fuyu_migration_review_required_v15';
export const RETIRED_MIGRATION_STATE = 'retired_v15';

function toIso(now) {
  const timestamp = now instanceof Date ? now.getTime() : Number(now);
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function makeReviewMarker(now) {
  return {
    version: 15,
    type: 'legacy_cloud_sync_pending',
    detected_at: toIso(now),
    action: 'manual_review_required',
    canonical_holdings_untouched: true
  };
}

/**
 * Retire legacy startup migration markers without changing holdings.
 *
 * `transaction` is deliberately accepted but never invoked here. Any future
 * holdings migration must be an explicit, user-confirmed transaction owned by
 * its caller; this compatibility cleanup is intentionally metadata-only.
 */
export function runLocalMigrations({ storage, now = Date.now(), transaction } = {}) {
  void transaction;

  const legacyPending = safeGetItem(LEGACY_CLOUD_PENDING_KEY, storage) === '1';
  const previousState = safeGetItem(LEGACY_MIGRATION_KEY, storage);
  const result = {
    ok: true,
    canonicalHoldingsChanged: false,
    reviewRequired: legacyPending,
    reviewMarkerWritten: false,
    legacyPendingCleared: false,
    migrationRetired: false
  };

  if (legacyPending) {
    const marker = JSON.stringify(makeReviewMarker(now));
    result.reviewMarkerWritten = safeSetItem(MIGRATION_REVIEW_KEY, marker, storage);
    if (!result.reviewMarkerWritten) {
      result.ok = false;
      return result;
    }

    result.legacyPendingCleared = safeRemoveItem(LEGACY_CLOUD_PENDING_KEY, storage);
    if (!result.legacyPendingCleared) result.ok = false;
  }

  if (previousState !== RETIRED_MIGRATION_STATE) {
    result.migrationRetired = safeSetItem(LEGACY_MIGRATION_KEY, RETIRED_MIGRATION_STATE, storage);
    if (!result.migrationRetired) result.ok = false;
  }

  return result;
}
