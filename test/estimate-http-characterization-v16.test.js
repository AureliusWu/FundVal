import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEstimateRows, normalizeEstimateRow } from '../js/eastmoney-estimate.js';
import { parseWorkerEnvelope, normalizeWorkerEstimateRow, WorkerContractError } from '../js/runtime/worker-contract.js';

// Synthetic JSON only: these fixtures do not use network, storage, credentials,
// real holdings, an automatically generated snapshot, or a copied algorithm.
const NOW = Date.parse('2026-09-30T06:00:00Z');
const FETCHED = '2026-09-30T05:59:30Z';
const API = 'https://fundval-characterization.invalid/estimates';
const ROW_KEYS = [
  'code', 'name', 'kind', 'status', 'source', 'type', 'base_nav', 'base_nav_date',
  'value_nav', 'value_change', 'value_date', 'source_time', 'source_time_precision',
  'estimate_nav', 'estimate_change', 'estimate_time', 'last_nav', 'nav_date',
  'est_nav', 'est_change', 'est_time', 'est_kind', 'est_realtime', 'est_label',
  'est_note', 'message', 'is_fallback', 'fallback_reason', 'coverage', 'quote_count',
  'report_date', 'confidence', 'target_nav_date', 'estimate_model_version',
  'sample_count', 'uncertainty', 'meta', 'diagnostics', 'source_status',
  'transport_status', 'adapterReasonCodes', 'source_quote',
];
const QUOTE_KEYS = [
  'fundCode', 'fundName', 'market', 'assetKind', 'valueKind', 'value', 'changePct',
  'baseNav', 'baseNavDate', 'targetDate', 'sourceId', 'sourceTier', 'originalSource',
  'originalSourceTier', 'cacheState', 'cachedAt', 'expiresAt', 'observedAt',
  'fetchedAt', 'officialNavDate', 'status', 'ageMs', 'coverage', 'confidence',
  'modelVersion', 'reasonCodes',
];

function incoming(overrides = {}) {
  return {
    code: '000002', name: '合成盘中A', kind: 'intraday_estimate', status: 'fresh',
    source: 'sinan-estimate-proxy', type: '混合型', base_nav: '1.0', base_nav_date: '2026-09-29',
    value_nav: '1.01', value_change: null, value_date: '2026-09-30',
    source_time: '2026-09-30T13:59:00+08:00', source_time_precision: 'datetime',
    estimate_nav: '1.01', estimate_change: '1%', estimate_time: '2026-09-30T13:59:00+08:00',
    last_nav: '1.0', nav_date: null, est_nav: '1.01', est_change: '1%',
    est_time: '2026-09-30T13:59:00+08:00', est_kind: 'estimate', est_realtime: true,
    est_label: '合成估值', est_note: '合成说明', message: '', is_fallback: false,
    fallback_reason: null, coverage: null, quote_count: null, report_date: null,
    confidence: null, target_nav_date: null, estimate_model_version: null,
    sample_count: null, uncertainty: null, meta: { synthetic: true, optional: null },
    diagnostics: { primary_reason: null, model_reason: null }, ...overrides,
  };
}

function expectedQuote(overrides = {}) {
  return {
    fundCode: '000002', fundName: '合成盘中A', market: 'cn', assetKind: 'fund',
    valueKind: 'intraday_estimate', value: 1.01, changePct: 1, baseNav: 1,
    baseNavDate: '2026-09-29', targetDate: '2026-09-30', sourceId: 'sinan-estimate-proxy',
    sourceTier: 'primary', originalSource: null, originalSourceTier: null,
    cacheState: null, cachedAt: null, expiresAt: null,
    observedAt: '2026-09-30T13:59:00+08:00', fetchedAt: '2026-09-30T05:59:30.000Z',
    officialNavDate: '2026-09-29', status: 'realtime', ageMs: 60000,
    coverage: null, confidence: null, modelVersion: null,
    reasonCodes: ['UPSTREAM_STATUS_UNCLASSIFIED'], ...overrides,
  };
}

function expectedRow(overrides = {}, quoteOverrides = {}) {
  return {
    code: '000002', name: '合成盘中A', kind: 'intraday_estimate', status: 'ok',
    source: 'sinan-estimate-proxy', type: '混合型', base_nav: 1, base_nav_date: '2026-09-29',
    value_nav: 1.01, value_change: null, value_date: '2026-09-30',
    source_time: '2026-09-30T13:59:00+08:00', source_time_precision: 'minute',
    estimate_nav: 1.01, estimate_change: 1, estimate_time: '2026-09-30T13:59:00+08:00',
    last_nav: 1, nav_date: '2026-09-29', est_nav: 1.01, est_change: 1,
    est_time: '2026-09-30T13:59:00+08:00', est_kind: 'estimate', est_realtime: true,
    est_label: '合成估值', est_note: '合成说明', message: '', is_fallback: false,
    fallback_reason: '', coverage: NaN, quote_count: NaN, report_date: '',
    confidence: null, target_nav_date: null, estimate_model_version: null,
    sample_count: null, uncertainty: null, meta: { synthetic: true, optional: null },
    diagnostics: { primary_reason: null, model_reason: null }, source_status: 'fresh',
    transport_status: 'ok', adapterReasonCodes: [], source_quote: expectedQuote(quoteOverrides),
    ...overrides,
  };
}

function payload(row = incoming(), wireVersion = 1, overrides = {}) {
  return {
    ...(wireVersion === 2 ? {
      schema_version: 2, service_version: 'synthetic-worker-2', generated_at: FETCHED,
      capabilities: ['estimates_v2'],
    } : {}),
    status: 'ok', source: 'synthetic-worker', fetched_at: FETCHED,
    requested: 1, returned: 1, unavailable: 0, unavailable_codes: [], unavailable_items: [],
    items: [row], ...overrides,
  };
}

function installJsonFetch(t, body, calls = []) {
  const json = JSON.stringify(body);
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    calls.push({ input, options });
    return new Response(json, { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function assertComplete(actual, expected, keys = ROW_KEYS) {
  assert.deepEqual(actual, expected, 'all own values, including NaN versus null');
  assert.deepEqual(Object.keys(actual), keys, 'row own-key insertion order');
  assert.deepEqual(Object.keys(actual.source_quote), QUOTE_KEYS, 'quote own-key insertion order');
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'serialized byte order');
  assert.equal(Object.isFrozen(actual), false, 'presentation row remains mutable');
  assert.equal(Object.isFrozen(actual.source_quote), true);
  assert.equal(Object.isFrozen(actual.source_quote.reasonCodes), true);
}

for (const wireVersion of [1, 2]) {
  test('estimate HTTP: v' + wireVersion + ' complete row, quote, order and second-pass source status', async t => {
    const body = payload(incoming(), wireVersion);
    const envelope = parseWorkerEnvelope(body, { endpoint: 'estimates', requestedCodes: ['000002'], now: NOW });
    assert.deepEqual(envelope, {
      wireVersion, status: 'ok', source: 'synthetic-worker', fetchedAt: FETCHED,
      generatedAt: wireVersion === 2 ? FETCHED : '', serviceVersion: wireVersion === 2 ? 'synthetic-worker-2' : '',
      capabilities: wireVersion === 2 ? ['estimates_v2'] : [], reportDate: '',
      items: [{
        ...expectedRow({ status: 'fresh', source_time_precision: 'datetime', coverage: null,
          quote_count: null, report_date: null, fallback_reason: null }),
        source_quote: undefined,
      }].map(({ source_quote, ...row }) => row),
    });
    const before = structuredClone(envelope.items[0]);
    Object.freeze(envelope.items[0]);
    const second = normalizeWorkerEstimateRow(envelope.items[0], { wireVersion, now: NOW });
    assert.equal(second.status, 'ok');
    assert.equal(second.source_status, 'fresh');
    assert.equal(second.transport_status, 'ok');
    assert.equal(second.coverage, null);
    const viaPublic = normalizeEstimateRow(envelope.items[0], { wireVersion, fetchedAt: FETCHED, now: NOW });
    assertComplete(viaPublic, expectedRow());
    assert.deepEqual(envelope.items[0], before, 'second normalization does not mutate the parsed row');
    assert.notEqual(viaPublic, envelope.items[0]);
    assert.notEqual(viaPublic.diagnostics, envelope.items[0].diagnostics);
    assert.equal(viaPublic.meta, envelope.items[0].meta);
    assert.equal(viaPublic.adapterReasonCodes, envelope.items[0].adapterReasonCodes);
    installJsonFetch(t, body);
    const actual = await fetchEstimateRows(['000002'], { api: API, now: NOW });
    assert.deepEqual([...actual.keys()], ['000002']);
    assertComplete(actual.get('000002'), expectedRow());
  });

  test('estimate HTTP: v' + wireVersion + ' legal zero and optional numeric null remain different', async t => {
    installJsonFetch(t, payload(incoming({ value_nav: '1', estimate_nav: '1', est_nav: '1',
      estimate_change: '0%', est_change: '0%', coverage: 0, quote_count: 0 }), wireVersion));
    const row = (await fetchEstimateRows(['000002'], { api: API, now: NOW })).get('000002');
    assertComplete(row, expectedRow({ value_nav: 1, estimate_nav: 1, est_nav: 1,
      estimate_change: 0, est_change: 0, coverage: 0, quote_count: 0 }, { value: 1, changePct: 0, coverage: 0 }));
  });

  test('estimate HTTP: v' + wireVersion + ' official fallback separates value date from previous NAV date', async t => {
    const changes = {
      code: '000001', name: '合成正式A', kind: 'official_nav', status: 'latest_official',
      source: 'eastmoney-official-nav', base_nav_date: '2026-09-28', value_nav: '1.02', value_change: '2%',
      value_date: '2026-09-29', source_time: '2026-09-29', source_time_precision: 'date',
      estimate_nav: null, estimate_change: null, estimate_time: null, nav_date: '2026-09-29',
      est_nav: null, est_change: null, est_time: '2026-09-29', est_kind: 'official_nav', est_realtime: false,
      is_fallback: true, fallback_reason: 'upstream_empty',
    };
    installJsonFetch(t, payload(incoming(changes), wireVersion, { status: 'degraded' }));
    const row = (await fetchEstimateRows(['000001'], { api: API, now: NOW })).get('000001');
    assertComplete(row, expectedRow({
      ...changes, status: 'ok', base_nav: 1, last_nav: 1, value_nav: 1.02, value_change: 2,
      base_nav_date: '2026-09-28', nav_date: '2026-09-28', est_nav: 1.02, est_change: 2,
      source_status: 'latest_official', message: 'upstream_empty',
    }, {
      fundCode: '000001', fundName: '合成正式A', valueKind: 'official_nav', value: 1.02, changePct: 2,
      baseNavDate: '2026-09-28', targetDate: '2026-09-29', sourceId: 'eastmoney-official-nav',
      sourceTier: 'secondary', observedAt: '2026-09-29', officialNavDate: '2026-09-29', status: 'official', ageMs: null,
      reasonCodes: ['FALLBACK_REASON_UPSTREAM_EMPTY', 'UPSTREAM_STATUS_LATEST_OFFICIAL', 'UPSTREAM_FALLBACK',
        'SOURCE_TIME_DATE_ONLY', 'OFFICIAL_NAV_FALLBACK'],
    }));
  });

  test('estimate HTTP: v' + wireVersion + ' unavailable rows retain transport quality, NaN presentation and null quotes', async t => {
    const changes = {
      code: '000004', name: '合成缺失A', kind: 'unavailable', status: 'failed', source: 'unavailable',
      base_nav: null, base_nav_date: null, value_nav: null, value_change: null, value_date: null,
      source_time: null, source_time_precision: 'date', estimate_nav: null, estimate_change: null,
      estimate_time: null, last_nav: null, nav_date: null, est_nav: null, est_change: null, est_time: null,
      est_realtime: false, is_fallback: true, fallback_reason: 'upstream_empty',
    };
    installJsonFetch(t, payload(incoming(changes), wireVersion, { status: 'unavailable' }));
    const row = (await fetchEstimateRows(['000004'], { api: API, now: NOW })).get('000004');
    assertComplete(row, expectedRow({
      ...changes, status: 'unavailable', base_nav_date: '', value_date: '', source_time: '',
      last_nav: NaN, nav_date: '', est_nav: NaN, est_change: NaN, est_time: '',
      source_status: 'failed', transport_status: 'unavailable', message: 'upstream_empty',
    }, {
      fundCode: '000004', fundName: '合成缺失A', value: null, changePct: null, baseNav: null,
      baseNavDate: null, targetDate: null, sourceId: 'unavailable', sourceTier: 'secondary',
      observedAt: null, officialNavDate: null, status: 'unavailable', ageMs: null,
      reasonCodes: ['FALLBACK_REASON_UPSTREAM_EMPTY', 'UPSTREAM_STATUS_FAILED', 'UPSTREAM_FALLBACK', 'MISSING_QUOTE_VALUE'],
    }));
  });
}

test('estimate HTTP: official singleton with absent comparison stays official, never an invented zero move', async t => {
  const changes = {
    kind: 'official_nav', status: 'official', source: 'eastmoney-official-nav',
    base_nav: null, base_nav_date: null, last_nav: null, value_nav: 1.01, value_change: null,
    value_date: '2026-09-30', source_time: '2026-09-30', source_time_precision: 'date',
    estimate_nav: null, estimate_change: null, estimate_time: null, est_nav: null, est_change: null,
    est_time: '2026-09-30', est_kind: 'official_nav', est_realtime: false,
  };
  installJsonFetch(t, payload(incoming(changes), 2));
  const row = (await fetchEstimateRows(['000002'], { api: API, now: NOW })).get('000002');
  assertComplete(row, expectedRow({ ...changes, status: 'ok', base_nav_date: '', nav_date: '',
    last_nav: NaN, est_nav: 1.01, est_change: NaN, source_status: 'official' }, {
    valueKind: 'official_nav', changePct: null, baseNav: null, baseNavDate: null,
    sourceId: 'eastmoney-official-nav', sourceTier: 'secondary', observedAt: '2026-09-30',
    officialNavDate: '2026-09-30', status: 'official', ageMs: null,
    reasonCodes: ['UPSTREAM_STATUS_OFFICIAL', 'SOURCE_TIME_DATE_ONLY', 'OFFICIAL_NAV_FALLBACK'],
  }));
});

test('estimate HTTP: failed v1 official rows expose the current unavailable/official/estimate kind seam', async t => {
  const body = payload(incoming({ kind: 'official_nav', status: 'failed', source: 'eastmoney-official-nav',
    value_change: '1%', est_kind: 'official_nav' }), 1, { status: 'unavailable' });
  const envelope = parseWorkerEnvelope(body, { endpoint: 'estimates', requestedCodes: ['000002'], now: NOW });
  assert.equal(envelope.items[0].kind, 'unavailable');
  assert.equal(envelope.items[0].est_kind, 'official_nav');
  assert.equal(envelope.items[0].status, 'failed');
  const second = normalizeWorkerEstimateRow(envelope.items[0], { wireVersion: 1, now: NOW });
  assert.equal(second.kind, 'unavailable');
  assert.equal(second.est_kind, 'estimate');
  installJsonFetch(t, body);
  const row = (await fetchEstimateRows(['000002'], { api: API, now: NOW })).get('000002');
  assertComplete(row, expectedRow({
    kind: 'unavailable', status: 'unavailable', source: 'eastmoney-official-nav',
    base_nav: null, base_nav_date: '', value_nav: null, value_change: null, value_date: '',
    source_time: '', source_time_precision: 'date', estimate_nav: null, estimate_change: null,
    last_nav: NaN, nav_date: '', est_nav: NaN, est_change: NaN, est_time: '', est_kind: 'estimate',
    est_realtime: false, source_status: 'failed', transport_status: 'unavailable',
  }, {
    value: null, changePct: null, baseNav: null, baseNavDate: null, targetDate: null,
    sourceId: 'eastmoney-official-nav', sourceTier: 'secondary', observedAt: null,
    officialNavDate: null, status: 'unavailable', ageMs: null,
    reasonCodes: ['UPSTREAM_STATUS_FAILED', 'MISSING_QUOTE_VALUE'],
  }));
});

test('estimate HTTP: Date subclass clock is read again by the second validation and retains legacy safe rescue', async t => {
  let clockReads = 0;
  class ChangingDate extends Date {
    getTime() {
      clockReads++;
      return clockReads === 1 ? Date.parse('2026-09-30T02:05:00Z') : Date.parse('2026-09-30T01:00:00Z');
    }
  }
  const fetched = '2026-09-30T02:04:30Z';
  const body = payload(incoming({ source_time: '2026-09-30T10:04:00+08:00',
    estimate_time: '2026-09-30T10:04:00+08:00', est_time: '2026-09-30T10:04:00+08:00' }), 2,
  { fetched_at: fetched, generated_at: fetched });
  installJsonFetch(t, body);
  const row = (await fetchEstimateRows(['000002'], { api: API, now: new ChangingDate() })).get('000002');
  assert.equal(clockReads, 3, 'envelope clock, second wire-validation clock, then quote-normalization clock');
  const expected = {
    code: '000002', name: '合成盘中A', source: 'unavailable', kind: 'unavailable', status: 'error',
    source_status: 'fresh', base_nav: null, value_nav: null, est_nav: NaN, est_change: NaN,
    source_time: '', value_date: '', coverage: NaN, quote_count: NaN,
    diagnostics: { primary_reason: null, model_reason: null }, message: '估值契约不完整', fallback_reason: 'invalid_response',
    type: '混合型', last_nav: NaN, nav_date: '', est_time: '', source_time_precision: 'date',
    est_label: '合成估值', est_kind: 'estimate', est_realtime: false, est_note: '合成说明',
    is_fallback: false, base_nav_date: '', report_date: '', source_quote: expectedQuote({
      value: null, changePct: null, baseNav: null, baseNavDate: null, targetDate: null,
      sourceId: 'unavailable', observedAt: null, fetchedAt: '2026-09-30T02:04:30.000Z',
      officialNavDate: null, status: 'unavailable', ageMs: null,
      reasonCodes: ['FALLBACK_REASON_INVALID_RESPONSE', 'UPSTREAM_STATUS_UNCLASSIFIED', 'MISSING_QUOTE_VALUE'],
    }),
  };
  assertComplete(row, expected, ['code', 'name', 'source', 'kind', 'status', 'source_status',
    'base_nav', 'value_nav', 'est_nav', 'est_change', 'source_time', 'value_date', 'coverage',
    'quote_count', 'diagnostics', 'message', 'fallback_reason', 'type', 'last_nav', 'nav_date',
    'est_time', 'source_time_precision', 'est_label', 'est_kind', 'est_realtime', 'est_note',
    'is_fallback', 'base_nav_date', 'report_date', 'source_quote']);
});

test('estimate HTTP: model evidence and unknown nested metadata survive the second projection', async t => {
  const changes = {
    kind: 'holdings_model', status: 'modeled', source: 'quarterly-holdings-model',
    est_kind: 'holdings_model', est_realtime: false, est_time: '2026-09-30',
    is_fallback: true, fallback_reason: 'upstream_empty', coverage: '60%', quote_count: '6',
    report_date: '2026-06-30', confidence: 'high',
    diagnostics: { primary_reason: 'timeout', evidence: { synthetic: true } },
  };
  const body = payload(incoming(changes), 2);
  const envelope = parseWorkerEnvelope(body, { endpoint: 'estimates', requestedCodes: ['000002'], now: NOW });
  const direct = normalizeEstimateRow(envelope.items[0], { wireVersion: 2, fetchedAt: FETCHED, now: NOW });
  assert.equal(direct.diagnostics.evidence, envelope.items[0].diagnostics.evidence);
  installJsonFetch(t, body);
  const row = (await fetchEstimateRows(['000002'], { api: API, now: NOW })).get('000002');
  assertComplete(row, expectedRow({ ...changes, status: 'ok', est_time: '2026-09-30T13:59:00+08:00',
    coverage: 60, quote_count: 6, source_status: 'modeled', message: 'upstream_empty' }, {
    valueKind: 'holding_lookthrough_estimate', sourceId: 'quarterly-holdings-model', sourceTier: 'secondary',
    status: 'model', coverage: 60, confidence: 0.85,
    reasonCodes: ['FALLBACK_REASON_UPSTREAM_EMPTY', 'PRIMARY_REASON_TIMEOUT', 'UPSTREAM_STATUS_UNCLASSIFIED',
      'UPSTREAM_FALLBACK', 'HOLDINGS_LOOKTHROUGH'],
  }));
});

test('estimate HTTP: QDII future target stays distinct from observation time and is visibly stale', async t => {
  const changes = {
    name: '合成海外(QDII)A', kind: 'qdii_next_nav_estimate', status: 'modeled', source: 'market-model',
    value_date: '2026-10-01', est_kind: 'overseas_model', est_realtime: false, coverage: 78.5,
    target_nav_date: '2026-10-01', estimate_model_version: 'synthetic-model-1', sample_count: 28,
    uncertainty: { mae: 0.7, error_p80: 1.3, direction_accuracy: 64 },
  };
  installJsonFetch(t, payload(incoming(changes), 2));
  const row = (await fetchEstimateRows(['000002'], { api: API, now: NOW })).get('000002');
  assertComplete(row, expectedRow({ ...changes, status: 'ok', source_status: 'modeled' }, {
    fundName: '合成海外(QDII)A', market: 'qdii', assetKind: 'qdii_fund', valueKind: 'model_estimate',
    targetDate: '2026-10-01', sourceId: 'market-model', sourceTier: 'model', status: 'stale',
    coverage: 78.5, modelVersion: 'synthetic-model-1',
    reasonCodes: ['UPSTREAM_STATUS_UNCLASSIFIED', 'MODEL_ESTIMATE', 'SOURCE_DATE_IN_FUTURE'],
  }));
});

test('estimate HTTP: every valid upstream status retains literal source quality after successful transport', async t => {
  const cases = [
    ['ok', true, 'realtime', []], ['success', true, 'realtime', []],
    ['fresh', true, 'realtime', ['UPSTREAM_STATUS_UNCLASSIFIED']],
    ['realtime', true, 'realtime', ['UPSTREAM_STATUS_UNCLASSIFIED']],
    ['delayed', false, 'delayed', ['UPSTREAM_STATUS_UNCLASSIFIED', 'SOURCE_NOT_REALTIME']],
    ['modeled', false, 'delayed', ['UPSTREAM_STATUS_UNCLASSIFIED', 'SOURCE_NOT_REALTIME']],
    ['degraded', false, 'delayed', ['UPSTREAM_STATUS_DEGRADED', 'SOURCE_NOT_REALTIME']],
    ['latest_official', false, 'delayed', ['UPSTREAM_STATUS_LATEST_OFFICIAL', 'SOURCE_NOT_REALTIME']],
    ['official', false, 'delayed', ['UPSTREAM_STATUS_OFFICIAL', 'SOURCE_NOT_REALTIME']],
    ['stale', false, 'stale', ['UPSTREAM_STATUS_STALE', 'SOURCE_MARKED_STALE']],
  ];
  for (const [status, realtime, quoteStatus, reasonCodes] of cases) {
    installJsonFetch(t, payload(incoming({ status }), 2));
    const row = (await fetchEstimateRows(['000002'], { api: API, now: NOW })).get('000002');
    assertComplete(row, expectedRow({ source_status: status, est_realtime: realtime }, { status: quoteStatus, reasonCodes }));
  }
});

test('estimate HTTP: date-only and expired timestamps are not promoted by a fresh label', async t => {
  const cases = [
    { input: { source_time: '2026-09-30', source_time_precision: 'date', estimate_time: '2026-09-30', est_time: '2026-09-30' },
      expected: { source_time: '2026-09-30', source_time_precision: 'date', estimate_time: '2026-09-30', est_time: '2026-09-30' },
      quote: { observedAt: '2026-09-30', status: 'stale', ageMs: null,
        reasonCodes: ['UPSTREAM_STATUS_UNCLASSIFIED', 'SOURCE_TIME_DATE_ONLY'] } },
    { input: { base_nav_date: '2026-09-28', value_date: '2026-09-29', source_time: '2026-09-29T13:59:00+08:00',
      estimate_time: '2026-09-29T13:59:00+08:00', est_time: '2026-09-29T13:59:00+08:00' },
      expected: { base_nav_date: '2026-09-28', nav_date: '2026-09-28', value_date: '2026-09-29',
        source_time: '2026-09-29T13:59:00+08:00', estimate_time: '2026-09-29T13:59:00+08:00', est_time: '2026-09-29T13:59:00+08:00' },
      quote: { baseNavDate: '2026-09-28', targetDate: '2026-09-29', officialNavDate: '2026-09-28',
        observedAt: '2026-09-29T13:59:00+08:00', status: 'stale', ageMs: 86460000,
        reasonCodes: ['UPSTREAM_STATUS_UNCLASSIFIED', 'SOURCE_TIME_EXPIRED'] } },
  ];
  for (const spec of cases) {
    installJsonFetch(t, payload(incoming(spec.input), 2));
    assertComplete((await fetchEstimateRows(['000002'], { api: API, now: NOW })).get('000002'), expectedRow(spec.expected, spec.quote));
  }
});

test('estimate HTTP: opaque metadata stays data while presentation text and diagnostic codes are sanitized', async t => {
  const changes = {
    name: '<synthetic-name>', type: '<synthetic-type>', est_label: 'unsafe\nlabel',
    est_note: null, message: '<synthetic-message>',
    meta: { synthetic: true, opaque: '<not-rendered-by-this-adapter>' },
    diagnostics: { primary_reason: '<synthetic-reason>', unrelated: 'retained as data' },
  };
  installJsonFetch(t, payload(incoming(changes), 2));
  const row = (await fetchEstimateRows(['000002'], { api: API, now: NOW })).get('000002');
  assertComplete(row, expectedRow({ ...changes, name: '000002', type: '', est_label: '',
    est_note: '东方财富盘中估算；上游仅提供行情日期，未提供精确分钟', message: '' }, {
    fundName: '000002', reasonCodes: ['PRIMARY_REASON_UNCLASSIFIED', 'UPSTREAM_STATUS_UNCLASSIFIED'],
  }));
});

test('estimate HTTP: partial v1 batches preserve explicit successful-adapter evidence and requested Map order', async t => {
  const official = incoming({ code: '000001', kind: 'official_nav', status: 'official',
    source: 'eastmoney-official-nav', value_change: '1%', est_kind: 'official_nav', est_realtime: false,
    estimate_nav: null, estimate_change: null, est_nav: null, est_change: null,
    fallback_reason: 'upstream_empty' });
  installJsonFetch(t, payload(incoming(), 1, { status: 'partial', requested: 3, returned: 2, unavailable: 1,
    unavailable_codes: ['000004'], unavailable_items: [incoming({ code: '000004', kind: 'unavailable', status: 'unavailable',
      base_nav: null, base_nav_date: null, value_nav: null, value_change: null, value_date: null, source_time: null,
      estimate_nav: null, estimate_change: null, last_nav: null, est_nav: null, est_change: null,
      fallback_reason: 'upstream_empty' })], items: [incoming(), official] }));
  const rows = await fetchEstimateRows(['000004', '000001', '000002'], { api: API, now: NOW });
  assert.deepEqual([...rows.keys()], ['000004', '000001', '000002']);
  assertComplete(rows.get('000002'), expectedRow({ adapterReasonCodes: ['LEGACY_SUCCESS_ROW'] }));
  assert.equal(rows.get('000004').status, 'unavailable');
  assert.equal(rows.get('000001').source_status, 'official');
});

test('estimate HTTP: v1 omitted rows stay null; dedupe and filtering never reorder requested identities', async t => {
  const calls = [];
  installJsonFetch(t, { status: 'ok', fetched_at: FETCHED, items: [incoming()] }, calls);
  const rows = await fetchEstimateRows(['000004', '000002', '000004', 'bad', 2, null, '000003'], { api: API, now: NOW });
  assert.deepEqual([...rows.keys()], ['000004', '000002', '000003']);
  assert.equal(rows.get('000004'), null);
  assert.equal(rows.get('000003'), null);
  assertComplete(rows.get('000002'), expectedRow());
  assert.equal(calls[0].input, API + '?codes=000004%2C000002%2C000003');
  assert.deepEqual(Object.keys(calls[0].options), ['cache', 'signal']);
  assert.equal(calls[0].options.cache, 'no-store');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test('estimate HTTP: metadata is validated before rows and row fetched_at retains its existing precedence', async t => {
  const body = payload(incoming({ fetched_at: '2026-09-30T05:58:00Z' }), 2);
  installJsonFetch(t, body);
  const expected = expectedRow({}, { fetchedAt: '2026-09-30T05:58:00.000Z' });
  expected.fetched_at = '2026-09-30T05:58:00Z';
  // Unknown JSON row fields precede fields appended by the wire/presentation layers.
  const ordered = { ...Object.fromEntries(ROW_KEYS.slice(0, 38).map(key => [key, expected[key]])),
    fetched_at: expected.fetched_at, source_status: expected.source_status, transport_status: expected.transport_status,
    adapterReasonCodes: expected.adapterReasonCodes, source_quote: expected.source_quote };
  assertComplete((await fetchEstimateRows(['000002'], { api: API, now: NOW })).get('000002'), ordered,
    [...ROW_KEYS.slice(0, 38), 'fetched_at', ...ROW_KEYS.slice(38)]);
  for (const overrides of [
    { schema_version: '2' }, { capabilities: ['holdings_v2'] }, { generated_at: '2026-10-01T00:00:00Z' },
    { fetched_at: '2026-02-30T05:59:30Z' },
  ]) {
    installJsonFetch(t, { ...body, ...overrides });
    await assert.rejects(fetchEstimateRows(['000002'], { api: API, now: NOW }), {
      name: 'WorkerContractError', code: Object.hasOwn(overrides, 'schema_version') ? 'WORKER_SCHEMA_UNSUPPORTED' : 'WORKER_METADATA_INVALID',
    });
  }
});

test('estimate HTTP: malformed wire data fails the complete envelope instead of invoking the legacy rescue', async t => {
  const cases = [
    [payload(incoming({ value_nav: null, estimate_nav: null, est_nav: null }), 2), 'WORKER_ROW_INVALID'],
    [payload(incoming({ est_nav: '9' }), 2), 'WORKER_ALIAS_CONFLICT'],
    [payload(incoming({ status: 'invented', source_status: 'fresh' }), 2), 'WORKER_STATUS_INVALID'],
    [payload(incoming({ base_nav_date: '2026-02-30' }), 2), 'WORKER_ROW_INVALID'],
    [payload(incoming(), 2, { items: [incoming(), incoming()], returned: 2 }), 'WORKER_DUPLICATE_CODE'],
    [payload(incoming(), 2, { items: [incoming({ code: '000003' })] }), 'WORKER_ACCOUNTING_INVALID'],
    [payload(incoming(), 2, { status: 'partial' }), 'WORKER_PARTIAL_SEMANTICS_INVALID'],
  ];
  for (const [body, code] of cases) {
    installJsonFetch(t, body);
    await assert.rejects(fetchEstimateRows(['000002'], { api: API, now: NOW }), {
      name: 'WorkerContractError', code, message: code,
    });
  }
});

test('estimate HTTP: empty input wins before cancellation and force uses the real request timestamp seam', async t => {
  const calls = [];
  installJsonFetch(t, payload(), calls);
  const cancelled = new AbortController();
  cancelled.abort('synthetic cancellation');
  assert.deepEqual([...await fetchEstimateRows(['bad'], { signal: cancelled.signal })], []);
  assert.equal(calls.length, 0);
  t.mock.method(Date, 'now', () => 1790748000000);
  await fetchEstimateRows(['000002'], { api: API, now: NOW, force: true });
  assert.equal(calls[0].input, API + '?codes=000002&_=1790748000000');
});

test('estimate HTTP: HTTP, JSON and fetch errors propagate without erasing identities or private messages', async t => {
  for (const status of [400, 502]) {
    let jsonReads = 0;
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status, json() { jsonReads++; } }));
    await assert.rejects(fetchEstimateRows(['000002'], { api: API, now: NOW }), {
      name: 'Error', message: '估值代理 HTTP ' + status,
    });
    assert.equal(jsonReads, 0);
  }
  for (const phase of ['fetch', 'json']) {
    const error = new TypeError('synthetic ' + phase + ' failure');
    t.mock.method(globalThis, 'fetch', async () => {
      if (phase === 'fetch') throw error;
      return { ok: true, async json() { throw error; } };
    });
    await assert.rejects(fetchEstimateRows(['000002'], { api: API, now: NOW }), actual => actual === error);
  }
});

test('estimate HTTP: pre-abort and active abort use actual request-signal wrappers and remove external listeners', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}'); });
  const pre = new AbortController();
  const reason = new Error('synthetic native abort');
  reason.name = 'AbortError';
  pre.abort(reason);
  await assert.rejects(fetchEstimateRows(['000002'], { api: API, now: NOW, signal: pre.signal }), error => error === reason);
  assert.equal(calls, 0);
  const active = new AbortController();
  const events = [];
  const add = active.signal.addEventListener.bind(active.signal);
  const remove = active.signal.removeEventListener.bind(active.signal);
  t.mock.method(active.signal, 'addEventListener', (name, callback, options) => { events.push(['add', name, options]); return add(name, callback, options); });
  t.mock.method(active.signal, 'removeEventListener', (name, callback) => { events.push(['remove', name]); return remove(name, callback); });
  let requestSignal;
  t.mock.method(globalThis, 'fetch', (_input, options) => {
    requestSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('synthetic fetch abort')), { once: true }));
  });
  const pending = fetchEstimateRows(['000002'], { api: API, now: NOW, signal: active.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR', aborted: true, message: 'synthetic caller abort' });
  assert.notEqual(requestSignal, active.signal);
  active.abort('synthetic caller abort');
  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(events, [['add', 'abort', { once: true }], ['remove', 'abort']]);
});

test('estimate HTTP: success and contract failure clean timers/listeners without aborting the completed request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const malformed of [false, true]) {
    const external = new AbortController();
    const removed = [];
    const remove = external.signal.removeEventListener.bind(external.signal);
    t.mock.method(external.signal, 'removeEventListener', (name, callback) => {
      removed.push(name);
      return remove(name, callback);
    });
    const calls = [];
    installJsonFetch(t, malformed ? payload(incoming({ status: 'invented' }), 2) : payload(), calls);
    const pending = fetchEstimateRows(['000002'], { api: API, now: NOW, signal: external.signal, timeout: 10 });
    if (malformed) await assert.rejects(pending, { name: 'WorkerContractError', code: 'WORKER_STATUS_INVALID' });
    else assertComplete((await pending).get('000002'), expectedRow());
    assert.deepEqual(removed, ['abort']);
    t.mock.timers.tick(20);
    assert.equal(calls[0].options.signal.aborted, false, 'settled-request deadline has been cleared');
    external.abort('after completion');
    assert.equal(calls[0].options.signal.aborted, false, 'settled-request external listener has been removed');
  }
});

test('estimate HTTP: timeout is normalized and an abort-ignoring fetch keeps its current late-success behavior', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', (_input, options) => new Promise((_resolve, reject) =>
    options.signal.addEventListener('abort', () => reject(new Error('synthetic timeout abort')), { once: true })));
  const pending = fetchEstimateRows(['000002'], { api: API, now: NOW, timeout: 10 });
  const rejected = assert.rejects(pending, { name: 'TimeoutError', code: 'REQUEST_TIMEOUT', timeoutMs: 10,
    message: 'Request timed out after 10ms' });
  t.mock.timers.tick(10);
  await rejected;
  const controller = new AbortController();
  let resolve;
  t.mock.method(globalThis, 'fetch', () => new Promise(done => { resolve = done; }));
  const late = fetchEstimateRows(['000002'], { api: API, now: NOW, signal: controller.signal });
  controller.abort('synthetic ignored abort');
  resolve(new Response(JSON.stringify(payload())));
  assertComplete((await late).get('000002'), expectedRow());
});

test('estimate public legacy: early identity/getter exceptions and changing reads remain observable', () => {
  const error = new TypeError('synthetic getter error');
  const trace = [];
  const invalid = { get code() { trace.push('code'); return 'bad'; }, get bzdm() { trace.push('bzdm'); throw error; } };
  assert.equal(normalizeEstimateRow(invalid, { now: NOW }), null);
  assert.deepEqual(trace, ['code']);
  assert.throws(() => normalizeEstimateRow({ get code() { throw error; } }, { now: NOW }), actual => actual === error);
  const throwingName = incoming();
  Object.defineProperty(throwingName, 'name', { enumerable: true, get() { throw error; } });
  assert.throws(() => normalizeEstimateRow(throwingName, { now: NOW }), actual => actual === error);
  const row = incoming();
  let reads = 0;
  Object.defineProperty(row, 'code', { enumerable: true, get() { return ['000002', '000003', '000004'][reads++]; } });
  const output = normalizeEstimateRow(row, { now: NOW, fetchedAt: FETCHED });
  assert.equal(reads, 3);
  assert.equal(output.code, '000002', 'the first public identity check wins over later wire/spread reads');
  assert.equal(output.source_quote.fundCode, '000002');
});

test('estimate public legacy: getter order, opaque symbol reads and presentation exceptions are not folded into HTTP-only assumptions', () => {
  const row = incoming();
  const trace = [];
  const diagnostics = { primary_reason: null, model_reason: null };
  const opaque = Symbol('synthetic opaque metadata');
  let identities = 0;
  let types = 0;
  Object.defineProperties(row, {
    code: { enumerable: true, get() { trace.push('code'); return ['000002', '000003', '000004'][identities++]; } },
    type: { enumerable: true, get() { trace.push('type'); return types++ === 0 ? 'wire type' : 'presentation type'; } },
    diagnostics: { enumerable: true, get() { trace.push('diagnostics'); return diagnostics; } },
    [opaque]: { enumerable: true, get() { trace.push('symbol'); return 'synthetic value'; } },
  });
  const result = normalizeEstimateRow(row, { now: NOW, fetchedAt: FETCHED });
  assert.deepEqual(trace, ['code', 'code', 'code', 'type', 'diagnostics', 'symbol',
    'type', 'diagnostics', 'diagnostics', 'diagnostics']);
  assert.equal(result.code, '000002');
  assert.equal(result.type, 'presentation type');
  assert.equal(result[opaque], 'synthetic value');
  assert.notEqual(result.diagnostics, diagnostics);
  assert.deepEqual(result.diagnostics, diagnostics);
  const error = new WorkerContractError('WORKER_ROW_INVALID');
  const later = incoming();
  let reads = 0;
  Object.defineProperty(later, 'type', { enumerable: true, get() {
    if (++reads === 2) throw error;
    return 'wire type';
  } });
  assert.throws(() => normalizeEstimateRow(later, { now: NOW }), actual => actual === error,
    'the public presentation read occurs outside the wire ROW_INVALID rescue');
  assert.equal(reads, 2);
});

test('estimate public legacy: only WORKER_ROW_INVALID receives a safe unusable row, not other contract errors', () => {
  for (const [changes, code] of [[{ est_nav: 9 }, 'WORKER_ALIAS_CONFLICT'],
    [{ status: 'invented' }, 'WORKER_STATUS_INVALID']]) {
    assert.throws(() => normalizeEstimateRow(incoming(changes), { now: NOW }), { name: 'WorkerContractError', code, message: code });
  }
  assert.throws(() => normalizeEstimateRow(incoming(), { wireVersion: 3, now: NOW }), {
    name: 'WorkerContractError', code: 'WORKER_SCHEMA_UNSUPPORTED', message: 'WORKER_SCHEMA_UNSUPPORTED',
  });
  const row = normalizeEstimateRow({ code: '000002', name: '合成缺失A', value_nav: NaN }, { now: NOW });
  assert.equal(row.status, 'error');
  assert.equal(row.source_status, 'ok');
  assert.equal(row.message, '估值契约不完整');
  assert.equal(row.fallback_reason, 'invalid_response');
  assert.equal(row.base_nav, null);
  assert.equal(row.value_nav, null);
  for (const key of ['last_nav', 'est_nav', 'est_change', 'coverage', 'quote_count']) assert.equal(Number.isNaN(row[key]), true);
  assert.equal(row.source_quote.status, 'unavailable');
  assert.equal(row.source_quote.value, null);
  assert.equal(row.source_quote.changePct, null);
  assert.ok(new WorkerContractError('WORKER_ROW_INVALID') instanceof Error);
});
