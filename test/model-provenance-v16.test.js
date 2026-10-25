import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculateHoldingsEstimate, applyHoldingsEstimate, composeFundEnrichment } from '../js/holdings-estimate.js';
import { applyOverseasModelEstimate } from '../js/runtime/fund-model-enrichment.js';
import { loadOverseasModels, selectOverseasModel } from '../js/overseas-model.js';
import {
  buildFundQuoteCandidates, selectPreferredQuote,
  normalizeHoldingLookthroughQuote, normalizeMarketModelQuote,
} from '../js/runtime/quote-normalizer.js';
import { createQuoteEnvelope } from '../js/runtime/quote-contract.js';
import { classifyFundMarket } from '../js/freshness.js';

// Independent financial expectations: no Temp oracle, network, storage or
// proposed replacement helper is used. The configured domestic rule is real;
// every holding, price, change and identity below is synthetic.
const CONFIG = JSON.parse(await readFile(new URL('../data/overseas-models.json', import.meta.url), 'utf8'));
const NativeDate = globalThis.Date;
const NOW = NativeDate.parse('2026-09-30T06:45:00Z');
const FETCHED_AT = '2026-09-30T06:44:30.000Z';
const CODE = '000002';
const NAME = '合成沪深300指数基金';
const IDENTITY = { fundCode: CODE, fundName: NAME, market: 'cn', assetKind: 'index_fund' };
const QUARTERLY = 'quarterly-holdings-model';
const MARKET = 'market-model';
const SLOTS = [
  { key: 'holdings_model_evidence', flag: 'est_holdings_model', otherKey: 'market_model_evidence', otherFlag: 'est_model', source: QUARTERLY,
    normalize: normalizeHoldingLookthroughQuote, kind: 'holding_lookthrough_estimate', value: 1.012, change: 1.2, coverage: 60, time: '2026-09-30 14:43:00' },
  { key: 'market_model_evidence', flag: 'est_model', otherKey: 'holdings_model_evidence', otherFlag: 'est_holdings_model', source: MARKET,
    normalize: normalizeMarketModelQuote, kind: 'model_estimate', value: 1.03, change: 3, coverage: 100, time: '2026-09-30 14:44:00' },
];

function approx(actual, expected, label) {
  assert.ok(typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-10,
    `${label}: expected ${expected}, received ${actual}`);
}

function fixedTest(name, run) {
  test(name, { concurrency: false }, async () => {
    const previousDate = globalThis.Date;
    const previousFetch = globalThis.fetch;
    const descriptors = Object.fromEntries(['localStorage', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const forbidden = { fetch: 0, localStorage: 0, sessionStorage: 0 };
    class Clock extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [NOW])); }
      static now() { return NOW; }
    }
    globalThis.Date = Clock;
    globalThis.fetch = async () => { forbidden.fetch++; throw new Error('This regression must not access the network.'); };
    for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(globalThis, key, {
      configurable: true, get() { forbidden[key]++; throw new Error('This regression must not access real Storage.'); },
    });
    try { await run(); }
    finally {
      globalThis.Date = previousDate;
      globalThis.fetch = previousFetch;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      assert.deepEqual(forbidden, { fetch: 0, localStorage: 0, sessionStorage: 0 });
    }
  });
}

async function realConfiguredRule() {
  let calls = 0;
  await loadOverseasModels(async () => {
    calls++;
    return { ok: true, json: async () => structuredClone(CONFIG) };
  });
  assert.equal(calls, 1);
  assert.equal(classifyFundMarket(NAME), 'cn-index');
  const model = selectOverseasModel(CODE, NAME);
  assert.equal(model.pattern, '沪深300');
  assert.deepEqual(model.legs.map(leg => [leg.code, leg.weight]), [['sh000300', 100]]);
}

function rawInputs(kind = 'fresh') {
  const source_quote = createQuoteEnvelope({
    ...IDENTITY, valueKind: 'official_nav', value: 1, changePct: (1 / 0.99 - 1) * 100,
    baseNav: 0.99, baseNavDate: '2026-09-28', targetDate: '2026-09-29', officialNavDate: '2026-09-29',
    sourceId: 'eastmoney-official-nav', sourceTier: 'secondary', status: kind === 'stale-baseline' ? 'stale' : 'official',
    observedAt: '2026-09-29', fetchedAt: FETCHED_AT, reasonCodes: [],
  }, { now: NOW });
  const raw = {
    code: CODE, name: NAME, market: 'cn', assetKind: 'index_fund', status: 'ok_official',
    last_nav: 0.99, nav_date: '2026-09-28', est_nav: 1, est_change: (1 / 0.99 - 1) * 100,
    est_time: '2026-09-29', est_kind: 'official_nav', est_realtime: false,
    base_nav: 0.99, base_nav_date: '2026-09-28', value_date: '2026-09-29', source_quote,
  };
  const move = { nav: 1, prevNav: 0.99, date: '2026-09-29', prevDate: '2026-09-28', change: (1 / 0.99 - 1) * 100, changeAmt: 0.01, fundName: NAME };
  if (kind === 'official-current') Object.assign(move, { nav: 1.1, prevNav: 1, date: '2026-09-30', prevDate: '2026-09-29', change: 10, changeAmt: 0.1 });
  if (kind === 'stale-baseline') Object.assign(move, { status: 'stale', stale: true, cacheState: 'stale' });
  if (kind === 'legacy-holdings' || kind === 'legacy-dual') Object.assign(raw, {
    est_holdings_model: true, est_kind: 'holdings_model', last_nav: 1, nav_date: '2026-09-29',
    est_nav: 1.012, est_change: 1.2, est_time: '2026-09-30 14:43:00', est_holdings_base_nav: 1,
    est_holdings_base_date: '2026-09-29', est_holdings_target_date: '2026-09-30', est_holdings_coverage: 60,
    est_holdings_quote_count: 6, est_holdings_report_date: '2026-06-30', est_note: '合成旧重仓说明',
  });
  if (kind === 'legacy-market' || kind === 'legacy-dual') Object.assign(raw, {
    est_model: true, est_model_stale: false, est_kind: 'overseas_model', last_nav: 1, nav_date: '2026-09-29',
    est_nav: 1.03, est_change: 3, est_time: '2026-09-30 14:44:00', est_model_time: '2026-09-30 14:44:00',
    est_model_base_nav: 1, est_model_base_date: '2026-09-29', est_model_target_date: '2026-09-30',
    est_model_weight: 100, est_model_version: 'rule-v1', est_confidence: 'medium', est_note: '合成旧跟踪指数代理说明',
  });
  return { raw, move };
}

async function pipeline({ kind = 'fresh', holdingChange = null, marketChange = null, holdingTime = '2026-09-30 14:43:00' } = {}) {
  await realConfiguredRule();
  const { raw, move } = rawInputs(kind);
  const stocks = holdingChange == null ? null : Array.from({ length: 6 }, (_, index) => ({
    code: String(600001 + index), name: `合成股票${index + 1}`, ratio: 10, market: 'cn', change: holdingChange, quoteTime: holdingTime,
  }));
  const estimate = stocks ? calculateHoldingsEstimate(stocks, { now: NOW, reportDate: '2026-06-30', requireCurrentReport: true }) : null;
  if (stocks) {
    assert.equal(estimate.available, true);
    assert.equal(estimate.coverage, 60);
    assert.equal(estimate.quoteCount, 6);
  }
  const fund = composeFundEnrichment(raw, { officialNavMove: move, holdingsEstimate: estimate, fetchedAt: FETCHED_AT });
  applyOverseasModelEstimate(fund, marketChange == null ? {} : { sh000300: { changePct: marketChange, sourceTime: '2026-09-30 14:44:00' } }, { fetchedAt: FETCHED_AT });
  return fund;
}

function projected(fund, options = {}) {
  const candidates = buildFundQuoteCandidates(fund, { ...IDENTITY, now: NOW, ...options });
  const selected = selectPreferredQuote(candidates, IDENTITY, { now: NOW });
  return { candidates, selected };
}

function assertModel(quote, expected) {
  assert.ok(quote, `Missing ${expected.sourceId} quote`);
  assert.equal(quote.status, 'model');
  assert.equal(quote.sourceTier, 'model');
  assert.equal(quote.fundCode, CODE);
  assert.equal(quote.sourceId, expected.sourceId);
  assert.equal(quote.valueKind, expected.valueKind);
  approx(quote.value, expected.value, 'model NAV');
  approx(quote.changePct, expected.changePct, 'model change');
  approx(quote.baseNav, 1, 'base NAV');
  assert.equal(quote.baseNavDate, '2026-09-29');
  assert.equal(quote.targetDate, '2026-09-30');
  assert.equal(quote.coverage, expected.coverage);
  assert.equal(quote.observedAt, expected.observedAt);
}

function assertOfficial(selected, value = 1, status = 'official', date = '2026-09-29') {
  assert.equal(selected.sourceId, 'eastmoney-official-nav');
  assert.equal(selected.valueKind, 'official_nav');
  assert.equal(selected.status, status);
  assert.equal(selected.fundCode, CODE);
  approx(selected.value, value, 'official selected NAV');
  assert.equal(selected.targetDate, date);
}

const q = (value, changePct, observedAt = '2026-09-30 14:43:00') => ({ sourceId: QUARTERLY, valueKind: 'holding_lookthrough_estimate', value, changePct, coverage: 60, observedAt });
const m = (value, changePct) => ({ sourceId: MARKET, valueKind: 'model_estimate', value, changePct, coverage: 100, observedAt: '2026-09-30 14:44:00' });
// The original thirteen financial scenarios stay literal and independent.
// Unlike the initial RED harness, valid model and selected states are explicit.
const CORE = [
  { id: 'P01 dual distinct values', holdingChange: 2, marketChange: 3, expected: [q(1.012, 1.2), m(1.03, 3)], selected: m(1.03, 3) },
  { id: 'P02 zero holdings contribution', holdingChange: 0, marketChange: 3, expected: [q(1, 0), m(1.03, 3)], selected: m(1.03, 3) },
  { id: 'P03 negative holdings contribution', holdingChange: -2, marketChange: 3, expected: [q(0.988, -1.2), m(1.03, 3)], selected: m(1.03, 3) },
  { id: 'P04 zero index move', holdingChange: 2, marketChange: 0, expected: [q(1.012, 1.2), m(1, 0)], selected: m(1, 0) },
  { id: 'P05 negative index move', holdingChange: 2, marketChange: -3, expected: [q(1.012, 1.2), m(0.97, -3)], selected: m(0.97, -3) },
  { id: 'P06 independent observed clocks', holdingChange: 2, marketChange: 3, holdingTime: '2026-09-30 14:40:00', expected: [q(1.012, 1.2, '2026-09-30 14:40:00'), m(1.03, 3)], selected: m(1.03, 3) },
  { id: 'P07 legacy single holdings', kind: 'legacy-holdings', expected: [q(1.012, 1.2)], selected: q(1.012, 1.2), absent: [MARKET] },
  { id: 'P08 legacy single market', kind: 'legacy-market', expected: [m(1.03, 3)], selected: m(1.03, 3), absent: [QUARTERLY] },
  { id: 'P09 ambiguous legacy dual flags', kind: 'legacy-dual', expected: [], unavailable: true },
  { id: 'P10 current official blocks reapplication', kind: 'official-current', holdingChange: 2, marketChange: 3, expected: [], official: [1.1, 'official', '2026-09-30'] },
  { id: 'P11 stale baseline cannot seed models', kind: 'stale-baseline', holdingChange: 2, marketChange: 3, expected: [], official: [1, 'stale', '2026-09-29'] },
  { id: 'P12 fresh holdings only', holdingChange: 2, expected: [q(1.012, 1.2)], selected: q(1.012, 1.2), absent: [MARKET] },
  { id: 'P13 fresh market only', marketChange: 3, expected: [m(1.03, 3)], selected: m(1.03, 3), absent: [QUARTERLY] },
];

for (const spec of CORE) fixedTest(`model provenance ${spec.id}`, async () => {
  const fund = await pipeline(spec);
  const { candidates, selected } = projected(fund);
  for (const expected of spec.expected) {
    const matches = candidates.filter(quote => quote.sourceId === expected.sourceId);
    assert.equal(matches.length, 1);
    assertModel(matches[0], expected);
  }
  for (const source of spec.absent || []) assert.equal(candidates.some(quote => quote.sourceId === source), false);
  if (spec.selected) assertModel(selected, spec.selected);
  else assertOfficial(selected, ...(spec.official || []));
  if (!spec.expected.length) assert.equal(candidates.some(quote => quote.status === 'model'), false);
  if (spec.unavailable) {
    assert.equal(normalizeHoldingLookthroughQuote(fund, { now: NOW }).status, 'unavailable');
    assert.equal(normalizeMarketModelQuote(fund, { now: NOW }).status, 'unavailable');
  }
});

async function singleEvidenceFund(slot) {
  const fund = await pipeline({ holdingChange: 2, marketChange: 3 });
  delete fund[slot.otherKey];
  delete fund[slot.otherFlag];
  // Poisoned aliases prove damaged new evidence cannot silently use the last
  // model's shared numbers. Valid evidence must remain independently correct.
  fund.est_nav = 9.9;
  fund.est_change = 99;
  return fund;
}

function expectedSlot(slot) {
  return { sourceId: slot.source, valueKind: slot.kind, value: slot.value, changePct: slot.change, coverage: slot.coverage, observedAt: slot.time };
}

function assertRejected(slot, fund, options = {}) {
  const quote = slot.normalize(fund, { now: NOW, ...options });
  assert.equal(quote.status, 'unavailable');
  assert.equal(quote.value, null);
  assert.equal(quote.changePct, null);
  const result = projected(fund, options);
  assert.equal(result.candidates.some(item => item.status === 'model'), false);
  assertOfficial(result.selected);
}

const DAMAGED = [
  ['null slot', () => null],
  ['array slot', () => []],
  ['missing value', evidence => { delete evidence.value; return evidence; }],
  ['inconsistent value/change', evidence => ({ ...evidence, value: 8 })],
  ['NaN confidence', evidence => ({ ...evidence, confidence: NaN })],
  ['NaN coverage', evidence => ({ ...evidence, coverage: NaN })],
];
for (const slot of SLOTS) {
  for (const [name, damage] of DAMAGED) fixedTest(`${slot.key}: ${name} never rescues legacy aliases`, async () => {
    const fund = await singleEvidenceFund(slot);
    fund[slot.key] = damage({ ...fund[slot.key] });
    assertRejected(slot, fund);
  });

  for (const mode of ['foreign fundCode', 'missing fundCode', 'options cannot relabel foreign evidence']) fixedTest(`${slot.key}: ${mode}`, async () => {
    const fund = await singleEvidenceFund(slot);
    const evidence = { ...fund[slot.key], fundCode: '000999' };
    if (mode === 'missing fundCode') delete evidence.fundCode;
    fund[slot.key] = evidence;
    assertRejected(slot, fund, { fundCode: mode.startsWith('options') ? '000999' : CODE });
    assert.equal(fund.code, CODE);
  });

  for (const field of ['fundCode', 'value', 'fetchedAt', 'note']) fixedTest(`${slot.key}: ${field} accessor is rejected without calling it`, async () => {
    const fund = await singleEvidenceFund(slot);
    let reads = 0;
    const evidence = { ...fund[slot.key] };
    Object.defineProperty(evidence, field, { enumerable: true, get() { reads++; throw new Error('Untrusted evidence accessor must not run'); } });
    fund[slot.key] = evidence;
    assertRejected(slot, fund);
    assert.equal(reads, 0);
  });

  fixedTest(`${slot.key}: outer slot accessor is rejected without calling it`, async () => {
    const fund = await singleEvidenceFund(slot);
    let reads = 0;
    Object.defineProperty(fund, slot.key, { enumerable: true, configurable: true, get() { reads++; throw new Error('Untrusted slot accessor must not run'); } });
    assertRejected(slot, fund);
    assert.equal(reads, 0);
  });

  fixedTest(`${slot.key}: JSON round trip preserves financial evidence and selected source`, async () => {
    const original = await singleEvidenceFund(slot);
    const fund = JSON.parse(JSON.stringify(original));
    assertModel(slot.normalize(fund, { now: NOW }), expectedSlot(slot));
    assertModel(projected(fund).selected, expectedSlot(slot));
    assert.equal(fund[slot.key].fetchedAt, FETCHED_AT);
  });

  fixedTest(`${slot.key}: reads do not renew fetchedAt or inspect a replacement clock`, async () => {
    const fund = await singleEvidenceFund(slot);
    const before = JSON.stringify(fund[slot.key]);
    let reads = 0;
    const options = { now: NOW + 60_000, get fetchedAt() { reads++; return '2026-09-30T06:46:00Z'; } };
    const first = slot.normalize(fund, options);
    const second = slot.normalize(fund, options);
    assertModel(first, expectedSlot(slot));
    assert.deepEqual(second, first);
    assert.equal(first.fetchedAt, FETCHED_AT);
    assert.equal(reads, 0);
    assert.equal(JSON.stringify(fund[slot.key]), before);
    const { selected } = projected(fund, { now: NOW + 60_000, fetchedAt: '2026-09-30T06:46:00Z' });
    assertModel(selected, expectedSlot(slot));
    assert.equal(selected.fetchedAt, FETCHED_AT);
  });

  fixedTest(`${slot.key}: zero confidence remains zero and the model stays selected`, async () => {
    const fund = await singleEvidenceFund(slot);
    fund[slot.key] = { ...fund[slot.key], confidence: 0 };
    const quote = slot.normalize(fund, { now: NOW });
    assertModel(quote, expectedSlot(slot));
    assert.equal(quote.confidence, 0);
    const { selected } = projected(fund);
    assertModel(selected, expectedSlot(slot));
    assert.equal(selected.confidence, 0);
  });

  fixedTest(`${slot.key}: future observation is stale, never a current selected model`, async () => {
    const fund = await singleEvidenceFund(slot);
    fund[slot.key] = { ...fund[slot.key], observedAt: '2026-09-30 15:00:00', fetchedAt: null };
    const quote = slot.normalize(fund, { now: NOW });
    assert.equal(quote.status, 'stale');
    assert.equal(quote.sourceId, slot.source);
    assert.ok(quote.reasonCodes.includes('SOURCE_TIME_IN_FUTURE'));
    assertOfficial(projected(fund).selected);
  });

  for (const period of ['reversed', 'wrong target']) fixedTest(`${slot.key}: ${period} period cannot become usable`, async () => {
    const fund = await singleEvidenceFund(slot);
    fund[slot.key] = { ...fund[slot.key], ...(period === 'reversed' ? { baseNavDate: '2026-09-30' } : { targetDate: '2026-10-01' }) };
    assertRejected(slot, fund);
  });

  fixedTest(`${slot.key}: one valid slot with dual flags does not fabricate the other source`, async () => {
    const fund = await singleEvidenceFund(slot);
    fund[slot.otherFlag] = true;
    assert.equal(Object.hasOwn(fund, slot.otherKey), false);
    const { candidates, selected } = projected(fund);
    const valid = candidates.filter(quote => quote.status === 'model');
    assert.equal(valid.length, 1);
    assertModel(valid[0], expectedSlot(slot));
    assertModel(selected, expectedSlot(slot));
    const other = SLOTS.find(item => item.key === slot.otherKey);
    const absent = other.normalize(fund, { now: NOW });
    assert.equal(absent.status, 'unavailable');
    assert.equal(absent.value, null);
  });
}

fixedTest('holdings evidence: expired disclosure is stale and official remains selected', async () => {
  const slot = SLOTS[0];
  const fund = await singleEvidenceFund(slot);
  fund[slot.key] = { ...fund[slot.key], reportDate: '2025-12-31' };
  const quote = slot.normalize(fund, { now: NOW });
  assert.equal(quote.status, 'stale');
  assert.ok(quote.reasonCodes.includes('MODEL_EVIDENCE_EXPIRED'));
  assertOfficial(projected(fund).selected);
});

for (const expiration of [
  { name: 'past-quarter model', quarter: '2026Q1', validUntil: '', status: 'stale' },
  { name: 'explicit validUntil expiry', quarter: '2026Q3', validUntil: '2026-09-29', status: 'stale' },
  { name: 'explicit future expiry overrides old quarter', quarter: '2026Q1', validUntil: '2026-10-31', status: 'model' },
]) fixedTest(`market evidence: ${expiration.name}`, async () => {
  const slot = SLOTS[1];
  const fund = await singleEvidenceFund(slot);
  fund[slot.key] = { ...fund[slot.key], quarter: expiration.quarter, validUntil: expiration.validUntil };
  const quote = slot.normalize(fund, { now: NOW });
  assert.equal(quote.status, expiration.status);
  if (expiration.status === 'model') {
    assertModel(quote, expectedSlot(slot));
    assertModel(projected(fund).selected, expectedSlot(slot));
  } else {
    assert.ok(quote.reasonCodes.includes('MODEL_EVIDENCE_EXPIRED'));
    assertOfficial(projected(fund).selected);
  }
});

fixedTest('manual legacy holdings estimate without report metadata retains single-model compatibility', () => {
  const { raw, move } = rawInputs();
  const fund = { ...raw, latest_nav_move: move };
  applyHoldingsEstimate(fund, { available: true, change: 1.2, coverage: 60, quoteCount: 6, sourceTime: '2026-09-30 14:43:00' });
  assert.equal(fund.est_holdings_model, true);
  assert.equal(Object.hasOwn(fund, 'holdings_model_evidence'), false);
  assertModel(normalizeHoldingLookthroughQuote(fund, { now: NOW }), q(1.012, 1.2));
  assertModel(projected(fund).selected, q(1.012, 1.2));
});
