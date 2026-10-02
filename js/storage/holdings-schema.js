export const HOLDINGS_SCHEMA_VERSION = 3;
export const LEGACY_HOLDING_EPOCH = '1970-01-01T00:00:00.000Z';

const FUND_CODE_RE = /^\d{6}$/;
const MAX_TEXT = 160;

export class HoldingSchemaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HoldingSchemaError';
    this.code = code;
    this.details = details;
  }
}

function record(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function text(value, field, { fallback = '', required = false, maximum = MAX_TEXT, nullable = false } = {}) {
  if (nullable && value == null) return null;
  const candidate = value == null ? fallback : value;
  if (typeof candidate !== 'string') {
    throw new HoldingSchemaError('invalid_text', `${field} must be a string`, { field });
  }
  const output = candidate.trim();
  if (required && !output) throw new HoldingSchemaError('invalid_text', `${field} must be a non-empty string`, { field });
  if (output.length > maximum) {
    throw new HoldingSchemaError('text_too_long', `${field} exceeds ${maximum} characters`, { field, maximum });
  }
  return output;
}

function nonNegativeNumber(value, field, { nullable = false } = {}) {
  if (nullable && (value == null || value === '')) return null;
  if (value == null || value === '') throw new HoldingSchemaError('invalid_number', `${field} is required`, { field });
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new HoldingSchemaError('invalid_number', `${field} must be a non-negative finite number`, { field });
  }
  return value;
}

function positiveRevision(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new HoldingSchemaError('invalid_revision', 'revision must be a positive safe integer', { field: 'revision' });
  }
  return value;
}

export function normalizeHoldingTimestamp(value, field = 'timestamp') {
  const source = text(value, field, { required: true, maximum: 80 });
  const time = Date.parse(source);
  if (!Number.isFinite(time)) throw new HoldingSchemaError('invalid_timestamp', `${field} must be a valid timestamp`, { field });
  return new Date(time).toISOString();
}

function nullableTimestamp(value, field) {
  return value == null || value === '' ? null : normalizeHoldingTimestamp(value, field);
}

export function stableHoldingId(fundCode) {
  const code = typeof fundCode === 'string' ? fundCode.trim() : '';
  if (!FUND_CODE_RE.test(code)) throw new HoldingSchemaError('invalid_fund_code', 'fundCode must contain exactly six digits');
  return `fund:${code}`;
}

export function normalizeHoldingRecordV3(value) {
  if (!record(value)) throw new HoldingSchemaError('invalid_record', 'holding must be an object');
  const fundCode = text(value.fundCode, 'fundCode', { required: true, maximum: 6 });
  if (!FUND_CODE_RE.test(fundCode)) throw new HoldingSchemaError('invalid_fund_code', 'fundCode must contain exactly six digits');
  const createdAt = normalizeHoldingTimestamp(value.createdAt, 'createdAt');
  const updatedAt = normalizeHoldingTimestamp(value.updatedAt, 'updatedAt');
  const deletedAt = nullableTimestamp(value.deletedAt, 'deletedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new HoldingSchemaError('invalid_timestamp_order', 'updatedAt cannot be earlier than createdAt', { fundCode });
  }
  if (deletedAt && Date.parse(deletedAt) < Date.parse(createdAt)) {
    throw new HoldingSchemaError('invalid_timestamp_order', 'deletedAt cannot be earlier than createdAt', { fundCode });
  }
  if (deletedAt && deletedAt !== updatedAt) {
    throw new HoldingSchemaError('invalid_deleted_timestamp', 'deletedAt must equal updatedAt for a tombstone', { fundCode });
  }
  const id = text(value.id, 'id', { required: true, maximum: 120 });
  if (id !== stableHoldingId(fundCode)) {
    throw new HoldingSchemaError('invalid_stable_id', `id must equal fund:${fundCode}`, { fundCode, id });
  }
  return Object.freeze({
    id,
    fundCode,
    fundName: text(value.fundName, 'fundName', { fallback: fundCode, maximum: 120 }) || fundCode,
    shares: nonNegativeNumber(value.shares, 'shares'),
    costNav: nonNegativeNumber(value.costNav, 'costNav', { nullable: true }),
    createdAt,
    updatedAt,
    deletedAt,
    revision: positiveRevision(value.revision),
    deviceId: text(value.deviceId, 'deviceId', { required: true, maximum: 120 }),
    note: text(value.note, 'note', { maximum: 500, nullable: true }),
  });
}

export function normalizeHoldingsDocumentV3(value) {
  if (!record(value) || Number(value.schema) !== HOLDINGS_SCHEMA_VERSION) {
    throw new HoldingSchemaError('unsupported_schema', 'expected holdings schema 3');
  }
  if (!Array.isArray(value.holdings)) throw new HoldingSchemaError('invalid_holdings', 'holdings must be an array');
  const holdings = value.holdings.map(normalizeHoldingRecordV3);
  const ids = new Set();
  const codes = new Set();
  for (const holding of holdings) {
    if (ids.has(holding.id)) throw new HoldingSchemaError('duplicate_id', `duplicate holding id: ${holding.id}`);
    if (codes.has(holding.fundCode)) throw new HoldingSchemaError('duplicate_fund_code', `duplicate fundCode: ${holding.fundCode}`);
    ids.add(holding.id);
    codes.add(holding.fundCode);
  }
  const updatedAt = normalizeHoldingTimestamp(value.updatedAt, 'updatedAt');
  const latestRecordTime = holdings.reduce(
    (latest, holding) => holding.updatedAt > latest ? holding.updatedAt : latest,
    LEGACY_HOLDING_EPOCH
  );
  if (updatedAt < latestRecordTime) {
    throw new HoldingSchemaError('invalid_document_timestamp', 'document updatedAt cannot be earlier than a holding update', {
      updatedAt,
      latestRecordTime,
    });
  }
  return Object.freeze({
    schema: HOLDINGS_SCHEMA_VERSION,
    updatedAt,
    deviceId: text(value.deviceId, 'deviceId', { required: true, maximum: 120 }),
    holdings: Object.freeze(holdings.sort((left, right) => left.id.localeCompare(right.id))),
  });
}

export function createEmptyHoldingsDocument(deviceId, updatedAt = LEGACY_HOLDING_EPOCH) {
  return normalizeHoldingsDocumentV3({ schema: 3, updatedAt, deviceId, holdings: [] });
}

export function holdingRecordFingerprint(value) {
  return JSON.stringify(normalizeHoldingRecordV3(value));
}

export function compareHoldingRecords(leftValue, rightValue) {
  const left = normalizeHoldingRecordV3(leftValue);
  const right = normalizeHoldingRecordV3(rightValue);
  if (left.id !== right.id || left.fundCode !== right.fundCode) {
    throw new HoldingSchemaError('identity_conflict', 'cannot compare holdings with different identities');
  }
  if (left.revision !== right.revision) return left.revision > right.revision ? 1 : -1;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? 1 : -1;
  const leftDeleted = left.deletedAt != null;
  const rightDeleted = right.deletedAt != null;
  if (leftDeleted !== rightDeleted) return leftDeleted ? 1 : -1;
  if (left.deviceId !== right.deviceId) return left.deviceId > right.deviceId ? 1 : -1;
  const leftFingerprint = holdingRecordFingerprint(left);
  const rightFingerprint = holdingRecordFingerprint(right);
  if (leftFingerprint === rightFingerprint) return 0;
  return leftFingerprint > rightFingerprint ? 1 : -1;
}

export function mergeHoldingsDocuments(leftValue, rightValue) {
  const left = normalizeHoldingsDocumentV3(leftValue);
  const right = normalizeHoldingsDocumentV3(rightValue);
  const byId = new Map(left.holdings.map(holding => [holding.id, holding]));
  const codeToId = new Map(left.holdings.map(holding => [holding.fundCode, holding.id]));

  for (const candidate of right.holdings) {
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

  return normalizeHoldingsDocumentV3({
    schema: HOLDINGS_SCHEMA_VERSION,
    updatedAt: left.updatedAt > right.updatedAt ? left.updatedAt : right.updatedAt,
    deviceId: left.deviceId > right.deviceId ? left.deviceId : right.deviceId,
    holdings: [...byId.values()],
  });
}

export function toLegacyHoldings(value) {
  const document = normalizeHoldingsDocumentV3(value);
  return document.holdings.map(holding => ({
    code: holding.fundCode,
    name: holding.fundName,
    shares: holding.shares,
    cost: holding.costNav,
    updated_at: holding.updatedAt,
    deleted: holding.deletedAt != null,
    note: holding.note,
  }));
}

export function canonicalHoldingsDocument(value) {
  return JSON.stringify(normalizeHoldingsDocumentV3(value));
}
