import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEstimateRows, normalizeEstimateRow } from '../js/eastmoney-estimate.js';
import { fetchFundHoldings } from '../js/fund-holdings.js';
import {
  WORKER_FIXTURE_NOW as now, officialRow, intradayRow, holdingsModelRow, unavailableRow, qdiiRow,
  estimatesV1, estimatesV2, holdingRows, holdingsV1, holdingsV2,
} from './fixtures/worker-contract-v16.js';

const contract = () => import('../js/runtime/worker-contract.js');
const fixedError = (code) => (error) => error.name === 'WorkerContractError' && error.code === code;

async function withResponse(payload, callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json(payload);
  try { await callback(); } finally { globalThis.fetch = previous; }
}

test('v16: fresh and modeled quality statuses are not discarded as transport failures', () => {
  for (const row of [intradayRow(), holdingsModelRow()]) {
    const result = normalizeEstimateRow(row, { now });
    assert.equal(result.status, 'ok');
    assert.equal(result.source_status, row.status);
  }
});

test('v16: duplicate estimate codes fail closed instead of last-row-wins', async () => {
  await withResponse(estimatesV1([officialRow(), officialRow({ value_nav: 9 })]), async () => {
    await assert.rejects(fetchEstimateRows(['000001'], { now }), fixedError('WORKER_DUPLICATE_CODE'));
  });
});

test('v16: explicitly unknown schema cannot fall back to legacy v1', async () => {
  await withResponse(estimatesV1([officialRow()], { schema_version: 99 }), async () => {
    await assert.rejects(fetchEstimateRows(['000001'], { now }), fixedError('WORKER_SCHEMA_UNSUPPORTED'));
  });
});

test('v16: unknown top-level or row status cannot be silently accepted', async () => {
  for (const payload of [estimatesV1([officialRow()], { status: 'invented' }), estimatesV1([officialRow({ status: 'invented' })])]) {
    await withResponse(payload, async () => {
      await assert.rejects(fetchEstimateRows(['000001'], { now }), fixedError('WORKER_STATUS_INVALID'));
    });
  }
});

test('v16: proxy cannot return an unrequested code or contradictory counts', async () => {
  for (const payload of [estimatesV1([officialRow({ code: '000005' })]), estimatesV1([officialRow()], { returned: 5 })]) {
    await withResponse(payload, async () => {
      await assert.rejects(fetchEstimateRows(['000001'], { now }), fixedError('WORKER_ACCOUNTING_INVALID'));
    });
  }
});

const invalidHoldingCases = [
    [holdingsV1(holdingRows(), { schema_version: 99 }), 'WORKER_SCHEMA_UNSUPPORTED'],
    [holdingsV1([holdingRows()[0], holdingRows()[0]]), 'HOLDINGS_DUPLICATE_IDENTITY'],
    [holdingsV1(holdingRows().map(row => ({ ...row, ratio: 20 }))), 'HOLDINGS_TOTAL_RATIO_EXCEEDED'],
    [holdingsV1([...holdingRows(), { code: '<script>', name: '错误', ratio: 1 }]), 'HOLDINGS_ROW_INVALID'],
    [holdingsV1(holdingRows(11)), 'HOLDINGS_TOO_MANY_ROWS'],
    [holdingsV1(holdingRows(), { report_date: '2026-02-30' }), 'HOLDINGS_REPORT_DATE_INVALID'],
    [holdingsV1(holdingRows(), { report_date: '2026-12-31' }), 'HOLDINGS_REPORT_DATE_FUTURE'],
    [holdingsV1(holdingRows(), { report_date: '2025-12-31' }), 'HOLDINGS_REPORT_EXPIRED'],
];
for (const [payload, code] of invalidHoldingCases) {
  test(`v16: holdings client rejects ${code} without filtering or truncating`, async () => {
    await withResponse(payload, async () => {
      await assert.rejects(fetchFundHoldings('000001', { now }), fixedError(code));
    });
  });
}

test('v16: absent schema v1 remains usable and official null aliases remain intentional', async () => {
  const { parseWorkerEnvelope, normalizeWorkerEstimateRow } = await contract();
  const result = parseWorkerEnvelope(estimatesV1(), { endpoint: 'estimates', requestedCodes: ['000001'], now });
  assert.equal(result.wireVersion, 1);
  const row = normalizeWorkerEstimateRow(result.items[0], { wireVersion: 1, now });
  assert.equal(row.status, 'ok');
  assert.equal(row.source_status, 'latest_official');
  assert.equal(row.value_nav, 1.02);
  assert.equal(row.estimate_nav, null);
  assert.equal(row.est_nav, 1.02);
  assert.equal(row.value_date, '2026-09-29');
});

test('v16: explicit null canonical values are never filled from legacy aliases', async () => {
  const { normalizeWorkerEstimateRow } = await contract();
  assert.throws(() => normalizeWorkerEstimateRow(intradayRow({ value_nav: null, est_nav: 9 }), { wireVersion: 1, now }),
    fixedError('WORKER_ALIAS_CONFLICT'));
  const row = normalizeWorkerEstimateRow(officialRow({ base_nav: null, last_nav: null, base_nav_date: null, value_change: null }),
    { wireVersion: 1, now });
  assert.equal(row.base_nav, null);
  assert.equal(row.value_change, null);
  assert.equal(row.est_change, null);
});

test('v16: canonical intraday null value_change and intentionally coarse model time are compatible', async () => {
  const { normalizeWorkerEstimateRow } = await contract();
  const direct = normalizeWorkerEstimateRow(intradayRow(), { wireVersion: 2, now });
  assert.equal(direct.value_change, null);
  assert.equal(direct.estimate_change, 1);
  assert.equal(direct.est_change, 1);
  const model = normalizeWorkerEstimateRow(holdingsModelRow(), { wireVersion: 1, now });
  assert.equal(model.source_time, '2026-09-30T13:59:00+08:00');
  assert.equal(model.est_time, '2026-09-30T13:59:00+08:00');
});

test('v16: canonical conflicting values, kinds and dates are rejected', async () => {
  const { normalizeWorkerEstimateRow } = await contract();
  for (const row of [
    intradayRow({ est_nav: 9 }), intradayRow({ est_change: 10 }),
    officialRow({ est_kind: 'estimate' }), intradayRow({ base_nav: 1, last_nav: 2 }),
    intradayRow({ est_time: '2026-09-29T13:59:00+08:00' }),
  ]) assert.throws(() => normalizeWorkerEstimateRow(row, { wireVersion: 2, now }), fixedError('WORKER_ALIAS_CONFLICT'));
});

test('v16: only numeric schema 2 is accepted with complete versioned metadata', async () => {
  const { parseWorkerEnvelope } = await contract();
  const input = estimatesV2();
  const result = parseWorkerEnvelope(input, { endpoint: 'estimates', requestedCodes: ['000002'], now });
  assert.equal(result.wireVersion, 2);
  assert.equal(result.serviceVersion, 'fixture-worker-2.0.0');
  assert.equal(result.generatedAt, input.generated_at);
  for (const schema_version of ['2', null, 'estimate-wire-v8.0', 0, 3]) {
    assert.throws(() => parseWorkerEnvelope({ ...input, schema_version }, { endpoint: 'estimates', requestedCodes: ['000002'], now }),
      fixedError('WORKER_SCHEMA_UNSUPPORTED'));
  }
});

test('v16: versioned metadata has a zoned timestamp and endpoint capability', async () => {
  const { parseWorkerEnvelope } = await contract();
  for (const overrides of [
    { service_version: '' }, { generated_at: '2026-09-30 13:59:00' }, { generated_at: '2026-02-30T13:59:00+08:00' },
    { generated_at: '2026-10-01T13:59:00+08:00' }, { capabilities: ['holdings_v2'] }, { capabilities: 'estimates_v2' },
  ]) assert.throws(() => parseWorkerEnvelope(estimatesV2([intradayRow()], overrides), {
    endpoint: 'estimates', requestedCodes: ['000002'], now,
  }), fixedError('WORKER_METADATA_INVALID'));
});

test('v16: partial/degraded requires per-item state and reason, not an optimistic batch label', async () => {
  const { parseWorkerEnvelope } = await contract();
  for (const row of [intradayRow({ status: undefined }), intradayRow({ diagnostics: {}, fallback_reason: null })]) {
    assert.throws(() => parseWorkerEnvelope(estimatesV2([row], { status: 'partial' }), {
      endpoint: 'estimates', requestedCodes: ['000002'], now,
    }), fixedError('WORKER_PARTIAL_SEMANTICS_INVALID'));
  }
  const valid = parseWorkerEnvelope(estimatesV2([officialRow()], { status: 'degraded' }), {
    endpoint: 'estimates', requestedCodes: ['000001'], now,
  });
  assert.equal(valid.items.length, 1);
});

test('v16: complete v2 accounting explicitly identifies unavailable requested codes', async () => {
  const { parseWorkerEnvelope } = await contract();
  const input = estimatesV2([intradayRow({ fallback_reason: 'partial_batch' })], {
    status: 'partial', requested: 2, returned: 1, unavailable: 1,
    unavailable_codes: ['000004'], unavailable_items: [unavailableRow()],
  });
  const result = parseWorkerEnvelope(input, { endpoint: 'estimates', requestedCodes: ['000002', '000004'], now });
  assert.equal(result.items.length, 2);
  for (const overrides of [
    { unavailable_codes: [] }, { unavailable: 0 }, { unavailable_items: [] },
    { unavailable_codes: ['000002'], unavailable_items: [unavailableRow({ code: '000002' })] },
  ]) assert.throws(() => parseWorkerEnvelope({ ...input, ...overrides }, {
    endpoint: 'estimates', requestedCodes: ['000002', '000004'], now,
  }), fixedError('WORKER_ACCOUNTING_INVALID'));
});

test('v16: stale/degraded item quality is retained while unknown quality fails closed', async () => {
  const { normalizeWorkerEstimateRow } = await contract();
  for (const status of ['fresh', 'delayed', 'modeled', 'degraded', 'stale']) {
    const row = normalizeWorkerEstimateRow(intradayRow({ status }), { wireVersion: 1, now });
    assert.equal(row.status, 'ok');
    assert.equal(row.source_status, status);
  }
  assert.throws(() => normalizeWorkerEstimateRow(intradayRow({ status: 'invented' }), { wireVersion: 1, now }),
    fixedError('WORKER_STATUS_INVALID'));
});

test('v16: missing source, impossible dates and reversed comparison dates are not trusted', async () => {
  const { normalizeWorkerEstimateRow } = await contract();
  for (const row of [
    intradayRow({ source: '' }), intradayRow({ base_nav_date: '2026-02-30' }),
    intradayRow({ base_nav_date: '2026-10-01' }), intradayRow({ value_date: '2026-09-28' }),
    intradayRow({ source_time: '2026-10-01T13:59:00+08:00', estimate_time: '2026-10-01T13:59:00+08:00', est_time: '2026-10-01T13:59:00+08:00' }),
  ]) assert.throws(() => normalizeWorkerEstimateRow(row, { wireVersion: 2, now }), fixedError('WORKER_ROW_INVALID'));
});

test('v16: a legal zero change and unavailable nulls remain distinct', async () => {
  const { normalizeWorkerEstimateRow } = await contract();
  const zero = normalizeWorkerEstimateRow(intradayRow({ value_nav: 1, estimate_nav: 1, estimate_change: 0, est_nav: 1, est_change: 0 }),
    { wireVersion: 2, now });
  assert.equal(zero.est_change, 0);
  const missing = normalizeWorkerEstimateRow(unavailableRow(), { wireVersion: 2, now });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.est_nav, null);
  assert.equal(missing.est_change, null);
});

test('v16: a model requires trustworthy coverage, quote count and disclosure evidence', async () => {
  const { normalizeWorkerEstimateRow } = await contract();
  for (const overrides of [
    { coverage: 101, model_coverage: 101 }, { coverage: 49, model_coverage: 49 },
    { quote_count: 4, model_quote_count: 4 }, { report_date: '2026-02-30', model_report_date: '2026-02-30' },
    { report_date: '2025-12-31', model_report_date: '2025-12-31' },
  ]) assert.throws(() => normalizeWorkerEstimateRow(holdingsModelRow(overrides), { wireVersion: 2, now }), fixedError('WORKER_MODEL_EVIDENCE_INVALID'));
});

test('v16: QDII model requires explicit target, version, samples and bounded uncertainty', async () => {
  const { normalizeWorkerEstimateRow } = await contract();
  assert.equal(normalizeWorkerEstimateRow(qdiiRow(), { wireVersion: 2, now }).kind, 'qdii_next_nav_estimate');
  for (const overrides of [
    { target_nav_date: null }, { target_nav_date: '2026-10-01' }, { estimate_model_version: '' },
    { sample_count: 0 }, { sample_count: 2.5 }, { uncertainty: null },
    { uncertainty: { mae: -1, error_p80: 1, direction_accuracy: 50 } },
    { uncertainty: { mae: 1, error_p80: 1, direction_accuracy: 101 } },
  ]) assert.throws(() => normalizeWorkerEstimateRow(qdiiRow(overrides), { wireVersion: 2, now }), fixedError('WORKER_MODEL_EVIDENCE_INVALID'));
});

test('v16: QDII future target is a prediction, not fabricated source time', async () => {
  const { normalizeWorkerEstimateRow } = await contract();
  const futureTarget = qdiiRow({ target_nav_date: '2026-10-01', value_date: '2026-10-01' });
  const row = normalizeWorkerEstimateRow(futureTarget, { wireVersion: 2, now });
  assert.equal(row.value_date, '2026-10-01');
  assert.equal(row.source_time, '2026-09-30T13:59:00+08:00');
});

test('v16: whole-set validator rejects identities/weights/dates, never filters or truncates', async () => {
  const { validateHoldingSet } = await contract();
  const cases = [
    [[...holdingRows(), holdingRows()[0]], '2026-06-30', 'HOLDINGS_DUPLICATE_IDENTITY'],
    [holdingRows().map(row => ({ ...row, ratio: 20 })), '2026-06-30', 'HOLDINGS_TOTAL_RATIO_EXCEEDED'],
    [[...holdingRows(), { code: '', name: '不完整', ratio: 1 }], '2026-06-30', 'HOLDINGS_ROW_INVALID'],
    [holdingRows(11), '2026-06-30', 'HOLDINGS_TOO_MANY_ROWS'],
    [holdingRows(), '2026-02-30', 'HOLDINGS_REPORT_DATE_INVALID'],
    [holdingRows(), '2026-12-31', 'HOLDINGS_REPORT_DATE_FUTURE'],
    [holdingRows(), '2025-12-31', 'HOLDINGS_REPORT_EXPIRED'],
  ];
  for (const [items, reportDate, code] of cases) {
    const result = validateHoldingSet(items, { reportDate, now, wireVersion: 2 });
    assert.equal(result.valid, false);
    assert.deepEqual(result.items, []);
    assert.ok(result.reasonCodes.includes(code));
  }
});

test('v16: legacy holdings retain unidentified market while v2 requires explicit exchange', async () => {
  const { parseWorkerEnvelope, validateHoldingSet } = await contract();
  const raw = [{ code: '000660', name: '合成证券', ratio: 0 }];
  const legacy = validateHoldingSet(raw, { reportDate: '2026-06-30', now, wireVersion: 1 });
  assert.equal(legacy.valid, true);
  assert.equal(legacy.items[0].ratio, 0);
  assert.equal(legacy.items[0].market, undefined);
  const v2 = validateHoldingSet(raw, { reportDate: '2026-06-30', now, wireVersion: 2 });
  assert.equal(v2.valid, false);
  assert.ok(v2.reasonCodes.includes('HOLDINGS_ROW_INVALID'));
  const envelope = parseWorkerEnvelope(holdingsV2(), { endpoint: 'holdings', requestedCodes: ['000001'], now });
  assert.equal(envelope.items.length, 6);
});

test('v16: null/boolean/malformed ratios cannot become zero or a plausible weight', async () => {
  const { validateHoldingSet } = await contract();
  for (const ratio of [null, true, false, '', '1%%', '0x10', '1,2', Infinity, -1]) {
    const result = validateHoldingSet([{ code: '600001', market: 'cn', name: '合成证券', ratio }], {
      reportDate: '2026-06-30', now, wireVersion: 2,
    });
    assert.equal(result.valid, false);
    assert.ok(result.reasonCodes.includes('HOLDINGS_ROW_INVALID'));
  }
});

test('v16: error output contains only a stable reason, not payload source or user-controlled text', async () => {
  const { parseWorkerEnvelope } = await contract();
  const hostile = 'synthetic-secret-must-not-be-logged';
  assert.throws(() => parseWorkerEnvelope(estimatesV2([intradayRow()], { status: hostile }), {
    endpoint: 'estimates', requestedCodes: ['000002'], now,
  }), (error) => error.name === 'WorkerContractError' && !error.message.includes(hostile) && !JSON.stringify(error).includes(hostile));
});
