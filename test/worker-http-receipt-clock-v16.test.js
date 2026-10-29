import test from 'node:test';
import assert from 'node:assert/strict';
import * as worker from '../js/runtime/worker-contract.js';
import { fetchEstimateRows, normalizeEstimateRow } from '../js/eastmoney-estimate.js';
import { fetchFundHoldings } from '../js/fund-holdings.js';
import { createValuationPeriod } from '../js/runtime/valuation-period.js';
import { makeRefreshResourceEntry, validateRefreshResourceEntry } from '../js/runtime/refresh-resource-cache.js';
import { TTL } from '../js/config.js';
import {
  WORKER_FIXTURE_NOW as NOW, intradayRow, officialRow, unavailableRow, holdingsModelRow, qdiiRow,
  estimatesV1, estimatesV2, holdingRows, holdingsV1, holdingsV2,
} from './fixtures/worker-contract-v16.js';

const iso = value => new Date(value).toISOString();
const options = (extra = {}) => ({ endpoint: 'estimates', requestedCodes: ['000002'], now: NOW, ...extra });
const fixedError = code => error => error.name === 'WorkerContractError' && error.code === code;
const parseHttp = (payload, settings = options()) => {
  assert.equal(typeof worker.parseWorkerHttpEnvelope, 'function', 'a separate explicit HTTP entry is required');
  return worker.parseWorkerHttpEnvelope(payload, settings);
};
const sourceRow = (extra = {}) => intradayRow({ source: 'sinan-estimate-proxy', ...extra });

function installResponse(t, payload, { completedAt = NOW } = {}) {
  let localNow = completedAt - 10_000;
  t.mock.method(Date, 'now', () => localNow);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200,
    json: async () => { localNow = completedAt; return payload; } }));
}

test('HTTP receipt: normal envelope is byte/shape identical to strict parsing', () => {
  for (const payload of [estimatesV1([intradayRow()]), estimatesV2()]) {
    const before = JSON.stringify(payload);
    const strict = worker.parseWorkerEnvelope(payload, options());
    const http = parseHttp(payload);
    assert.deepEqual(http, strict);
    assert.equal(JSON.stringify(http), JSON.stringify(strict));
    assert.deepEqual(Object.keys(http), Object.keys(strict));
    assert.equal(Object.hasOwn(http, 'clientReceivedAt'), false);
    assert.equal(Object.hasOwn(http, 'skewMs'), false);
    assert.equal(JSON.stringify(payload), before);
  }
});

test('HTTP receipt: public strict entry cannot be switched by options or payload fields', () => {
  for (const field of ['fetched_at', 'generated_at']) {
    const payload = estimatesV2([intradayRow()], { [field]: iso(NOW + 1), allowSkew: true,
      maxSkew: Infinity, clientReceivedAt: iso(NOW + 86400000), skewMs: -86400000 });
    assert.throws(() => worker.parseWorkerEnvelope(payload, options({ allowSkew: true, maxSkew: Infinity,
      maxSkewMs: Infinity, clientReceivedAt: iso(NOW + 86400000), skewMs: -86400000 })), fixedError('WORKER_METADATA_INVALID'));
  }
});

test('HTTP receipt: only future top metadata from 1 through 2000 ms is accepted without mutation', () => {
  for (const amount of [1, 1999, 2000]) for (const field of ['fetched_at', 'generated_at']) {
    const payload = estimatesV2([intradayRow()], { [field]: iso(NOW + amount) });
    const before = JSON.stringify(payload);
    const result = parseHttp(payload);
    assert.equal(result.fetchedAt, payload.fetched_at);
    assert.equal(result.generatedAt, payload.generated_at);
    assert.equal(result.clientReceivedAt, iso(NOW));
    assert.equal(result.skewMs, amount);
    assert.equal(result.items[0].source_time, payload.items[0].source_time);
    assert.equal(result.items[0].value_date, '2026-09-30');
    assert.equal(JSON.stringify(payload), before);
  }
  const result = parseHttp(estimatesV1([intradayRow()], { fetched_at: iso(NOW + 2000) }));
  assert.equal(result.skewMs, 2000);
  assert.equal(result.generatedAt, '');
});

test('HTTP receipt: 2001 ms and spoofed thresholds/receipts cannot enter the fixed window', () => {
  for (const amount of [2001, 86400000]) for (const field of ['fetched_at', 'generated_at']) {
    const payload = estimatesV2([intradayRow()], { [field]: iso(NOW + amount), allowSkew: true,
      maxSkewMs: Infinity, clientReceivedAt: iso(NOW + amount), skewMs: 0 });
    assert.throws(() => parseHttp(payload, options({ allowSkew: true, maxSkewMs: Infinity,
      maxSkew: Infinity, clientReceivedAt: iso(NOW + amount), skewMs: 0 })), fixedError('WORKER_METADATA_INVALID'));
  }
});

test('HTTP receipt: malformed/absent versioned metadata still fails before row handling', () => {
  for (const invalid of ['2026-02-30T06:00:00Z', '2026-09-30 06:00:00', '', null, false, 0]) {
    for (const field of ['fetched_at', 'generated_at']) {
      assert.throws(() => parseHttp(estimatesV2([intradayRow()], { [field]: invalid })), fixedError('WORKER_METADATA_INVALID'));
    }
  }
  assert.throws(() => parseHttp(estimatesV2([intradayRow()], { generated_at: undefined })), fixedError('WORKER_METADATA_INVALID'));
});

test('HTTP receipt: a source time 1 ms in the future is not rescued by metadata tolerance', () => {
  const future = iso(NOW + 1);
  const row = intradayRow({ source_time: future, estimate_time: future, est_time: future });
  assert.throws(() => parseHttp(estimatesV2([row], { fetched_at: iso(NOW + 2000) })), fixedError('WORKER_ROW_INVALID'));
  assert.throws(() => parseHttp(estimatesV2([intradayRow({ source_time: null, estimate_time: null, est_time: null })],
    { fetched_at: iso(NOW + 1000) })), fixedError('WORKER_ROW_INVALID'));
});

test('HTTP receipt: midnight metadata may cross a date, but mainland target/source may not', () => {
  const midnight = Date.parse('2026-09-30T23:59:59.500+08:00');
  const metadata = iso(midnight + 1500);
  const context = options({ now: midnight });
  const result = parseHttp(estimatesV2([intradayRow()], { fetched_at: metadata, generated_at: metadata }), context);
  assert.equal(result.clientReceivedAt, iso(midnight));
  assert.equal(result.items[0].value_date, '2026-09-30');
  assert.throws(() => parseHttp(estimatesV2([intradayRow({ value_date: '2026-10-01' })],
    { fetched_at: metadata }), context), fixedError('WORKER_ROW_INVALID'));
  const future = iso(midnight + 1);
  assert.throws(() => parseHttp(estimatesV2([intradayRow({ source_time: future, estimate_time: future,
    est_time: future })], { fetched_at: metadata }), context), fixedError('WORKER_ROW_INVALID'));
});

test('HTTP receipt: aliases, model evidence, and holding report dates keep original strict validation', () => {
  const metadata = { fetched_at: iso(NOW + 1000) };
  assert.throws(() => parseHttp(estimatesV2([intradayRow({ est_nav: 9 })], metadata)), fixedError('WORKER_ALIAS_CONFLICT'));
  assert.throws(() => parseHttp(estimatesV2([holdingsModelRow({ report_date: '2026-12-31', model_report_date: '2026-12-31' })], metadata),
    options({ requestedCodes: ['000003'] })), fixedError('WORKER_MODEL_EVIDENCE_INVALID'));
  assert.throws(() => parseHttp(estimatesV2([qdiiRow({ sample_count: 0 })], metadata),
    options({ requestedCodes: ['000005'] })), fixedError('WORKER_MODEL_EVIDENCE_INVALID'));
  assert.throws(() => parseHttp(holdingsV2(holdingRows(), { ...metadata, report_date: '2026-12-31' }),
    options({ endpoint: 'holdings', requestedCodes: ['000001'] })), fixedError('HOLDINGS_REPORT_DATE_FUTURE'));
});

test('HTTP receipt: estimate client captures receipt after JSON and preserves raw row fetched_at', async t => {
  const rawRowTime = iso(NOW + 1500);
  const payload = estimatesV2([sourceRow({ fetched_at: rawRowTime })], { fetched_at: iso(NOW + 1000), generated_at: iso(NOW + 2000) });
  const before = JSON.stringify(payload);
  installResponse(t, payload);
  const row = (await fetchEstimateRows(['000002'], { api: 'https://synthetic.invalid/estimates',
    clientReceivedAt: iso(NOW + 86400000), maxSkewMs: Infinity })).get('000002');
  assert.equal(row.fetched_at, rawRowTime);
  assert.equal(row.source_quote.fetchedAt, iso(NOW));
  assert.equal(row.source_quote.observedAt, payload.items[0].source_time);
  assert.equal(row.source_quote.targetDate, '2026-09-30');
  assert.equal(row.source_quote.value, 1.01);
  assert.equal(JSON.stringify(payload), before);
});

test('HTTP receipt: holdings client projects only skewed metadata onto local receipt', async t => {
  for (const factory of [holdingsV1, holdingsV2]) {
    const payload = factory(holdingRows(), { fetched_at: iso(NOW + 2000) });
    const before = JSON.stringify(payload);
    installResponse(t, payload);
    const result = await fetchFundHoldings('000001', { api: 'https://synthetic.invalid/holdings', clientReceivedAt: iso(NOW + 86400000) });
    assert.equal(result.fetchedAt, iso(NOW));
    assert.equal(result.reportDate, '2026-06-30');
    assert.deepEqual(result.items, holdingRows());
    assert.equal(JSON.stringify(payload), before);
    t.mock.restoreAll();
  }
});

test('HTTP receipt: normal client paths retain row priority and exact old output shape', async t => {
  const rawRowTime = iso(NOW - 120000);
  const payload = estimatesV2([sourceRow({ fetched_at: rawRowTime })]);
  installResponse(t, payload);
  const expectedEnvelope = worker.parseWorkerEnvelope(payload, options());
  const expected = normalizeEstimateRow(expectedEnvelope.items[0], { wireVersion: 2, fetchedAt: expectedEnvelope.fetchedAt, now: NOW });
  const row = (await fetchEstimateRows(['000002'], { api: 'https://synthetic.invalid/estimates', now: NOW })).get('000002');
  assert.deepEqual(row, expected);
  assert.equal(JSON.stringify(row), JSON.stringify(expected));
  assert.equal(row.source_quote.fetchedAt, rawRowTime);
  assert.deepEqual(normalizeEstimateRow(expectedEnvelope.items[0], { wireVersion: 2, fetchedAt: expectedEnvelope.fetchedAt,
    now: NOW, clientReceivedAt: iso(NOW + 86400000), maxSkewMs: Infinity }), expected,
  'public row normalization has no receipt override switch');
  const holdings = holdingsV2();
  t.mock.restoreAll();
  installResponse(t, holdings);
  assert.deepEqual(await fetchFundHoldings('000001', { api: 'https://synthetic.invalid/holdings', now: NOW }), {
    status: 'ok', sourceStatus: 'ok', wireVersion: 2, reportDate: '2026-06-30',
    fetchedAt: holdings.fetched_at, source: holdings.source, items: holdingRows(),
  });
});

test('HTTP receipt: real HTTP clients reject 2001 ms even with forged receipt options', async t => {
  for (const endpoint of ['estimates', 'holdings']) {
    const payload = endpoint === 'estimates'
      ? estimatesV2([sourceRow()], { fetched_at: iso(NOW + 2001) })
      : holdingsV2(holdingRows(), { fetched_at: iso(NOW + 2001) });
    installResponse(t, payload);
    const settings = { api: `https://synthetic.invalid/${endpoint}`, clientReceivedAt: iso(NOW + 86400000), maxSkewMs: Infinity };
    await assert.rejects(endpoint === 'estimates' ? fetchEstimateRows(['000002'], settings) : fetchFundHoldings('000001', settings),
      fixedError('WORKER_METADATA_INVALID'));
    t.mock.restoreAll();
  }
});

test('HTTP receipt: real zero stays zero and unavailable/missing data never becomes zero', async t => {
  const zero = sourceRow({ value_nav: 1, estimate_nav: 1, est_nav: 1, estimate_change: 0, est_change: 0 });
  installResponse(t, estimatesV2([zero], { fetched_at: iso(NOW + 1000) }));
  const current = (await fetchEstimateRows(['000002'], { api: 'https://synthetic.invalid/estimates' })).get('000002');
  assert.equal(current.source_quote.changePct, 0);
  assert.equal(createValuationPeriod(current.source_quote, { now: NOW, shares: 100 }).profitAmount, 0);
  t.mock.restoreAll();
  const absent = unavailableRow({ code: '000002' });
  installResponse(t, estimatesV2([absent], { fetched_at: iso(NOW + 1000), status: 'unavailable' }));
  const unavailable = (await fetchEstimateRows(['000002'], { api: 'https://synthetic.invalid/estimates' })).get('000002');
  assert.equal(unavailable.source_quote.value, null);
  assert.equal(unavailable.source_quote.changePct, null);
  assert.equal(unavailable.source_quote.observedAt, null);
  assert.equal(unavailable.source_quote.status, 'unavailable');
  for (const missing of [null, '', '--', undefined]) {
    assert.throws(() => parseHttp(estimatesV2([sourceRow({ estimate_change: missing, est_change: missing })],
      { fetched_at: iso(NOW + 1000) })), fixedError('WORKER_ROW_INVALID'));
  }
});

test('HTTP receipt: future source rejects through real clients, independently of future metadata', async t => {
  const future = iso(NOW + 1);
  installResponse(t, estimatesV2([sourceRow({ source_time: future, estimate_time: future, est_time: future })], { fetched_at: iso(NOW + 1000) }));
  await assert.rejects(fetchEstimateRows(['000002'], { api: 'https://synthetic.invalid/estimates' }), fixedError('WORKER_ROW_INVALID'));
});

test('HTTP receipt: old source remains stale despite newly received transport metadata', async t => {
  const old = '2026-09-28T13:59:00+08:00';
  const row = sourceRow({ base_nav_date: '2026-09-25', value_date: '2026-09-28', source_time: old, estimate_time: old, est_time: old });
  installResponse(t, estimatesV2([row], { fetched_at: iso(NOW + 1000) }));
  const result = (await fetchEstimateRows(['000002'], { api: 'https://synthetic.invalid/estimates' })).get('000002');
  assert.equal(result.source_quote.fetchedAt, iso(NOW));
  assert.equal(result.source_quote.observedAt, old);
  assert.equal(result.source_quote.status, 'stale');
  assert.equal(createValuationPeriod(result.source_quote, { now: NOW }).isTodayEstimate, false);
});

test('HTTP receipt: projected acquisition enters strict cache and reads never renew its timestamps', async t => {
  const rawRowTime = iso(NOW + 1500);
  installResponse(t, estimatesV2([sourceRow({ fetched_at: rawRowTime })], { fetched_at: iso(NOW + 1000) }));
  const row = (await fetchEstimateRows(['000002'], { api: 'https://synthetic.invalid/estimates' })).get('000002');
  const key = 'estimates:000002';
  const entry = makeRefreshResourceEntry(key, { source: 'sinan-estimate-proxy', codes: ['000002'], rows: [row] },
    { now: NOW, fetchedAt: NOW, sourceDate: '2026-09-30' });
  assert.ok(entry);
  assert.equal(entry.payload.rows[0].fetched_at, rawRowTime);
  assert.equal(entry.payload.rows[0].source_quote.fetchedAt, iso(NOW));
  assert.equal(entry.fetchedAt, NOW);
  assert.equal(entry.cachedAt, NOW);
  assert.equal(entry.expiresAt, NOW + TTL.INTRADAY);
  for (const at of [NOW + TTL.INTRADAY, NOW + TTL.INTRADAY + 1000]) {
    const read = validateRefreshResourceEntry(key, JSON.parse(JSON.stringify(entry)), { now: at });
    assert.ok(read);
    assert.equal(read.cacheState, 'stale');
    assert.equal(read.fetchedAt, entry.fetchedAt);
    assert.equal(read.cachedAt, entry.cachedAt);
    assert.equal(read.expiresAt, entry.expiresAt);
    assert.equal(read.payload.rows[0].source_quote.fetchedAt, iso(NOW));
  }
  assert.equal(makeRefreshResourceEntry(key, entry.payload, { now: NOW, fetchedAt: NOW + 1, sourceDate: '2026-09-30' }), null);
});

test('HTTP receipt: official single-date source is not replaced with receipt or today', async t => {
  const payload = estimatesV1([officialRow({ source: 'eastmoney_official_nav' })], { fetched_at: iso(NOW + 1000) });
  installResponse(t, payload);
  const row = (await fetchEstimateRows(['000001'], { api: 'https://synthetic.invalid/estimates' })).get('000001');
  assert.equal(row.source_quote.observedAt, '2026-09-29');
  assert.equal(row.source_quote.targetDate, '2026-09-29');
  assert.equal(row.source_quote.valueKind, 'official_nav');
  assert.equal(row.source_quote.status, 'official');
  assert.equal(createValuationPeriod(row.source_quote, { now: NOW }).isTodayEstimate, false);
});

test('HTTP receipt stage2: explicit null/zero/false client clocks retain legacy failure semantics', async t => {
  for (const now of [null, 0, false]) for (const endpoint of ['estimates', 'holdings']) {
    const payload = endpoint === 'estimates' ? estimatesV2([sourceRow()]) : holdingsV2();
    installResponse(t, payload);
    const settings = { api: `https://synthetic.invalid/${endpoint}`, now };
    await assert.rejects(endpoint === 'estimates' ? fetchEstimateRows(['000002'], settings) : fetchFundHoldings('000001', settings),
      fixedError('WORKER_METADATA_INVALID'));
    t.mock.restoreAll();
  }
});

test('HTTP receipt stage2: HTTP v1 own generated_at is bounded while strict v1 unknown-field behavior is preserved', () => {
  const context = options();
  for (const generated_at of [iso(NOW + 2001), iso(NOW + 86400000), '2026-02-30T06:00:00Z',
    '2026-09-30 06:00:00', '', null, false, 0, undefined]) {
    const payload = estimatesV1([intradayRow()], { generated_at, maxSkewMs: Infinity, clientReceivedAt: iso(NOW + 86400000) });
    const strict = worker.parseWorkerEnvelope(payload, context);
    assert.equal(strict.generatedAt, generated_at || '');
    assert.equal(Object.hasOwn(strict, 'clientReceivedAt'), false);
    assert.throws(() => parseHttp(payload, { ...context, maxSkewMs: Infinity, clientReceivedAt: iso(NOW + 86400000) }),
      fixedError('WORKER_METADATA_INVALID'));
  }
  for (const amount of [-1, 0, 1, 2000]) {
    const generated_at = iso(NOW + amount);
    const payload = estimatesV1([intradayRow()], { generated_at });
    const before = JSON.stringify(payload);
    const http = parseHttp(payload, context);
    assert.equal(http.generatedAt, generated_at);
    if (amount > 0) {
      assert.equal(http.clientReceivedAt, iso(NOW));
      assert.equal(http.skewMs, amount);
    } else assert.deepEqual(http, worker.parseWorkerEnvelope(payload, context));
    assert.equal(JSON.stringify(payload), before);
  }
  const settings = options({ endpoint: 'holdings', requestedCodes: ['000001'] });
  assert.throws(() => parseHttp(holdingsV1(holdingRows(), { generated_at: iso(NOW + 2001) }), settings), fixedError('WORKER_METADATA_INVALID'));
  assert.equal(parseHttp(holdingsV1(holdingRows(), { generated_at: iso(NOW + 2000) }), settings).skewMs, 2000);
});
