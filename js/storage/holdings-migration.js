import {
  HOLDINGS_SCHEMA_VERSION,
  HoldingSchemaError,
  LEGACY_HOLDING_EPOCH,
  compareHoldingRecords,
  normalizeHoldingRecordV3,
  normalizeHoldingTimestamp,
  normalizeHoldingsDocumentV3,
  stableHoldingId,
} from './holdings-schema.js';

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function timestampOr(value, fallback) {
  try { return normalizeHoldingTimestamp(value); }
  catch (_) { return fallback; }
}

function legacyNumber(value, field, { nullable = false } = {}) {
  if (nullable && (value == null || value === '')) return null;
  if (value == null || value === '') throw new HoldingSchemaError('invalid_legacy_number', `${field} is required`, { field });
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') {
    throw new HoldingSchemaError('invalid_legacy_number', `${field} must be non-negative`, { field });
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new HoldingSchemaError('invalid_legacy_number', `${field} must be non-negative`, { field });
  }
  return number;
}

function migrateLegacyRecord(item, topTimestamp, topDeviceId) {
  if (!isObject(item)) throw new HoldingSchemaError('invalid_legacy_record', 'legacy holding must be an object');
  const fundCode = String(item.fundCode || item.code || '').trim();
  const updatedAt = timestampOr(item.updatedAt || item.updated_at, topTimestamp);
  const createdAt = timestampOr(item.createdAt || item.created_at, updatedAt);
  const deleted = item.deleted === true || item.deletedAt != null || item.deleted_at != null;
  const deletedAt = deleted
    ? timestampOr(item.deletedAt || item.deleted_at, updatedAt)
    : null;
  const revisionValue = Number(item.revision);
  const revision = Number.isSafeInteger(revisionValue) && revisionValue >= 1 ? revisionValue : 1;
  const hasLegacyCost = Object.prototype.hasOwnProperty.call(item, 'cost')
    || Object.prototype.hasOwnProperty.call(item, 'costNav');
  const rawCost = Object.prototype.hasOwnProperty.call(item, 'costNav') ? item.costNav : item.cost;
  return normalizeHoldingRecordV3({
    // V1/V2 used fund code as identity. Never trust an optional legacy id,
    // otherwise two devices can migrate the same fund to different records.
    id: stableHoldingId(fundCode),
    fundCode,
    fundName: String(item.fundName || item.name || fundCode).trim() || fundCode,
    shares: legacyNumber(item.shares, 'shares'),
    costNav: hasLegacyCost ? legacyNumber(rawCost, 'costNav', { nullable: true }) : null,
    createdAt,
    updatedAt,
    deletedAt,
    revision: 1,
    deviceId: String(item.deviceId || item.device_id || topDeviceId || 'legacy-device').trim().slice(0, 120) || 'legacy-device',
    note: item.note == null ? null : String(item.note).trim().slice(0, 500),
  });
}

export function migrateLegacyHoldingsToV3(value, options = {}) {
  const sourceSchema = Array.isArray(value) ? 1 : Number(value?.schema || 0);
  const holdings = Array.isArray(value) ? value : value?.holdings;
  if (!Array.isArray(holdings) || ![1, 2].includes(sourceSchema)) {
    throw new HoldingSchemaError('unsupported_legacy_schema', 'expected a legacy array or schema 2 document');
  }
  const topTimestamp = timestampOr(
    Array.isArray(value) ? '' : (value.updatedAt || value.updated_at),
    LEGACY_HOLDING_EPOCH
  );
  // Migration output must be byte-for-byte deterministic on every device.
  // A local runtime device id therefore must never leak into migrated rows.
  void options;
  const topDeviceId = String((Array.isArray(value) ? '' : (value.deviceId || value.device_id)) || 'legacy-device')
    .trim().slice(0, 120) || 'legacy-device';
  const byId = new Map();
  const codeToId = new Map();

  for (const item of holdings) {
    const candidate = migrateLegacyRecord(item, topTimestamp, topDeviceId);
    const codeOwner = codeToId.get(candidate.fundCode);
    if (codeOwner && codeOwner !== candidate.id) {
      throw new HoldingSchemaError('fund_code_identity_conflict', `fundCode ${candidate.fundCode} is assigned to multiple ids`);
    }
    const current = byId.get(candidate.id);
    if (current && current.fundCode !== candidate.fundCode) {
      throw new HoldingSchemaError('id_fund_code_conflict', `id ${candidate.id} points to multiple fund codes`);
    }
    if (!current || compareHoldingRecords(current, candidate) < 0) byId.set(candidate.id, candidate);
    codeToId.set(candidate.fundCode, candidate.id);
  }

  const latestRecordTime = [...byId.values()].reduce(
    (latest, holding) => holding.updatedAt > latest ? holding.updatedAt : latest,
    topTimestamp
  );
  return normalizeHoldingsDocumentV3({
    schema: HOLDINGS_SCHEMA_VERSION,
    updatedAt: latestRecordTime,
    deviceId: topDeviceId,
    holdings: [...byId.values()],
  });
}

function parseValue(value) {
  if (typeof value !== 'string') return value;
  if (!value.trim()) throw new HoldingSchemaError('empty_payload', 'holdings payload is empty');
  try { return JSON.parse(value); }
  catch (error) { throw new HoldingSchemaError('invalid_json', 'holdings payload is not valid JSON', { cause: error.message }); }
}

export function parseAndMigrateHoldings(value, options = {}) {
  try {
    const parsed = parseValue(value);
    if (Array.isArray(parsed)) {
      const document = migrateLegacyHoldingsToV3(parsed, options);
      return Object.freeze({ ok: true, sourceSchema: 1, readonly: false, migrated: true, empty: document.holdings.length === 0, document });
    }
    if (!isObject(parsed)) throw new HoldingSchemaError('invalid_payload', 'holdings payload must be an object or array');
    const sourceSchema = Number(parsed.schema);
    if (!Number.isSafeInteger(sourceSchema) || sourceSchema < 1) {
      throw new HoldingSchemaError('invalid_schema', 'holdings schema must be a positive integer');
    }
    if (sourceSchema === HOLDINGS_SCHEMA_VERSION) {
      const document = normalizeHoldingsDocumentV3(parsed);
      return Object.freeze({ ok: true, sourceSchema, readonly: false, migrated: false, empty: document.holdings.length === 0, document });
    }
    if (sourceSchema < HOLDINGS_SCHEMA_VERSION) {
      const document = migrateLegacyHoldingsToV3(parsed, options);
      return Object.freeze({ ok: true, sourceSchema, readonly: false, migrated: true, empty: document.holdings.length === 0, document });
    }
    if (!Array.isArray(parsed.holdings)) throw new HoldingSchemaError('invalid_holdings', 'future schema holdings must be an array');
    // A future schema may change field meaning. Preserve the decoded value for
    // diagnostics/read-only display, but never project it into writable V3.
    return Object.freeze({
      ok: true,
      sourceSchema,
      readonly: true,
      migrated: false,
      empty: parsed.holdings.length === 0,
      document: null,
      raw: parsed,
      reason: 'future_schema_readonly',
    });
  } catch (error) {
    const failure = error instanceof HoldingSchemaError
      ? error
      : new HoldingSchemaError('parse_failed', error?.message || 'holdings payload parse failed');
    return Object.freeze({ ok: false, sourceSchema: null, readonly: true, migrated: false, empty: false, document: null, error: failure });
  }
}

function legacySemanticFingerprint(value) {
  const holding = normalizeHoldingRecordV3(value);
  return JSON.stringify({
    fundCode: holding.fundCode,
    fundName: holding.fundName,
    shares: holding.shares,
    costNav: holding.costNav,
    deleted: holding.deletedAt != null,
    note: holding.note,
  });
}

function compareCompatibleRecords(leftValue, rightValue) {
  const left = normalizeHoldingRecordV3(leftValue);
  const right = normalizeHoldingRecordV3(rightValue);
  const leftDeleted = left.deletedAt != null;
  const rightDeleted = right.deletedAt != null;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? 1 : -1;
  if (leftDeleted !== rightDeleted) return leftDeleted ? 1 : -1;
  const leftFingerprint = legacySemanticFingerprint(left);
  const rightFingerprint = legacySemanticFingerprint(right);
  if (leftFingerprint === rightFingerprint) return 0;
  return leftFingerprint > rightFingerprint ? 1 : -1;
}

function liftLegacyWinner(legacyValue, v3Value, deviceId) {
  const legacy = normalizeHoldingRecordV3(legacyValue);
  const v3 = v3Value ? normalizeHoldingRecordV3(v3Value) : null;
  return normalizeHoldingRecordV3({
    ...legacy,
    id: stableHoldingId(legacy.fundCode),
    createdAt: v3?.createdAt || legacy.createdAt,
    revision: v3 ? v3.revision + 1 : 1,
    deviceId: String(deviceId || legacy.deviceId || 'legacy-device').trim().slice(0, 120) || 'legacy-device',
    deletedAt: legacy.deletedAt == null ? null : legacy.updatedAt,
    // Schema 1/2 cannot express notes. A newer legacy edit may update shares,
    // cost or name, but absence of a note in that projection is never evidence
    // that the user deleted V3-only metadata.
    note: v3?.note ?? legacy.note,
  });
}

function chooseOriginAware(left, leftSchema, right, rightSchema, deviceId) {
  const leftTrusted = leftSchema === HOLDINGS_SCHEMA_VERSION;
  const rightTrusted = rightSchema === HOLDINGS_SCHEMA_VERSION;
  if (leftTrusted && rightTrusted) return compareHoldingRecords(left, right) >= 0 ? left : right;

  const leftSemantic = legacySemanticFingerprint(left);
  const rightSemantic = legacySemanticFingerprint(right);
  if (leftSemantic === rightSemantic) {
    if (leftTrusted !== rightTrusted) return leftTrusted ? left : right;
    return compareCompatibleRecords(left, right) >= 0 ? left : right;
  }

  const leftDeleted = left.deletedAt != null;
  const rightDeleted = right.deletedAt != null;
  // A Schema 1/2 active row cannot prove an explicit re-add, so it may never
  // resurrect a V3 tombstone. Re-adding requires a new V3 revision.
  if (leftTrusted && leftDeleted && !rightTrusted && !rightDeleted) return left;
  if (rightTrusted && rightDeleted && !leftTrusted && !leftDeleted) return right;

  // When an old projection is written back unchanged, its V3-only metadata is
  // necessarily missing. At the same timestamp the authoritative V3 record
  // must survive instead of treating that loss as a new edit.
  if (leftTrusted !== rightTrusted && left.updatedAt === right.updatedAt) {
    return leftTrusted ? left : right;
  }

  const winner = compareCompatibleRecords(left, right) >= 0 ? left : right;
  const winnerTrusted = winner === left ? leftTrusted : rightTrusted;
  if (winnerTrusted) return winner;
  const trustedPeer = leftTrusted ? left : (rightTrusted ? right : null);
  return liftLegacyWinner(winner, trustedPeer, deviceId);
}

function requireWritableParsed(value, side) {
  if (!value?.ok) throw value?.error || new HoldingSchemaError('invalid_payload', `${side} holdings payload is invalid`);
  if (value.readonly || !value.document) {
    throw new HoldingSchemaError('readonly_schema', `${side} holdings payload is read-only`, { sourceSchema: value.sourceSchema });
  }
  return value;
}

/**
 * Merge already-parsed documents while retaining their source-schema trust.
 * Revision ordering is used only when both sides really came from Schema 3.
 */
export function mergeParsedHoldings(localValue, remoteValue, options = {}) {
  const local = requireWritableParsed(localValue, 'local');
  const remote = requireWritableParsed(remoteValue, 'remote');
  const byCode = new Map(local.document.holdings.map(holding => [holding.fundCode, holding]));

  for (const candidate of remote.document.holdings) {
    const current = byCode.get(candidate.fundCode);
    if (!current) {
      byCode.set(candidate.fundCode, remote.sourceSchema === HOLDINGS_SCHEMA_VERSION
        ? candidate
        : liftLegacyWinner(candidate, null, options.deviceId));
      continue;
    }
    byCode.set(candidate.fundCode, chooseOriginAware(
      current,
      local.sourceSchema,
      candidate,
      remote.sourceSchema,
      options.deviceId
    ));
  }

  const holdings = [...byCode.values()];
  const updatedAt = holdings.reduce(
    (latest, holding) => holding.updatedAt > latest ? holding.updatedAt : latest,
    local.document.updatedAt > remote.document.updatedAt ? local.document.updatedAt : remote.document.updatedAt
  );
  return Object.freeze({
    document: normalizeHoldingsDocumentV3({
      schema: HOLDINGS_SCHEMA_VERSION,
      updatedAt,
      deviceId: String(options.deviceId || local.document.deviceId || remote.document.deviceId).trim(),
      holdings,
    }),
    localSchema: local.sourceSchema,
    remoteSchema: remote.sourceSchema,
  });
}
