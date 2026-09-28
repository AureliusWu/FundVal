import {
  HOLDINGS_SCHEMA_VERSION,
  canonicalHoldingsDocument,
  normalizeHoldingsDocumentV3,
} from './holdings-schema.js';
import {
  mergeParsedHoldings,
  parseAndMigrateHoldings,
} from './holdings-migration.js';

const DEFAULT_STABILITY_ATTEMPTS = 3;

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (typeof value === 'string') return value;
  return JSON.parse(JSON.stringify(value));
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  if (!value.trim()) throw new Error('empty cloud payload');
  return JSON.parse(value);
}

function positiveAck(value) {
  if (value === true) return true;
  return isObject(value) && value.ok === true && value.verified !== false;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : fallback;
}

function parsedV3(document) {
  const normalized = normalizeHoldingsDocumentV3(document);
  return Object.freeze({
    ok: true,
    sourceSchema: HOLDINGS_SCHEMA_VERSION,
    readonly: false,
    migrated: false,
    empty: normalized.holdings.length === 0,
    document: normalized,
  });
}

function mergeDocuments(leftParsed, rightParsed, options) {
  const result = mergeParsedHoldings(leftParsed, rightParsed, options);
  if (result?.ok === false) {
    const error = new Error(result.reason || 'holdings merge failed');
    error.code = result.reason || 'merge_failed';
    throw error;
  }
  return normalizeHoldingsDocumentV3(result?.document || result);
}

function cloudReadValue(result) {
  if (!isObject(result) || !Object.prototype.hasOwnProperty.call(result, 'ok')) {
    return { ok: true, value: result, version: null };
  }
  if (result.ok !== true) return { ok: false, reason: result.reason || 'remote_read_failed' };
  const hasRaw = Object.prototype.hasOwnProperty.call(result, 'raw');
  const hasPayload = Object.prototype.hasOwnProperty.call(result, 'payload');
  const hasContent = Object.prototype.hasOwnProperty.call(result, 'content');
  if (!hasRaw && !hasPayload && !hasContent) return { ok: false, reason: 'remote_payload_missing' };
  return {
    ok: true,
    value: hasRaw ? result.raw : (hasPayload ? result.payload : result.content),
    backupValue: Object.prototype.hasOwnProperty.call(result, 'backupRaw')
      ? cloneJsonValue(result.backupRaw)
      : cloneJsonValue(hasRaw ? result.raw : (hasPayload ? result.payload : result.content)),
    version: result.version ?? result.etag ?? null,
    requiresPatch: result.requiresPatch === true,
  };
}

function localReadValue(result) {
  if (isObject(result) && Object.prototype.hasOwnProperty.call(result, 'ok')) {
    if (result.ok !== true || !result.document) return { ok: false, reason: result.reason || 'local_read_failed' };
    return { ok: true, document: normalizeHoldingsDocumentV3(result.document) };
  }
  return { ok: true, document: normalizeHoldingsDocumentV3(result) };
}

function failure(reason, details = {}) {
  return Object.freeze({
    ok: false,
    reason,
    patched: false,
    patchAcknowledged: false,
    remoteVerified: false,
    pending: true,
    ...details,
  });
}

function legacyHolding(holding) {
  return {
    code: holding.fundCode,
    name: holding.fundName,
    shares: holding.shares,
    cost: holding.costNav,
    updated_at: holding.updatedAt,
    deleted: holding.deletedAt != null,
  };
}

export function makeCloudWritePayload(value, targetSchema = HOLDINGS_SCHEMA_VERSION) {
  const document = normalizeHoldingsDocumentV3(value);
  if (targetSchema === HOLDINGS_SCHEMA_VERSION) {
    return JSON.parse(canonicalHoldingsDocument(document));
  }
  if (targetSchema !== 2) throw new Error('cloud writes support only schema 2 or schema 3');
  return {
    schema: 2,
    updated_at: document.updatedAt,
    device_id: document.deviceId,
    holdings: document.holdings.map(legacyHolding),
  };
}

export function canonicalCloudPayload(value, expectedSchema) {
  const payload = parseJsonValue(value);
  const sourceSchema = Array.isArray(payload) ? 1 : Number(payload?.schema);
  if (sourceSchema !== expectedSchema) throw new Error('cloud payload schema mismatch');
  const parsed = parseAndMigrateHoldings(payload);
  if (!parsed.ok || parsed.readonly || !parsed.document) throw parsed.error || new Error('invalid cloud payload');
  return JSON.stringify(makeCloudWritePayload(parsed.document, expectedSchema));
}

/**
 * Finalize metadata after a newly-created archive has been read back. The
 * uploaded snapshot and the latest local repository state are intentionally
 * separate: edits made while the POST/readback was in flight must remain
 * pending instead of being silently marked as uploaded.
 */
export function finalizeCreatedArchiveState(uploadedValue, currentValue, previousMeta = {}, details = {}) {
  return finalizeCloudSyncMetadata(currentValue, previousMeta, {
    ...details, uploadedDocument: uploadedValue, pending: false,
  });
}

/**
 * Call with the latest repository document while holding the origin-wide lock.
 * A merged pull snapshot is not evidence that the same snapshot was uploaded.
 * Keep an explicit pending bit for bridge convergence even when hashes match.
 */
export function finalizeCloudSyncMetadata(currentValue, previousMeta = {}, details = {}) {
  const reference = details.uploadedDocument || details.pulledDocument;
  if (!reference) throw new Error('verified sync snapshot required');
  const uploadedValue = reference;
  const uploadedDocument = normalizeHoldingsDocumentV3(uploadedValue);
  const currentDocument = normalizeHoldingsDocumentV3(currentValue);
  const uploadedHash = canonicalHoldingsDocument(uploadedDocument);
  const currentHash = canonicalHoldingsDocument(currentDocument);
  const pending = details.pending === true || uploadedHash !== currentHash;
  const meta = {
    ...(isObject(previousMeta) ? previousMeta : {}),
    last_push_hash: details.uploadedDocument || details.pending !== true
      ? uploadedHash : String(previousMeta?.last_push_hash || ''),
    pending_hash: pending ? currentHash : '',
    pending,
    last_remote_schema: Number.isSafeInteger(Number(details.remoteSchema))
      ? Number(details.remoteSchema)
      : HOLDINGS_SCHEMA_VERSION,
  };
  if (typeof details.syncedAt === 'string' && details.syncedAt) {
    meta.last_pull = details.syncedAt;
  }
  return Object.freeze({
    pending,
    uploadedHash,
    currentHash,
    meta: Object.freeze(meta),
  });
}

/**
 * Reconcile the isolated Schema 3 Gist file with the legacy Schema 2 file.
 * The V3 file remains authoritative for revisions, notes and tombstones; a
 * genuinely newer legacy edit may still be lifted into V3 by the origin-aware
 * merge rules. The caller writes only the returned Schema 3 payload.
 */
export function reconcileCloudBridgePayload(v3Value, legacyValue, options = {}) {
  return reconcileCloudBridgePayloadSet([v3Value], legacyValue, options);
}

/** Merge one or more per-device V3 files plus the retained legacy file. */
export function reconcileCloudBridgePayloadSet(v3Values, legacyValue, options = {}) {
  if (!Array.isArray(v3Values) || !v3Values.length) {
    return Object.freeze({ ok: false, reason: 'bridge_v3_missing', payload: null, changed: false });
  }

  const parsedV3Values = v3Values.map(parseAndMigrateHoldings);
  if (parsedV3Values.some(parsed => (
    !parsed.ok || parsed.readonly || parsed.sourceSchema !== HOLDINGS_SCHEMA_VERSION || !parsed.document
  ))) {
    return Object.freeze({ ok: false, reason: 'bridge_v3_invalid', payload: null, changed: false });
  }

  let authoritative = parsedV3Values[0];
  try {
    for (const candidate of parsedV3Values.slice(1)) {
      authoritative = parsedV3(mergeDocuments(authoritative, candidate, options));
    }
  } catch (_) {
    return Object.freeze({ ok: false, reason: 'bridge_v3_merge_failed', payload: null, changed: false });
  }

  const currentPayload = makeCloudWritePayload(parsedV3Values[0].document, HOLDINGS_SCHEMA_VERSION);
  const authoritativePayload = makeCloudWritePayload(authoritative.document, HOLDINGS_SCHEMA_VERSION);
  if (legacyValue == null || (typeof legacyValue === 'string' && !legacyValue.trim())) {
    return Object.freeze({
      ok: true,
      reason: 'bridge_v3_only',
      payload: authoritativePayload,
      changed: canonicalCloudPayload(authoritativePayload, HOLDINGS_SCHEMA_VERSION)
        !== canonicalCloudPayload(currentPayload, HOLDINGS_SCHEMA_VERSION),
    });
  }

  const legacyParsed = parseAndMigrateHoldings(legacyValue);
  if (!legacyParsed.ok || legacyParsed.readonly || legacyParsed.sourceSchema >= HOLDINGS_SCHEMA_VERSION || !legacyParsed.document) {
    // Once an authoritative V3 file exists, a corrupt or unexpectedly newer
    // legacy sidecar must not make the safe archive unavailable or replace it.
    return Object.freeze({
      ok: true,
      reason: 'bridge_legacy_ignored',
      payload: authoritativePayload,
      changed: canonicalCloudPayload(authoritativePayload, HOLDINGS_SCHEMA_VERSION)
        !== canonicalCloudPayload(currentPayload, HOLDINGS_SCHEMA_VERSION),
    });
  }

  try {
    const merged = mergeDocuments(authoritative, legacyParsed, options);
    const payload = makeCloudWritePayload(merged, HOLDINGS_SCHEMA_VERSION);
    return Object.freeze({
      ok: true,
      reason: 'bridge_reconciled',
      payload,
      changed: canonicalCloudPayload(payload, HOLDINGS_SCHEMA_VERSION)
        !== canonicalCloudPayload(currentPayload, HOLDINGS_SCHEMA_VERSION),
    });
  } catch (_) {
    return Object.freeze({ ok: false, reason: 'bridge_merge_failed', payload: null, changed: false });
  }
}

function targetWriteSchema(sourceSchema, upgradeSchema) {
  if (upgradeSchema === true) return HOLDINGS_SCHEMA_VERSION;
  return sourceSchema === HOLDINGS_SCHEMA_VERSION ? HOLDINGS_SCHEMA_VERSION : 2;
}

/** Schema 2 cannot preserve record revisions, tombstones, or notes. */
export function requiresSchema3CloudUpgrade(value) {
  const document = normalizeHoldingsDocumentV3(value);
  return document.holdings.some(holding => (
    holding.revision > 1 || holding.deletedAt != null || holding.note != null
  ));
}

async function readLocal(local, phase) {
  try {
    return localReadValue(await local.load({ phase }));
  } catch (error) {
    return { ok: false, reason: error?.code || 'local_read_failed', error };
  }
}

async function createVerifiedBackup(local, snapshot) {
  try {
    const result = await local.backup(snapshot);
    return positiveAck(result)
      ? { ok: true }
      : { ok: false, reason: result?.reason || 'backup_failed' };
  } catch (error) {
    return { ok: false, reason: error?.code || 'backup_failed', error };
  }
}

async function writeLocal(local, document, phase) {
  try {
    const result = await local.persist(document, { phase });
    if (!positiveAck(result)) return { ok: false, reason: result?.reason || 'local_persist_failed' };
    const readback = await readLocal(local, phase + '-readback');
    if (!readback.ok) return readback;
    return { ok: true, document: readback.document };
  } catch (error) {
    return { ok: false, reason: error?.code || 'local_persist_failed', error };
  }
}

async function markPending(local, pending, details) {
  if (typeof local.markPending !== 'function') return { ok: true, persisted: false, pending };
  try {
    const result = await local.markPending(pending, details);
    if (result === false || result?.ok === false) {
      return { ok: false, reason: result?.reason || 'pending_marker_failed' };
    }
    return {
      ok: true, persisted: true,
      pending: typeof result?.pending === 'boolean' ? result.pending : pending,
      document: result?.document ? normalizeHoldingsDocumentV3(result.document) : null,
    };
  } catch (error) {
    return { ok: false, reason: error?.code || 'pending_marker_failed', error };
  }
}

export async function synchronizeHoldingsCloud(options = {}) {
  const remote = options.remote;
  const local = options.local;
  if (typeof remote?.get !== 'function' || typeof remote?.patch !== 'function'
    || typeof local?.load !== 'function' || typeof local?.backup !== 'function'
    || typeof local?.persist !== 'function') {
    return failure('invalid_adapter');
  }

  const mergeOptions = { deviceId: options.deviceId, now: options.now };
  const maxAttempts = nonNegativeInteger(options.maxStabilityAttempts, DEFAULT_STABILITY_ATTEMPTS);
  let initialRemote;
  try {
    initialRemote = cloudReadValue(await remote.get({ phase: 'initial' }));
  } catch (error) {
    return failure(error?.code || 'remote_read_failed', { error });
  }
  if (!initialRemote.ok) return failure(initialRemote.reason);

  const remoteParsed = parseAndMigrateHoldings(initialRemote.value);
  if (!remoteParsed.ok) return failure('remote_payload_invalid', { error: remoteParsed.error });
  if (remoteParsed.readonly || remoteParsed.sourceSchema > HOLDINGS_SCHEMA_VERSION || !remoteParsed.document) {
    return failure('remote_schema_future', { remoteSchema: remoteParsed.sourceSchema });
  }

  let localSnapshot = await readLocal(local, 'initial');
  if (!localSnapshot.ok) return failure(localSnapshot.reason, { error: localSnapshot.error });

  let stableSnapshot = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const backup = await createVerifiedBackup(local, {
      phase: 'cloud-sync',
      attempt,
      localDocument: localSnapshot.document,
      remoteRaw: cloneJsonValue(initialRemote.backupValue),
      remoteSchema: remoteParsed.sourceSchema,
      remoteVersion: initialRemote.version,
    });
    if (!backup.ok) return failure(backup.reason, { error: backup.error });
    const afterBackup = await readLocal(local, 'after-backup');
    if (!afterBackup.ok) return failure(afterBackup.reason, { error: afterBackup.error });
    if (canonicalHoldingsDocument(afterBackup.document) === canonicalHoldingsDocument(localSnapshot.document)) {
      localSnapshot = afterBackup;
      stableSnapshot = true;
      break;
    }
    localSnapshot = afterBackup;
  }
  if (!stableSnapshot) return failure('local_snapshot_unstable');

  let uploadDocument;
  try {
    uploadDocument = mergeDocuments(parsedV3(localSnapshot.document), remoteParsed, mergeOptions);
  } catch (error) {
    return failure(error?.code || 'merge_failed', { error });
  }

  const writeSchema = targetWriteSchema(remoteParsed.sourceSchema, options.upgradeSchema);
  // New runtimes never write the shared legacy file. Until the user explicitly
  // creates an isolated V3 shard, cloud sync is pull-only and stays pending.
  if (writeSchema < HOLDINGS_SCHEMA_VERSION) {
    return failure('remote_schema_upgrade_required', {
      sourceSchema: remoteParsed.sourceSchema,
      writeSchema,
      remoteSchema: remoteParsed.sourceSchema,
    });
  }

  let localStable = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const written = await writeLocal(local, uploadDocument, 'pre-patch');
    if (!written.ok) return failure(written.reason, { error: written.error });
    const expected = canonicalHoldingsDocument(uploadDocument);
    const observed = canonicalHoldingsDocument(written.document);
    if (expected === observed) {
      uploadDocument = written.document;
      localStable = true;
      break;
    }

    const backup = await createVerifiedBackup(local, {
      phase: 'concurrent-local-change',
      attempt,
      localDocument: written.document,
      remoteRaw: cloneJsonValue(initialRemote.backupValue),
      remoteSchema: remoteParsed.sourceSchema,
      remoteVersion: initialRemote.version,
    });
    if (!backup.ok) return failure(backup.reason, { error: backup.error });
    try {
      uploadDocument = mergeDocuments(parsedV3(uploadDocument), parsedV3(written.document), mergeOptions);
    } catch (error) {
      return failure(error?.code || 'merge_failed', { error });
    }
  }
  if (!localStable) return failure('local_persist_unstable');

  const writePayload = makeCloudWritePayload(uploadDocument, writeSchema);
  const expectedRemoteCanonical = canonicalCloudPayload(writePayload, writeSchema);
  let patchResult;
  try {
    patchResult = await remote.patch({
      schema: writeSchema,
      payload: writePayload,
      content: JSON.stringify(writePayload, null, 2),
    });
  } catch (error) {
    return failure(error?.code || 'remote_patch_failed', { error, writeSchema });
  }
  if (!positiveAck(patchResult)) {
    return failure(patchResult?.reason || 'remote_patch_failed', { writeSchema });
  }

  let verifiedRemote;
  try {
    verifiedRemote = cloudReadValue(await remote.get({ phase: 'readback' }));
  } catch (error) {
    return failure(error?.code || 'remote_readback_failed', {
      error, patched: true, patchAcknowledged: true, writeSchema,
    });
  }
  if (!verifiedRemote.ok) {
    return failure(verifiedRemote.reason || 'remote_readback_failed', {
      patched: true, patchAcknowledged: true, writeSchema,
    });
  }
  if (writeSchema === HOLDINGS_SCHEMA_VERSION && verifiedRemote.requiresPatch) {
    return failure('remote_target_readback_mismatch', {
      patched: true, patchAcknowledged: true, writeSchema,
    });
  }
  try {
    const observedCanonical = canonicalCloudPayload(verifiedRemote.value, writeSchema);
    if (observedCanonical !== expectedRemoteCanonical) {
      return failure('remote_readback_mismatch', {
        patched: true, patchAcknowledged: true, writeSchema,
      });
    }
  } catch (error) {
    return failure('remote_readback_invalid', {
      error, patched: true, patchAcknowledged: true, writeSchema,
    });
  }

  let currentLocal = await readLocal(local, 'post-remote-readback');
  if (!currentLocal.ok) {
    return failure(currentLocal.reason, {
      error: currentLocal.error,
      patched: true,
      patchAcknowledged: true,
      remoteVerified: true,
      writeSchema,
    });
  }

  const uploadedCanonical = canonicalHoldingsDocument(uploadDocument);
  let finalDocument = currentLocal.document;
  if (canonicalHoldingsDocument(finalDocument) !== uploadedCanonical) {
    try {
      const mergedPending = mergeDocuments(parsedV3(uploadDocument), parsedV3(finalDocument), mergeOptions);
      if (canonicalHoldingsDocument(mergedPending) !== canonicalHoldingsDocument(finalDocument)) {
        const backup = await createVerifiedBackup(local, {
          phase: 'post-sync-local-change',
          localDocument: finalDocument,
          remoteRaw: cloneJsonValue(verifiedRemote.backupValue),
          remoteSchema: writeSchema,
          remoteVersion: verifiedRemote.version,
        });
        if (!backup.ok) {
          return failure(backup.reason, {
            patched: true, patchAcknowledged: true, remoteVerified: true, writeSchema,
          });
        }
        const saved = await writeLocal(local, mergedPending, 'post-sync-pending');
        if (!saved.ok || canonicalHoldingsDocument(saved.document) !== canonicalHoldingsDocument(mergedPending)) {
          return failure(saved.reason || 'pending_local_persist_failed', {
            error: saved.error,
            patched: true,
            patchAcknowledged: true,
            remoteVerified: true,
            writeSchema,
          });
        }
        finalDocument = saved.document;
      }
    } catch (error) {
      return failure(error?.code || 'pending_merge_failed', {
        error, patched: true, patchAcknowledged: true, remoteVerified: true, writeSchema,
      });
    }
  }

  const pending = canonicalHoldingsDocument(finalDocument) !== uploadedCanonical;
  const pendingState = await markPending(local, pending, {
    uploadedDocument: uploadDocument,
    currentDocument: finalDocument,
    writeSchema,
  });
  if (!pendingState.ok) {
    return failure(pendingState.reason, {
      error: pendingState.error,
      patched: true,
      patchAcknowledged: true,
      remoteVerified: true,
      pending,
      writeSchema,
      document: finalDocument,
    });
  }

  return Object.freeze({
    ok: true,
    reason: pendingState.pending ? 'synced_with_pending_changes' : 'synced',
    patched: true,
    patchAcknowledged: true,
    remoteVerified: true,
    pending: pendingState.pending,
    pendingPersisted: pendingState.persisted,
    writeSchema,
    sourceSchema: remoteParsed.sourceSchema,
    upgraded: writeSchema === HOLDINGS_SCHEMA_VERSION && remoteParsed.sourceSchema < HOLDINGS_SCHEMA_VERSION,
    document: pendingState.document || finalDocument,
    uploadedDocument: uploadDocument,
  });
}

/**
 * Strict pull-only reconciliation. It may update the local repository but
 * never calls PATCH; callers can schedule a later verified push when pending.
 */
export async function pullHoldingsCloud(options = {}) {
  const remote = options.remote;
  const local = options.local;
  if (typeof remote?.get !== 'function' || typeof local?.load !== 'function'
    || typeof local?.backup !== 'function' || typeof local?.persist !== 'function') {
    return failure('invalid_adapter');
  }

  let remoteRead;
  try {
    remoteRead = cloudReadValue(await remote.get({ phase: 'pull' }));
  } catch (error) {
    return failure(error?.code || 'remote_read_failed', { error });
  }
  if (!remoteRead.ok) return failure(remoteRead.reason);
  const remoteParsed = parseAndMigrateHoldings(remoteRead.value);
  if (!remoteParsed.ok) return failure('remote_payload_invalid', { error: remoteParsed.error });
  if (remoteParsed.readonly || !remoteParsed.document) {
    return failure('remote_schema_future', { remoteSchema: remoteParsed.sourceSchema });
  }

  const localRead = await readLocal(local, 'pull-initial');
  if (!localRead.ok) return failure(localRead.reason, { error: localRead.error });
  const backup = await createVerifiedBackup(local, {
    phase: 'cloud-pull',
    localDocument: localRead.document,
    remoteRaw: cloneJsonValue(remoteRead.backupValue),
    remoteSchema: remoteParsed.sourceSchema,
    remoteVersion: remoteRead.version,
  });
  if (!backup.ok) return failure(backup.reason, { error: backup.error });

  let merged;
  try {
    merged = mergeDocuments(parsedV3(localRead.document), remoteParsed, {
      deviceId: options.deviceId,
      now: options.now,
    });
  } catch (error) {
    return failure(error?.code || 'merge_failed', { error });
  }

  const localCanonical = canonicalHoldingsDocument(localRead.document);
  const mergedCanonical = canonicalHoldingsDocument(merged);
  let finalDocument = localRead.document;
  if (mergedCanonical !== localCanonical) {
    const written = await writeLocal(local, merged, 'pull-commit');
    if (!written.ok || canonicalHoldingsDocument(written.document) !== mergedCanonical) {
      return failure(written.reason || 'local_persist_unstable', { error: written.error });
    }
    finalDocument = written.document;
  }

  const remoteWriteSchema = targetWriteSchema(remoteParsed.sourceSchema, false);
  let pending = remoteRead.requiresPatch === true;
  try {
    pending = pending || canonicalCloudPayload(
      makeCloudWritePayload(finalDocument, remoteWriteSchema),
      remoteWriteSchema
    ) !== canonicalCloudPayload(remoteRead.value, remoteWriteSchema);
  } catch (_) {
    pending = true;
  }
  const pendingState = await markPending(local, pending, {
    pulledDocument: finalDocument,
    remoteSchema: remoteParsed.sourceSchema,
  });
  if (!pendingState.ok) return failure(pendingState.reason, { error: pendingState.error, document: finalDocument });

  return Object.freeze({
    ok: true,
    reason: pendingState.pending ? 'pulled_with_pending_changes' : 'pulled',
    patched: false,
    patchAcknowledged: false,
    remoteVerified: true,
    pending: pendingState.pending,
    pendingPersisted: pendingState.persisted,
    sourceSchema: remoteParsed.sourceSchema,
    changed: canonicalHoldingsDocument(pendingState.document || finalDocument) !== localCanonical,
    document: pendingState.document || finalDocument,
  });
}
