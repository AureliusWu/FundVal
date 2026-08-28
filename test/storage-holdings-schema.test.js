import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HoldingSchemaError,
  canonicalHoldingsDocument,
  compareHoldingRecords,
  mergeHoldingsDocuments,
  normalizeHoldingRecordV3,
  normalizeHoldingsDocumentV3,
  stableHoldingId,
} from '../js/storage/holdings-schema.js';
import {
  mergeParsedHoldings,
  migrateLegacyHoldingsToV3,
  parseAndMigrateHoldings,
} from '../js/storage/holdings-migration.js';

const T0 = '2026-08-20T00:00:00.000Z';
const T1 = '2026-08-21T00:00:00.000Z';
const T2 = '2026-08-22T00:00:00.000Z';

function holding(code, overrides = {}) {
  return {
    id: stableHoldingId(code),
    fundCode: code,
    fundName: `基金${code}`,
    shares: 10,
    costNav: 1.25,
    createdAt: T0,
    updatedAt: T1,
    deletedAt: null,
    revision: 1,
    deviceId: 'device:a',
    note: null,
    ...overrides,
  };
}

function document(holdings, overrides = {}) {
  return {
    schema: 3,
    updatedAt: T2,
    deviceId: 'device:a',
    holdings,
    ...overrides,
  };
}

test('strict V3 keeps explicit zero distinct from null and rejects missing shares', () => {
  const zero = normalizeHoldingRecordV3(holding('000001', { shares: 0, costNav: 0 }));
  const missingCost = normalizeHoldingRecordV3(holding('000002', { shares: 0, costNav: null }));

  assert.equal(zero.shares, 0);
  assert.equal(zero.costNav, 0);
  assert.equal(missingCost.shares, 0);
  assert.equal(missingCost.costNav, null);
  assert.notEqual(JSON.stringify(zero), JSON.stringify(missingCost));

  assert.throws(
    () => normalizeHoldingRecordV3(holding('000003', { shares: undefined })),
    error => error instanceof HoldingSchemaError && error.code === 'invalid_number',
  );
});

test('strict V3 rejects duplicate identities and ids that do not match their fund code', () => {
  assert.throws(
    () => normalizeHoldingsDocumentV3(document([
      holding('000010'),
      holding('000010'),
    ])),
    error => error instanceof HoldingSchemaError && error.code === 'duplicate_id',
  );

  assert.throws(
    () => normalizeHoldingRecordV3(holding('000011', { id: 'record:wrong' })),
    error => error instanceof HoldingSchemaError && error.code === 'invalid_stable_id',
  );

  assert.throws(
    () => compareHoldingRecords(holding('000013'), holding('000014')),
    error => error instanceof HoldingSchemaError && error.code === 'identity_conflict',
  );
});

test('document updatedAt cannot be older than a contained record', () => {
  assert.throws(
    () => normalizeHoldingsDocumentV3(document([
      holding('000020', { updatedAt: T2 }),
    ], { updatedAt: T1 })),
    error => error instanceof HoldingSchemaError && error.code === 'invalid_document_timestamp',
  );
});

test('legacy migration is deterministic across devices and idempotent after V3', () => {
  const legacy = {
    schema: 2,
    updated_at: T1,
    device_id: 'legacy-origin',
    holdings: [{
      code: '000101',
      name: '旧基金',
      shares: 12.5,
      cost: 1.1,
      updated_at: T1,
    }],
  };

  const fromPhone = migrateLegacyHoldingsToV3(legacy, { deviceId: 'current-phone' });
  const fromDesktop = migrateLegacyHoldingsToV3(legacy, { deviceId: 'current-desktop' });
  assert.equal(canonicalHoldingsDocument(fromPhone), canonicalHoldingsDocument(fromDesktop));
  assert.equal(fromPhone.deviceId, 'legacy-origin');
  assert.equal(fromPhone.holdings[0].deviceId, 'legacy-origin');

  const reparsed = parseAndMigrateHoldings(canonicalHoldingsDocument(fromPhone));
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.migrated, false);
  assert.equal(canonicalHoldingsDocument(reparsed.document), canonicalHoldingsDocument(fromPhone));
});

test('legacy migration preserves absent cost as null and explicit zero as zero', () => {
  const migrated = migrateLegacyHoldingsToV3([
    { code: '000201', name: '未提供成本', shares: 3, updated_at: T1 },
    { code: '000202', name: '零成本', shares: 4, cost: 0, updated_at: T1 },
  ]);

  assert.equal(migrated.holdings.find(item => item.fundCode === '000201').costNav, null);
  assert.equal(migrated.holdings.find(item => item.fundCode === '000202').costNav, 0);
});

test('legacy migration fails the whole payload when shares are missing', () => {
  const result = parseAndMigrateHoldings({
    schema: 2,
    updated_at: T1,
    device_id: 'legacy-origin',
    holdings: [
      { code: '000301', name: '完整', shares: 1, cost: 1, updated_at: T1 },
      { code: '000302', name: '损坏', cost: 1, updated_at: T1 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.document, null);
  assert.equal(result.readonly, true);
  assert.equal(result.error.code, 'invalid_legacy_number');
});

test('future schema remains readonly without creating a writable V3 projection', () => {
  const future = {
    schema: 4,
    updatedAt: T2,
    deviceId: 'future-device',
    holdings: [holding('000401', { deviceId: 'future-device' })],
    futureOnlyField: { retainedByRemote: true },
  };
  const result = parseAndMigrateHoldings(future);

  assert.equal(result.ok, true);
  assert.equal(result.sourceSchema, 4);
  assert.equal(result.readonly, true);
  assert.equal(result.migrated, false);
  assert.equal(result.document, null);
  assert.equal(result.reason, 'future_schema_readonly');
  assert.deepEqual(result.raw, future);
});

test('merge is commutative and keeps union records without treating absence as deletion', () => {
  const left = document([
    holding('000501', { revision: 1, fundName: '左侧旧值' }),
    holding('000502', { deviceId: 'device:a' }),
  ], { updatedAt: T1, deviceId: 'device:a' });
  const right = document([
    holding('000501', { revision: 2, updatedAt: T2, fundName: '右侧新值', deviceId: 'device:b' }),
    holding('000503', { deviceId: 'device:b' }),
  ], { updatedAt: T2, deviceId: 'device:b' });

  const leftRight = mergeHoldingsDocuments(left, right);
  const rightLeft = mergeHoldingsDocuments(right, left);
  assert.equal(canonicalHoldingsDocument(leftRight), canonicalHoldingsDocument(rightLeft));
  assert.deepEqual(leftRight.holdings.map(item => item.fundCode), ['000501', '000502', '000503']);
  assert.equal(leftRight.holdings.find(item => item.fundCode === '000501').fundName, '右侧新值');
  assert.equal(leftRight.holdings.find(item => item.fundCode === '000502').deletedAt, null);
});

test('equal revision and timestamp tombstone wins in either merge order', () => {
  const live = holding('000601', { revision: 5, updatedAt: T2, deviceId: 'device:z' });
  const tombstone = holding('000601', {
    revision: 5,
    updatedAt: T2,
    deletedAt: T2,
    deviceId: 'device:a',
  });

  assert.ok(compareHoldingRecords(tombstone, live) > 0);
  const first = mergeHoldingsDocuments(document([live]), document([tombstone]));
  const second = mergeHoldingsDocuments(document([tombstone]), document([live]));
  assert.equal(first.holdings[0].deletedAt, T2);
  assert.equal(canonicalHoldingsDocument(first), canonicalHoldingsDocument(second));
});

test('a genuinely newer Schema 2 edit is lifted without erasing V3-only metadata', () => {
  const v3 = parseAndMigrateHoldings(document([holding('000701', {
    shares: 10,
    revision: 9,
    updatedAt: T1,
    note: '保留',
  })], { updatedAt: T1 }));
  const legacy = parseAndMigrateHoldings({
    schema: 2,
    updated_at: T2,
    device_id: 'legacy-phone',
    holdings: [{
      code: '000701', name: '基金000701', shares: 12, cost: 1.25,
      updated_at: T2, deleted: false,
    }],
  });
  const merged = mergeParsedHoldings(v3, legacy, { deviceId: 'device:a' }).document.holdings[0];
  assert.equal(merged.shares, 12);
  assert.equal(merged.revision, 10);
  assert.equal(merged.updatedAt, T2);
  assert.equal(merged.note, '保留');
});

test('an unchanged or lossy equal-time Schema 2 projection cannot erase V3 metadata', () => {
  const v3Record = holding('000702', { costNav: null, revision: 6, updatedAt: T2, note: '保留' });
  const v3 = parseAndMigrateHoldings(document([v3Record], { updatedAt: T2 }));
  const projection = parseAndMigrateHoldings({
    schema: 2,
    updated_at: T2,
    device_id: 'old-tab',
    holdings: [{
      code: '000702', name: v3Record.fundName, shares: 10, cost: 0,
      updated_at: T2, deleted: false,
    }],
  });
  const merged = mergeParsedHoldings(v3, projection, { deviceId: 'device:a' }).document.holdings[0];
  assert.equal(merged.costNav, null);
  assert.equal(merged.note, '保留');
  assert.equal(merged.revision, 6);
});

test('a legacy active row cannot resurrect a V3 tombstone even with a later clock', () => {
  const tombstone = parseAndMigrateHoldings(document([holding('000703', {
    revision: 5,
    updatedAt: T1,
    deletedAt: T1,
  })], { updatedAt: T1 }));
  const staleDevice = parseAndMigrateHoldings({
    schema: 2,
    updated_at: T2,
    device_id: 'offline-old-device',
    holdings: [{
      code: '000703', name: '基金000703', shares: 10, cost: 1.25,
      updated_at: T2, deleted: false,
    }],
  });
  const merged = mergeParsedHoldings(tombstone, staleDevice, { deviceId: 'device:a' }).document.holdings[0];
  assert.equal(merged.deletedAt, T1);
  assert.equal(merged.revision, 5);
});
