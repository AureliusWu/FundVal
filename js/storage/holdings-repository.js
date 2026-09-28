import {
  HOLDINGS_SCHEMA_VERSION,
  HoldingSchemaError,
  canonicalHoldingsDocument,
  createEmptyHoldingsDocument,
  normalizeHoldingRecordV3,
  normalizeHoldingTimestamp,
  normalizeHoldingsDocumentV3,
  stableHoldingId,
  toLegacyHoldings,
} from './holdings-schema.js';
import { mergeParsedHoldings, parseAndMigrateHoldings } from './holdings-migration.js';

export const HOLDINGS_V3_KEY = 'fuyu_holdings_v3';
export const HOLDINGS_V1_COMPAT_KEY = 'fuyu_holdings_v1';
export const HOLDINGS_DEVICE_KEY = 'fuyu_device_id_v1';
export const HOLDINGS_BACKUP_LATEST_KEY = 'fuyu_holdings_repository_backup_latest_v1';
export const HOLDINGS_BACKUP_PREVIOUS_KEY = 'fuyu_holdings_repository_backup_previous_v1';
export const HOLDINGS_JOURNAL_KEY = 'fuyu_holdings_repository_journal_v1';
export const HOLDINGS_PROJECTION_META_KEY = 'fuyu_holdings_projection_meta_v1';
export const HOLDINGS_CLOUD_BACKUP_LATEST_KEY = 'fuyu_holdings_cloud_backup_latest_v1';
export const HOLDINGS_CLOUD_BACKUP_PREVIOUS_KEY = 'fuyu_holdings_cloud_backup_previous_v1';
const LEGACY_BACKUP_KEYS = ['fuyu_backup_latest', 'fuyu_backup_previous'];
export const HOLDINGS_LOCK_NAME = 'fuyu_holdings_repository_v1';

/**
 * Every browser entry point must hold this origin-wide lock while calling the
 * synchronous repository helpers below (including reads that may recover or
 * migrate). Keep callbacks short and local: never wait for a network request,
 * and never recursively acquire this non-reentrant lock. Unsupported browsers
 * fail closed rather than substituting a process-local promise/mutex.
 */
export async function withHoldingsLock(callback, { locks = globalThis.navigator?.locks } = {}) {
  if (typeof locks?.request !== 'function') {
    return { ok: false, reason: 'storage_lock_unavailable', document: null, legacy: [] };
  }
  if (typeof callback !== 'function') return { ok: false, reason: 'storage_transaction_invalid' };
  let entered = false;
  try {
    return await locks.request(HOLDINGS_LOCK_NAME, { mode: 'exclusive' }, async lock => {
      if (!lock) return { ok: false, reason: 'storage_lock_unavailable', document: null, legacy: [] };
      entered = true;
      return await callback();
    });
  } catch (_) {
    return {
      ok: false,
      reason: entered ? 'storage_transaction_failed' : 'storage_lock_failed',
      document: null,
      legacy: [],
    };
  }
}

function defaultStorage() {
  try { return globalThis.localStorage; }
  catch (_) { return null; }
}

function get(storage, key) {
  try { return storage?.getItem(key) ?? null; }
  catch (_) { return null; }
}

function set(storage, key, value) {
  try { storage?.setItem(key, value); return Boolean(storage); }
  catch (_) { return false; }
}

function remove(storage, key) {
  try { storage?.removeItem(key); return Boolean(storage); }
  catch (_) { return false; }
}

function restoreRaw(storage, key, value) {
  return value == null ? remove(storage, key) : set(storage, key, value);
}

function futureSchema(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    const schema = Array.isArray(value) ? 1 : Number(value?.schema);
    return Number.isSafeInteger(schema) && schema > HOLDINGS_SCHEMA_VERSION ? schema : null;
  } catch (_) { return null; }
}

function futureRepositorySchema(storage) {
  return futureSchema(get(storage, HOLDINGS_V3_KEY))
    || futureSchema(get(storage, HOLDINGS_V1_COMPAT_KEY));
}

function readonlyFailure(schema) {
  return {
    ok: false, state: 'blocked', reason: 'future_schema_readonly', readonly: true,
    sourceSchema: schema, document: null, legacy: [],
  };
}

function nowISO(now) {
  const value = typeof now === 'function' ? now() : now;
  const normalized = value instanceof Date
    ? value.toISOString()
    : (typeof value === 'number' ? new Date(value).toISOString() : (value || new Date().toISOString()));
  return normalizeHoldingTimestamp(normalized, 'now');
}

function generatedDeviceId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return `device:${globalThis.crypto.randomUUID()}`;
  } catch (_) {}
  return `device:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function getOrCreateDeviceId(storage = defaultStorage(), generate = generatedDeviceId) {
  const existing = String(get(storage, HOLDINGS_DEVICE_KEY) || '').trim();
  if (existing) return existing;
  const created = String(generate()).trim().slice(0, 120);
  if (!created) throw new HoldingSchemaError('device_id_failed', 'could not create a stable device id');
  if (!set(storage, HOLDINGS_DEVICE_KEY, created) || get(storage, HOLDINGS_DEVICE_KEY) !== created) {
    throw new HoldingSchemaError('device_id_persist_failed', 'could not persist the device id');
  }
  return created;
}

export function backupRepositoryState(storage = defaultStorage(), options = {}) {
  if (futureRepositorySchema(storage)) return false;
  const bundle = JSON.stringify({
    createdAt: nowISO(options.now),
    v3Raw: get(storage, HOLDINGS_V3_KEY),
    v1Raw: get(storage, HOLDINGS_V1_COMPAT_KEY),
  });
  const latest = get(storage, HOLDINGS_BACKUP_LATEST_KEY);
  if (latest != null && !set(storage, HOLDINGS_BACKUP_PREVIOUS_KEY, latest)) return false;
  if (!set(storage, HOLDINGS_BACKUP_LATEST_KEY, bundle)) return false;
  return get(storage, HOLDINGS_BACKUP_LATEST_KEY) === bundle;
}

export function backupCloudSyncSnapshot(storage = defaultStorage(), snapshot, options = {}) {
  const schema = futureRepositorySchema(storage);
  if (schema) return readonlyFailure(schema);
  let raw;
  try {
    raw = JSON.stringify({
      version: 1,
      createdAt: nowISO(options.now),
      snapshot,
    });
  } catch (_) {
    return { ok: false, reason: 'cloud_backup_serialize_failed' };
  }
  const latest = get(storage, HOLDINGS_CLOUD_BACKUP_LATEST_KEY);
  if (latest != null && (!set(storage, HOLDINGS_CLOUD_BACKUP_PREVIOUS_KEY, latest)
    || get(storage, HOLDINGS_CLOUD_BACKUP_PREVIOUS_KEY) !== latest)) {
    return { ok: false, reason: 'cloud_backup_rotation_failed' };
  }
  if (!set(storage, HOLDINGS_CLOUD_BACKUP_LATEST_KEY, raw)
    || get(storage, HOLDINGS_CLOUD_BACKUP_LATEST_KEY) !== raw) {
    return { ok: false, reason: 'cloud_backup_write_failed' };
  }
  try {
    const verified = JSON.parse(get(storage, HOLDINGS_CLOUD_BACKUP_LATEST_KEY));
    if (verified.version !== 1 || !Object.prototype.hasOwnProperty.call(verified, 'snapshot')) {
      return { ok: false, reason: 'cloud_backup_readback_failed' };
    }
  } catch (_) {
    return { ok: false, reason: 'cloud_backup_readback_failed' };
  }
  return { ok: true, verified: true };
}

function transactionSnapshot(storage) {
  return {
    v3Raw: get(storage, HOLDINGS_V3_KEY),
    v1Raw: get(storage, HOLDINGS_V1_COMPAT_KEY),
    projectionMetaRaw: get(storage, HOLDINGS_PROJECTION_META_KEY),
  };
}

function sameSnapshot(left, right) {
  return left.v3Raw === right.v3Raw
    && left.v1Raw === right.v1Raw
    && left.projectionMetaRaw === right.projectionMetaRaw;
}

function restoreSnapshot(storage, snapshot) {
  return restoreRaw(storage, HOLDINGS_V3_KEY, snapshot.v3Raw)
    && restoreRaw(storage, HOLDINGS_V1_COMPAT_KEY, snapshot.v1Raw)
    && restoreRaw(storage, HOLDINGS_PROJECTION_META_KEY, snapshot.projectionMetaRaw)
    && sameSnapshot(transactionSnapshot(storage), snapshot);
}

function parseJournal(raw) {
  if (!raw) return { ok: true, exists: false, journal: null };
  try {
    const journal = JSON.parse(raw);
    const snapshotValid = snapshot => snapshot && ['v3Raw', 'v1Raw', 'projectionMetaRaw']
      .every(key => snapshot[key] == null || typeof snapshot[key] === 'string');
    if (!journal || journal.version !== 1 || journal.state !== 'prepared'
      || !snapshotValid(journal.previous) || !snapshotValid(journal.next)) {
      return { ok: false, exists: true, reason: 'journal_invalid', journal: null };
    }
    return { ok: true, exists: true, journal };
  } catch (_) {
    return { ok: false, exists: true, reason: 'journal_invalid', journal: null };
  }
}

function clearJournal(storage) {
  return remove(storage, HOLDINGS_JOURNAL_KEY) && get(storage, HOLDINGS_JOURNAL_KEY) == null;
}

/** Recover only when every persisted value still belongs to this journal. */
export function recoverPendingRepositoryTransaction(storage = defaultStorage()) {
  const schema = futureRepositorySchema(storage);
  if (schema) return readonlyFailure(schema);
  const parsed = parseJournal(get(storage, HOLDINGS_JOURNAL_KEY));
  if (!parsed.ok) return { ok: false, state: 'blocked', reason: parsed.reason };
  if (!parsed.exists) return { ok: true, state: 'none' };
  const journalSchema = [parsed.journal.previous, parsed.journal.next]
    .flatMap(snapshot => [snapshot.v3Raw, snapshot.v1Raw]).map(futureSchema).find(Boolean);
  if (journalSchema) return readonlyFailure(journalSchema);
  const current = transactionSnapshot(storage);
  if (sameSnapshot(current, parsed.journal.next)) {
    return clearJournal(storage)
      ? { ok: true, state: 'finalized' }
      : { ok: false, state: 'blocked', reason: 'journal_finalize_failed' };
  }
  if (sameSnapshot(current, parsed.journal.previous)) {
    return clearJournal(storage)
      ? { ok: true, state: 'not_applied' }
      : { ok: false, state: 'blocked', reason: 'journal_clear_failed' };
  }
  const belongsToJournal = ['v3Raw', 'v1Raw', 'projectionMetaRaw'].every(key => (
    current[key] === parsed.journal.previous[key] || current[key] === parsed.journal.next[key]
  ));
  if (!belongsToJournal) {
    return { ok: false, state: 'blocked', reason: 'concurrent_change_detected' };
  }
  if (!restoreSnapshot(storage, parsed.journal.previous)) {
    return { ok: false, state: 'blocked', reason: 'rollback_failed' };
  }
  return clearJournal(storage)
    ? { ok: true, state: 'rolled_back' }
    : { ok: false, state: 'blocked', reason: 'journal_clear_failed' };
}

export function persistHoldingsDocument(storage = defaultStorage(), value, options = {}) {
  const schema = futureRepositorySchema(storage);
  if (schema) return readonlyFailure(schema);
  let document;
  try { document = normalizeHoldingsDocumentV3(value); }
  catch (error) { return { ok: false, reason: 'invalid_document', error }; }
  const recovery = recoverPendingRepositoryTransaction(storage);
  if (!recovery.ok) return { ok: false, reason: recovery.reason, document: null };
  const previous = transactionSnapshot(storage);
  if (options.expectedDocument && previous.v3Raw !== canonicalHoldingsDocument(options.expectedDocument)) {
    return { ok: false, reason: 'stale_local_document', document: null };
  }
  if (options.backup !== false && !backupRepositoryState(storage, options)) {
    return { ok: false, reason: 'backup_failed', document: null };
  }

  const v3Raw = canonicalHoldingsDocument(document);
  const v1Raw = JSON.stringify(toLegacyHoldings(document));
  const projectionMetaRaw = JSON.stringify({
    version: 1,
    v3Canonical: v3Raw,
    v1Raw,
  });
  const next = { v3Raw, v1Raw, projectionMetaRaw };
  const journalRaw = JSON.stringify({
    version: 1,
    state: 'prepared',
    createdAt: nowISO(options.now),
    previous,
    next,
  });
  if (!set(storage, HOLDINGS_JOURNAL_KEY, journalRaw) || get(storage, HOLDINGS_JOURNAL_KEY) !== journalRaw) {
    return { ok: false, reason: 'journal_write_failed', document: null };
  }
  const rollback = reason => {
    const current = transactionSnapshot(storage);
    const safe = ['v3Raw', 'v1Raw', 'projectionMetaRaw'].every(key => (
      current[key] === previous[key] || current[key] === next[key]
    ));
    if (!safe) return { ok: false, reason: 'concurrent_change_detected', document: null, recoveryRequired: true };
    const restored = restoreSnapshot(storage, previous);
    const cleared = restored && clearJournal(storage);
    return { ok: false, reason: restored && cleared ? reason : 'rollback_failed', document: null, recoveryRequired: !cleared };
  };

  if (!set(storage, HOLDINGS_V3_KEY, v3Raw) || get(storage, HOLDINGS_V3_KEY) !== v3Raw) return rollback('v3_write_failed');
  const verifiedV3 = parseAndMigrateHoldings(get(storage, HOLDINGS_V3_KEY));
  if (!verifiedV3.ok || verifiedV3.sourceSchema !== HOLDINGS_SCHEMA_VERSION
    || canonicalHoldingsDocument(verifiedV3.document) !== v3Raw) return rollback('v3_readback_failed');
  if (!set(storage, HOLDINGS_V1_COMPAT_KEY, v1Raw) || get(storage, HOLDINGS_V1_COMPAT_KEY) !== v1Raw) return rollback('v1_compat_write_failed');
  try {
    const compat = JSON.parse(get(storage, HOLDINGS_V1_COMPAT_KEY));
    if (!Array.isArray(compat) || JSON.stringify(compat) !== v1Raw) return rollback('v1_compat_readback_failed');
  } catch (_) {
    return rollback('v1_compat_readback_failed');
  }
  if (!set(storage, HOLDINGS_PROJECTION_META_KEY, projectionMetaRaw)
    || get(storage, HOLDINGS_PROJECTION_META_KEY) !== projectionMetaRaw) return rollback('projection_meta_write_failed');
  // A failed transaction must never hand the uncommitted candidate to the UI.
  // Restore the prior snapshot even if journal removal itself is unavailable;
  // recovery can then safely recognize that the transaction was not applied.
  if (!clearJournal(storage)) return rollback('journal_clear_failed');
  if (options.cacheKey) remove(storage, options.cacheKey);
  return { ok: true, reason: 'saved', document: verifiedV3.document, legacy: toLegacyHoldings(verifiedV3.document) };
}

function recoverBackup(storage, raw) {
  if (!raw) return null;
  try {
    const bundle = JSON.parse(raw);
    if (futureSchema(bundle.v3Raw) || futureSchema(bundle.v1Raw)) return null;
    for (const candidate of [bundle.v3Raw, bundle.v1Raw]) {
      if (candidate == null || candidate === '') continue;
      const parsed = parseAndMigrateHoldings(candidate);
      if (parsed.ok && !parsed.readonly) return parsed.document;
    }
  } catch (_) {}
  return null;
}

function recoverLegacyBackup(storage) {
  for (const key of LEGACY_BACKUP_KEYS) {
    const raw = get(storage, key);
    if (!raw) continue;
    try {
      const bundle = JSON.parse(raw);
      if (!Array.isArray(bundle?.holdings)) continue;
      const parsed = parseAndMigrateHoldings(bundle.holdings);
      if (parsed.ok && !parsed.readonly) return parsed.document;
    } catch (_) {}
  }
  return null;
}

function projectionBaseline(storage) {
  const raw = get(storage, HOLDINGS_PROJECTION_META_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value?.version === 1 && typeof value.v1Raw === 'string' ? value : null;
  } catch (_) {
    return null;
  }
}

export function loadHoldingsRepository(storage = defaultStorage(), options = {}) {
  const recovery = recoverPendingRepositoryTransaction(storage);
  if (!recovery.ok) return { ...recovery, error: null, document: null, legacy: [] };
  let deviceId;
  try { deviceId = getOrCreateDeviceId(storage, options.generateDeviceId); }
  catch (error) { return { ok: false, reason: error.code || 'device_id_failed', error, document: null, legacy: [] }; }

  const currentRaw = get(storage, HOLDINGS_V3_KEY);
  if (currentRaw) {
    const current = parseAndMigrateHoldings(currentRaw);
    if (current.ok && current.sourceSchema === HOLDINGS_SCHEMA_VERSION && !current.readonly) {
      const baseline = projectionBaseline(storage);
      const currentProjection = get(storage, HOLDINGS_V1_COMPAT_KEY);
      if (baseline && currentProjection !== baseline.v1Raw) {
        const external = parseAndMigrateHoldings(currentProjection);
        if (!external.ok || external.readonly || !external.document) {
          return { ok: false, reason: 'compat_projection_corrupt', error: external.error, document: null, legacy: [], deviceId };
        }
        try {
          const merged = mergeParsedHoldings(current, external, { deviceId }).document;
          const saved = persistHoldingsDocument(storage, merged, {
            ...options,
            expectedDocument: current.document,
          });
          if (!saved.ok) return { ...saved, reason: saved.reason || 'compat_projection_reconcile_failed', deviceId };
          return {
            ...saved,
            reason: 'compat_projection_reconciled',
            migrated: false,
            recovered: false,
            deviceId,
          };
        } catch (error) {
          return { ok: false, reason: error.code || 'compat_projection_reconcile_failed', error, document: null, legacy: [], deviceId };
        }
      }
      return { ok: true, reason: 'v3', migrated: false, recovered: false, deviceId, document: current.document, legacy: toLegacyHoldings(current.document) };
    }
    for (const key of [HOLDINGS_BACKUP_LATEST_KEY, HOLDINGS_BACKUP_PREVIOUS_KEY]) {
      const recovered = recoverBackup(storage, get(storage, key));
      if (!recovered) continue;
      const saved = persistHoldingsDocument(storage, recovered, { ...options, backup: false });
      if (saved.ok) return { ...saved, reason: 'backup_recovered', migrated: false, recovered: true, deviceId };
    }
    return { ok: false, reason: 'v3_corrupt', error: current.error, document: null, legacy: [], deviceId };
  }

  const legacyRaw = get(storage, HOLDINGS_V1_COMPAT_KEY);
  const parsed = legacyRaw == null || legacyRaw === ''
    ? { ok: true, sourceSchema: 1, readonly: false, migrated: true, document: createEmptyHoldingsDocument(deviceId, nowISO(options.now)) }
    : parseAndMigrateHoldings(legacyRaw);
  if (!parsed.ok || parsed.readonly) {
    const recovered = recoverLegacyBackup(storage);
    if (!recovered) return { ok: false, reason: 'legacy_corrupt', error: parsed.error, document: null, legacy: [], deviceId };
    const identifiedBackup = normalizeHoldingsDocumentV3({ ...recovered, deviceId });
    const savedBackup = persistHoldingsDocument(storage, identifiedBackup, options);
    if (!savedBackup.ok) return { ...savedBackup, reason: savedBackup.reason || 'legacy_backup_recovery_failed', deviceId };
    return {
      ...savedBackup,
      reason: 'legacy_backup_recovered',
      migrated: true,
      recovered: true,
      deviceId,
    };
  }
  const identified = normalizeHoldingsDocumentV3({
    ...parsed.document,
    deviceId,
  });
  const saved = persistHoldingsDocument(storage, identified, options);
  if (!saved.ok) return { ...saved, migrated: true, recovered: false, deviceId, legacy: [] };
  return { ...saved, reason: 'legacy_migrated', migrated: true, recovered: false, deviceId };
}

function legacyTimestamp(value, fallback) {
  try { return normalizeHoldingTimestamp(value, 'updated_at'); }
  catch (_) { return fallback; }
}

function sameNullableNumber(left, right) {
  return left == null ? right == null : right != null && Number(left) === Number(right);
}

export function reconcileLegacyHoldings(value, currentValue, options = {}) {
  if (!Array.isArray(value)) throw new HoldingSchemaError('invalid_legacy_holdings', 'legacy holdings must be an array');
  const current = normalizeHoldingsDocumentV3(currentValue);
  const deviceId = String(options.deviceId || current.deviceId).trim();
  const timestamp = nowISO(options.now);
  const byCode = new Map(current.holdings.map(holding => [holding.fundCode, holding]));
  const seen = new Set();
  const allowRestoreCodes = new Set(options.allowRestoreCodes || []);
  let anyChanged = false;

  for (const item of value) {
    const code = String(item?.code || item?.fundCode || '').trim();
    if (!/^\d{6}$/.test(code)) throw new HoldingSchemaError('invalid_fund_code', 'legacy fund code must contain six digits');
    if (seen.has(code)) throw new HoldingSchemaError('duplicate_fund_code', `duplicate legacy fund code: ${code}`);
    seen.add(code);
    const existing = byCode.get(code);
    const updatedAt = legacyTimestamp(item.updated_at || item.updatedAt, timestamp);
    const shares = Number(item.shares);
    if (!['number', 'string'].includes(typeof item.shares) || String(item.shares).trim() === ''
      || !Number.isFinite(shares) || shares < 0) throw new HoldingSchemaError('invalid_legacy_number', 'shares must be non-negative');
    const hasCost = Object.prototype.hasOwnProperty.call(item, 'cost') || Object.prototype.hasOwnProperty.call(item, 'costNav');
    const rawCost = Object.prototype.hasOwnProperty.call(item, 'costNav') ? item.costNav : item.cost;
    let costNav = !hasCost || rawCost == null || rawCost === '' ? null : Number(rawCost);
    if (costNav != null && (!['number', 'string'].includes(typeof rawCost) || String(rawCost).trim() === ''
      || !Number.isFinite(costNav) || costNav < 0)) throw new HoldingSchemaError('invalid_legacy_number', 'costNav must be non-negative or null');
    if (existing?.costNav == null && costNav === 0 && updatedAt <= existing.updatedAt) costNav = null;
    const fundName = String(item.fundName || item.name || code).trim().slice(0, 120) || code;
    const deleted = item.deleted === true || item.deletedAt != null || item.deleted_at != null;
    const note = Object.prototype.hasOwnProperty.call(item, 'note')
      ? (item.note == null ? null : String(item.note).trim().slice(0, 500))
      : (existing?.note ?? null);

    if (!existing) {
      byCode.set(code, normalizeHoldingRecordV3({
        id: stableHoldingId(code), fundCode: code, fundName, shares, costNav,
        createdAt: updatedAt, updatedAt, deletedAt: deleted ? updatedAt : null,
        revision: 1, deviceId, note,
      }));
      anyChanged = true;
      continue;
    }

    if (existing.deletedAt && !deleted && !allowRestoreCodes.has(code)) {
      continue;
    }

    const changed = existing.fundName !== fundName
      || existing.shares !== shares
      || !sameNullableNumber(existing.costNav, costNav)
      || Boolean(existing.deletedAt) !== deleted
      || existing.note !== note;
    if (!changed) continue;
    anyChanged = true;
    byCode.set(code, normalizeHoldingRecordV3({
      ...existing,
      fundName,
      shares,
      costNav,
      updatedAt: updatedAt > existing.updatedAt ? updatedAt : timestamp,
      deletedAt: deleted ? (updatedAt > existing.updatedAt ? updatedAt : timestamp) : null,
      revision: existing.revision + 1,
      deviceId,
      note,
    }));
  }

  // Projection round-trips are reads, not edits. Preserve document timestamps,
  // record revisions and device ownership when nothing actually changed.
  if (!anyChanged) return current;
  const holdings = [...byCode.values()];
  const latest = holdings.reduce((result, holding) => holding.updatedAt > result ? holding.updatedAt : result, timestamp);
  return normalizeHoldingsDocumentV3({ schema: 3, updatedAt: latest, deviceId, holdings });
}

export function saveLegacyHoldingsTransaction(storage = defaultStorage(), legacyHoldings, options = {}) {
  const loaded = loadHoldingsRepository(storage, options);
  if (!loaded.ok) return loaded;
  if (options.expectedDocument
    && canonicalHoldingsDocument(options.expectedDocument) !== canonicalHoldingsDocument(loaded.document)) {
    return { ok: false, reason: 'stale_local_document', document: loaded.document, legacy: loaded.legacy };
  }
  try {
    const document = reconcileLegacyHoldings(legacyHoldings, loaded.document, { ...options, deviceId: loaded.deviceId });
    return persistHoldingsDocument(storage, document, { ...options, expectedDocument: loaded.document });
  } catch (error) {
    return { ok: false, reason: error.code || 'legacy_reconcile_failed', error, document: loaded.document, legacy: loaded.legacy };
  }
}
