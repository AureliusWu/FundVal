import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteEnvelope } from '../js/runtime/quote-contract.js';
import { modelNoteForQuote, normalizeCachedQuote, normalizeExistingQuoteFreshness,
  normalizeFundQuoteFreshness, normalizeHoldingLookthroughQuote, normalizeMarketModelQuote } from '../js/runtime/quote-normalizer.js';
import { updateFundAccuracy } from '../js/accuracy.js';

const BEFORE = Date.parse('2026-09-30T23:59:30+08:00');
const AFTER = Date.parse('2026-10-01T00:00:02+08:00');
function modelFund() {
  const evidence = {
    fundCode: '000002', value: 1.03, changePct: 3, baseNav: 1,
    baseNavDate: '2026-09-29', targetDate: '2026-09-30', observedAt: '2026-09-30 23:59:00',
    fetchedAt: '2026-09-30T15:59:10.000Z', coverage: 100, confidence: 0.65,
    modelVersion: 'v1', label: '合成独立模型', note: '合成v1/100%说明',
    quarter: '2026Q3', validUntil: '2026-09-30', minimumWeight: 100,
  };
  const fund = { code: '000002', name: '合成沪深300指数', market: 'cn', assetKind: 'index_fund',
    est_model: true, est_model_stale: false, est_model_version: 'obsolete',
    est_model_label: '错误共享说明', est_confidence: 'high', est_note: '错误共享说明',
    market_model_evidence: evidence };
  fund.quote = normalizeMarketModelQuote(fund, { now: BEFORE });
  assert.equal(fund.quote.status, 'model');
  return fund;
}
function memory() {
  let text = '[]';
  return { storage: { getItem: () => text, setItem: (_key, value) => { text = value; } }, rows: () => JSON.parse(text) };
}

test('selected model and its fresh outer cache cannot bypass explicit model expiry', () => {
  const fund = modelFund();
  fund.quote = normalizeCachedQuote(fund.quote, { now: BEFORE, fresh: true,
    cachedAt: BEFORE, expiresAt: AFTER + 3600_000 });
  const original = JSON.parse(JSON.stringify(fund));
  assert.equal(normalizeExistingQuoteFreshness(fund.quote, { now: AFTER }).status, 'model', 'generic age alone cannot detect this expiry');
  const current = normalizeFundQuoteFreshness(fund, { now: AFTER });
  assert.equal(current.status, 'stale');
  assert.ok(current.reasonCodes.includes('MODEL_EVIDENCE_EXPIRED'));
  for (const key of ['fundCode', 'value', 'changePct', 'baseNav', 'sourceId', 'sourceTier', 'originalSource', 'fetchedAt', 'cachedAt', 'expiresAt']) {
    assert.equal(current[key], original.quote[key], key);
  }
  assert.deepEqual(fund, original, 'checking expiry must not mutate cached evidence or its clocks');
});

test('already selected legacy Quote with no new evidence keeps its cache identity and values', () => {
  const fund = modelFund();
  delete fund.market_model_evidence;
  const source = fund.quote;
  const current = normalizeFundQuoteFreshness(fund, { now: BEFORE });
  assert.deepEqual(current, source);
});

test('foreign model slot cannot relabel or erase an existing selected Quote', () => {
  const fund = modelFund();
  fund.market_model_evidence = { ...fund.market_model_evidence, fundCode: '000999' };
  const current = normalizeFundQuoteFreshness(fund, { now: BEFORE });
  assert.equal(current.status, 'stale');
  assert.equal(current.fundCode, '000002');
  assert.equal(current.value, 1.03);
  assert.equal(current.sourceId, 'market-model');
  assert.equal(modelNoteForQuote(fund, current), '');
});

for (const field of ['modelVersion', 'coverage', 'confidence']) test(`model note rejects mismatched ${field} instead of attaching another model explanation`, () => {
  const fund = modelFund();
  assert.equal(modelNoteForQuote(fund, fund.quote), '合成v1/100%说明');
  fund.market_model_evidence = { ...fund.market_model_evidence,
    [field]: field === 'modelVersion' ? 'v2' : field === 'coverage' ? 80 : 0.1 };
  assert.equal(modelNoteForQuote(fund, fund.quote), '');
  assert.equal(modelNoteForQuote(fund, fund.quote, 'label'), '');
});

test('model note follows the selected independent source rather than shared est_note', () => {
  const fund = modelFund();
  assert.equal(modelNoteForQuote(fund, fund.quote), '合成v1/100%说明');
  assert.equal(modelNoteForQuote(fund, fund.quote, 'label'), '合成独立模型');
  assert.equal(modelNoteForQuote(fund, fund.quote, 'fundCode'), '');
});

test('accuracy uses the selected source/version/confidence, including a genuine zero', () => {
  const fund = modelFund(), store = memory();
  fund.market_model_evidence = { ...fund.market_model_evidence, confidence: 0 };
  fund.quote = normalizeMarketModelQuote(fund, { now: BEFORE });
  updateFundAccuracy(fund, { now: BEFORE, storage: store.storage });
  assert.equal(store.rows().length, 1);
  const row = store.rows()[0];
  assert.equal(row.predicted_change, 3);
  assert.equal(row.model_version, 'v1');
  assert.equal(row.confidence, 0);
  assert.equal(row.model_label, '合成独立模型');
});

test('new evidence unknown metadata is not filled from obsolete shared fields', () => {
  const fund = modelFund(), store = memory();
  fund.market_model_evidence = { ...fund.market_model_evidence, modelVersion: null, confidence: null };
  fund.quote = normalizeMarketModelQuote(fund, { now: BEFORE });
  updateFundAccuracy(fund, { now: BEFORE, storage: store.storage });
  assert.equal(store.rows()[0].model_version, 'unknown');
  assert.equal(store.rows()[0].confidence, 'unknown');
});

test('accuracy does not record expired independent evidence', () => {
  const fund = modelFund(), store = memory();
  updateFundAccuracy(fund, { now: AFTER + 15 * 3600_000, storage: store.storage });
  assert.deepEqual(store.rows(), []);
});

for (const mode of ['foreign-fund', 'quarterly-source', 'foreign-cache-source']) test(`accuracy rejects ${mode} despite a legacy market flag`, () => {
  const fund = modelFund(), store = memory();
  delete fund.market_model_evidence;
  fund.quote = createQuoteEnvelope({ ...fund.quote,
    ...(mode === 'foreign-fund' ? { fundCode: '000999' }
      : mode === 'quarterly-source' ? { sourceId: 'quarterly-holdings-model' }
        : { sourceId: 'local-cache', sourceTier: 'cache', originalSource: 'quarterly-holdings-model',
          originalSourceTier: 'model', cacheState: 'fresh', cachedAt: BEFORE, expiresAt: AFTER + 3600_000 }) }, { now: BEFORE });
  updateFundAccuracy(fund, { now: BEFORE, storage: store.storage });
  assert.deepEqual(store.rows(), []);
});

for (const field of ['fundCode', 'baseNavDate', 'targetDate', 'observedAt', 'fetchedAt', 'reportDate']) test(`model evidence rejects nonprimitive ${field} without coercion`, () => {
  const fund = modelFund();
  let conversions = 0;
  const object = { toString() { conversions++; return field === 'fundCode' ? '000002' : '2026-09-30'; } };
  if (field === 'reportDate') {
    fund.est_holdings_model = true;
    fund.holdings_model_evidence = { ...fund.market_model_evidence, reportDate: object, quoteCount: 6, coverage: 60 };
    assert.equal(normalizeHoldingLookthroughQuote(fund, { now: BEFORE }).status, 'unavailable');
  } else {
    fund.market_model_evidence = { ...fund.market_model_evidence, [field]: object };
    assert.equal(normalizeMarketModelQuote(fund, { now: BEFORE }).status, 'unavailable');
  }
  assert.equal(conversions, 0);
});

test('legacy no-slot normalization does not read nonenumerable identity or model flags', () => {
  const row = { code: '000002', name: '合成基金', est_holdings_model: true,
    est_nav: 1.012, est_change: 1.2, est_time: '2026-09-30 23:59:00',
    est_holdings_base_nav: 1, est_holdings_base_date: '2026-09-29',
    est_holdings_target_date: '2026-09-30', est_holdings_coverage: 60 };
  for (const key of ['fundCode', 'est_model']) Object.defineProperty(row, key, {
    enumerable: false, get() { throw new Error('Hidden legacy field must not be read'); },
  });
  assert.equal(normalizeHoldingLookthroughQuote(row, { now: BEFORE }).status, 'model');
});
