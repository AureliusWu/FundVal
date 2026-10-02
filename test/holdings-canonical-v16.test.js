import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HoldingSchemaError, holdingRecordFingerprint, canonicalHoldingsDocument,
  normalizeHoldingRecordV3, normalizeHoldingsDocumentV3, compareHoldingRecords, mergeHoldingsDocuments,
} from '../js/storage/holdings-schema.js';

const T0 = '2026-08-20T00:00:00.000Z';
const T1 = '2026-08-21T00:00:00.000Z';
const T2 = '2026-08-22T00:00:00.000Z';
const RECORD_KEYS = ['id', 'fundCode', 'fundName', 'shares', 'costNav', 'createdAt', 'updatedAt',
  'deletedAt', 'revision', 'deviceId', 'note'];
const GOLD_A = '{"id":"fund:000001","fundCode":"000001","fundName":"Alpha","shares":0,"costNav":0,"createdAt":"2026-08-20T00:00:00.000Z","updatedAt":"2026-08-21T00:00:00.000Z","deletedAt":null,"revision":1,"deviceId":"device:a","note":null}';
const GOLD_B = String.raw`{"id":"fund:000002","fundCode":"000002","fundName":"合成基金「α」📈","shares":12.5,"costNav":null,"createdAt":"2026-08-20T00:00:00.000Z","updatedAt":"2026-08-21T00:00:00.000Z","deletedAt":null,"revision":7,"deviceId":"device:phone","note":"备注 \"A\"\\路径\n第二行"}`;
const GOLD_C = '{"id":"fund:000003","fundCode":"000003","fundName":"Deleted","shares":1,"costNav":null,"createdAt":"2026-08-20T00:00:00.000Z","updatedAt":"2026-08-21T00:00:00.000Z","deletedAt":"2026-08-21T00:00:00.000Z","revision":8,"deviceId":"device:tablet","note":"删除记录"}';

function holding(code = '000001', overrides = {}) {
  return { id: `fund:${code}`, fundCode: code, fundName: `Synthetic ${code}`, shares: 10, costNav: 1.25,
    createdAt: T0, updatedAt: T1, deletedAt: null, revision: 1, deviceId: 'device:a', note: null, ...overrides };
}

function document(rows, overrides = {}) {
  return { schema: 3, updatedAt: T2, deviceId: 'document:device', holdings: rows, ...overrides };
}

function exactBytes(actual, expected) {
  assert.equal(actual, expected);
  assert.deepEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

// Frozen pre-optimization projections are an independent byte oracle. Keep
// these explicit so future normalized fields cannot silently enter CAS hashes.
function referenceFingerprint(value) {
  const row = normalizeHoldingRecordV3(value);
  return JSON.stringify({ id: row.id, fundCode: row.fundCode, fundName: row.fundName,
    shares: row.shares, costNav: row.costNav, createdAt: row.createdAt, updatedAt: row.updatedAt,
    deletedAt: row.deletedAt, revision: row.revision, deviceId: row.deviceId, note: row.note });
}

function referenceDocument(value) {
  const doc = normalizeHoldingsDocumentV3(value);
  return JSON.stringify({ schema: doc.schema, updatedAt: doc.updatedAt, deviceId: doc.deviceId,
    holdings: doc.holdings.map(row => JSON.parse(referenceFingerprint(row))) });
}

function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

function schemaError(action, code) {
  assert.throws(action, error => error instanceof HoldingSchemaError && error.code === code);
}

test('record fingerprint has fixed UTF-8 bytes, field order, Unicode and ISO normalization', () => {
  const raw = holding('000002', { fundName: '  合成基金「α」📈  ', shares: 12.5, costNav: null,
    createdAt: '2026-08-20T08:00:00+08:00', updatedAt: '2026-08-20T20:00:00-04:00',
    revision: 7, deviceId: ' device:phone ', note: '  备注 "A"\\路径\n第二行  ', extra: 'not canonical' });
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  exactBytes(holdingRecordFingerprint(reordered), GOLD_B);
  assert.deepEqual(Object.keys(JSON.parse(holdingRecordFingerprint(raw))), RECORD_KEYS);
  assert.doesNotMatch(holdingRecordFingerprint(raw), /extra|not canonical/);
});

test('canonical document has exact ordered bytes and sorted complete records, including tombstones', () => {
  const rows = [JSON.parse(GOLD_C), JSON.parse(GOLD_B), JSON.parse(GOLD_A)];
  const raw = { extra: 'ignored', holdings: rows, deviceId: ' document:device ',
    updatedAt: '2026-08-22T08:00:00+08:00', schema: '3' };
  const expected = `{"schema":3,"updatedAt":"${T2}","deviceId":"document:device","holdings":[${GOLD_A},${GOLD_B},${GOLD_C}]}`;
  exactBytes(canonicalHoldingsDocument(raw), expected);
  assert.deepEqual(Object.keys(JSON.parse(expected)), ['schema', 'updatedAt', 'deviceId', 'holdings']);
  exactBytes(canonicalHoldingsDocument(JSON.parse(expected)), expected);
});

test('empty documents preserve canonical field order without an invented record or device', () => {
  exactBytes(canonicalHoldingsDocument(document([], { updatedAt: T0, deviceId: ' empty:device ' })),
    `{"schema":3,"updatedAt":"${T0}","deviceId":"empty:device","holdings":[]}`);
});

test('null, missing or empty cost stays distinct from explicit zero and shares never disappears', () => {
  const zero = holding('000001', { fundName: 'Alpha', shares: 0, costNav: 0 });
  exactBytes(holdingRecordFingerprint(zero), GOLD_A);
  for (const costNav of [null, undefined, '']) {
    exactBytes(holdingRecordFingerprint({ ...zero, costNav }), GOLD_A.replace('"costNav":0', '"costNav":null'));
  }
  assert.notEqual(holdingRecordFingerprint(zero), holdingRecordFingerprint({ ...zero, costNav: null }));
  assert.equal(JSON.parse(holdingRecordFingerprint(zero)).shares, 0);
  exactBytes(holdingRecordFingerprint({ ...zero, shares: -0, costNav: -0 }), GOLD_A);
});

test('every canonical record field contributes to its byte fingerprint', () => {
  const base = holding();
  const fingerprint = holdingRecordFingerprint(base);
  const variants = [
    { id: 'fund:000002', fundCode: '000002' }, { fundName: 'Changed name' }, { shares: 0 }, { costNav: null },
    { createdAt: '2026-08-19T00:00:00Z' }, { updatedAt: T2 }, { deletedAt: T1 }, { revision: 2 },
    { deviceId: 'device:b' }, { note: '' }, { note: '保留📈' },
  ];
  for (const variant of variants) {
    assert.notEqual(holdingRecordFingerprint({ ...base, ...variant }), fingerprint, JSON.stringify(variant));
  }
});

test('serialization byte oracle holds across cost, note, tombstone, revision and device matrices', () => {
  for (const costNav of [null, 0, 1.25]) for (const note of [null, '', 'Unicode 合成📈', 'quote " slash \\ line\nnext']) {
    for (const deleted of [false, true]) for (const revision of [1, 9]) for (const deviceId of ['device:a', '设备:b']) {
      const row = holding('000002', { costNav, note, deletedAt: deleted ? T1 : null, revision, deviceId });
      exactBytes(holdingRecordFingerprint(row), referenceFingerprint(row));
      const doc = document([row, holding('000001', { shares: 0, costNav: 0 })]);
      exactBytes(canonicalHoldingsDocument(doc), referenceDocument(doc));
    }
  }
});

test('finite numeric serialization, negative zero and small exponential values remain byte-identical', () => {
  for (const shares of [-0, 0, 1e-8, 1.23456789, Number.MAX_SAFE_INTEGER, 1e30]) {
    for (const costNav of [-0, 0, 1e-8, 1e30]) {
      const row = holding('000001', { shares, costNav });
      exactBytes(holdingRecordFingerprint(row), referenceFingerprint(row));
      exactBytes(canonicalHoldingsDocument(document([row])), referenceDocument(document([row])));
    }
  }
});

test('invalid record errors and validation order are unchanged in fingerprint and document entry points', () => {
  const cases = [
    [null, 'invalid_record'], [[], 'invalid_record'],
    [holding('000001', { fundCode: '' }), 'invalid_text'],
    [holding('000001', { fundCode: '00x001' }), 'invalid_fund_code'],
    [holding('000001', { fundCode: '0000001' }), 'text_too_long'],
    [holding('000001', { createdAt: 'bad-time' }), 'invalid_timestamp'],
    [holding('000001', { createdAt: 1 }), 'invalid_text'],
    [holding('000001', { updatedAt: '2026-08-19T00:00:00Z' }), 'invalid_timestamp_order'],
    [holding('000001', { deletedAt: '2026-08-19T00:00:00Z' }), 'invalid_timestamp_order'],
    [holding('000001', { deletedAt: T2 }), 'invalid_deleted_timestamp'],
    [holding('000001', { id: 'fund:000002' }), 'invalid_stable_id'],
    ...[undefined, null, '', '10', -1, NaN, Infinity].map(shares => [holding('000001', { shares }), 'invalid_number']),
    [holding('000001', { costNav: -1 }), 'invalid_number'],
    ...[0, '1', Number.MAX_SAFE_INTEGER + 1].map(revision => [holding('000001', { revision }), 'invalid_revision']),
    [holding('000001', { deviceId: '' }), 'invalid_text'],
    [holding('000001', { note: 'x'.repeat(501) }), 'text_too_long'],
    [holding('000001', { note: {} }), 'invalid_text'],
    [holding('000001', { fundName: {} }), 'invalid_text'],
    [holding('000001', { fundCode: 'bad', createdAt: 'bad-time', shares: -1 }), 'invalid_fund_code'],
  ];
  for (const [row, code] of cases) {
    schemaError(() => holdingRecordFingerprint(row), code);
    schemaError(() => canonicalHoldingsDocument(document([row])), code);
  }
});

test('canonical document rejects invalid schemas, duplicate identity and malformed metadata unchanged', () => {
  const cases = [
    [null, 'unsupported_schema'], [[], 'unsupported_schema'], [document([], { schema: 4 }), 'unsupported_schema'],
    [document(null), 'invalid_holdings'],
    [document([holding(), holding()]), 'duplicate_id'],
    [document([holding()], { updatedAt: T0 }), 'invalid_document_timestamp'],
    [document([], { updatedAt: 'bad-time' }), 'invalid_timestamp'],
    [document([], { deviceId: '' }), 'invalid_text'],
    [document(null, { schema: 4 }), 'unsupported_schema'],
  ];
  for (const [doc, code] of cases) schemaError(() => canonicalHoldingsDocument(doc), code);
});

test('fingerprint and document serialization do not mutate or freeze caller records or order', () => {
  const rows = [holding('000003'), holding('000001'), holding('000002', { note: ' 原始备注 ' })];
  const raw = document(rows, { extra: { synthetic: true } });
  const before = structuredClone(raw);
  holdingRecordFingerprint(rows[2]);
  canonicalHoldingsDocument(raw);
  assert.deepEqual(raw, before);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(Object.isFrozen(rows), false);
  assert.ok(rows.every(row => !Object.isFrozen(row)));
  canonicalHoldingsDocument(frozen(raw));
  exactBytes(canonicalHoldingsDocument(raw), referenceDocument(before));
});

test('compare fingerprint ties and merge winners retain exact bytes in both merge orders', () => {
  const variants = [holding('000001', { note: null }), holding('000001', { note: '' }),
    holding('000001', { note: 'Alpha' }), holding('000001', { note: 'Zulu' }),
    holding('000001', { note: '合成📈' }), holding('000001', { costNav: null }), holding('000001', { shares: 0 })];
  for (const left of variants) for (const right of variants) {
    const leftBytes = referenceFingerprint(left), rightBytes = referenceFingerprint(right);
    const expected = leftBytes === rightBytes ? 0 : leftBytes > rightBytes ? 1 : -1;
    assert.equal(compareHoldingRecords(left, right), expected);
    const winning = expected >= 0 ? left : right;
    const leftDoc = frozen(document([left], { deviceId: 'document:a' }));
    const rightDoc = frozen(document([right], { deviceId: 'document:b' }));
    const before = [JSON.stringify(leftDoc), JSON.stringify(rightDoc)];
    const expectedBytes = referenceDocument(document([winning], { deviceId: 'document:b' }));
    exactBytes(canonicalHoldingsDocument(mergeHoldingsDocuments(leftDoc, rightDoc)), expectedBytes);
    exactBytes(canonicalHoldingsDocument(mergeHoldingsDocuments(rightDoc, leftDoc)), expectedBytes);
    assert.deepEqual([JSON.stringify(leftDoc), JSON.stringify(rightDoc)], before);
  }
});

test('revision, time, tombstone and device priorities precede the fingerprint tie breaker', () => {
  const baseline = holding('000001', { note: 'Zulu' });
  const higher = [
    holding('000001', { revision: 2, note: 'Alpha' }),
    holding('000001', { updatedAt: T2, note: 'Alpha' }),
    holding('000001', { deletedAt: T1, note: 'Alpha' }),
    holding('000001', { deviceId: 'device:z', note: 'Alpha' }),
  ];
  for (const winner of higher) {
    assert.equal(compareHoldingRecords(winner, baseline), 1);
    assert.equal(compareHoldingRecords(baseline, winner), -1);
    exactBytes(canonicalHoldingsDocument(mergeHoldingsDocuments(document([baseline]), document([winner]))),
      referenceDocument(document([winner])));
  }
  schemaError(() => compareHoldingRecords(baseline, holding('000002')), 'identity_conflict');
});
