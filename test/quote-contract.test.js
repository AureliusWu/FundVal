import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createQuoteEnvelope,
  compareQuotesByQuality,
  quoteStatusRank,
  quoteToLegacyFreshness,
} from '../js/runtime/quote-contract.js';
import {
  buildFundQuoteCandidates,
  normalizeCachedQuote,
  normalizeEstimateQuote,
  normalizeHoldingLookthroughQuote,
  normalizeMarketModelQuote,
  normalizeOfficialNavQuote,
  selectPreferredQuote,
} from '../js/runtime/quote-normalizer.js';
import { getDataSourceDescriptor, listDataSources } from '../js/runtime/source-registry.js';

const NOW = Date.parse('2026-08-25T02:05:00Z');

test('Quote Envelope keeps a real zero distinct from a missing value and never invents observedAt', () => {
  const quote = createQuoteEnvelope({
    fundCode: '000001', fundName: '测试基金', market: 'cn', assetKind: 'fund',
    valueKind: 'intraday_estimate', value: null, changePct: 0,
    sourceId: 'sinan-estimate-proxy', sourceTier: 'primary',
    observedAt: null, fetchedAt: '2026-08-25T02:05:00.000Z', status: 'delayed', reasonCodes: [],
  }, { now: NOW });

  assert.equal(quote.value, null);
  assert.equal(quote.changePct, 0);
  assert.equal(quote.observedAt, null);
  assert.equal(quote.ageMs, null);
  assert.equal(quote.fetchedAt, '2026-08-25T02:05:00.000Z');
  assert.equal(quote.status, 'delayed');
  assert.equal(Object.isFrozen(quote), true);
});

test('Quote Envelope rejects a future source time without confusing fetch time and source time', () => {
  const quote = createQuoteEnvelope({
    fundCode: '000001', market: 'cn', assetKind: 'fund', valueKind: 'intraday_estimate',
    value: 1, changePct: 0, sourceId: 'test', sourceTier: 'primary',
    observedAt: '2026-08-25 10:11:00', fetchedAt: '2026-08-25T02:05:00.000Z', status: 'realtime',
  }, { now: NOW });

  assert.equal(quote.status, 'stale');
  assert.equal(quote.ageMs, null);
  assert.ok(quote.reasonCodes.includes('SOURCE_TIME_IN_FUTURE'));
  assert.equal(quote.fetchedAt, '2026-08-25T02:05:00.000Z');
});

test('all current source kinds normalize to the same exact Quote Envelope shape', () => {
  const context = { fundCode: '000001', fundName: '示例基金', market: 'cn', fetchedAt: '2026-08-25T02:04:00Z', now: NOW };
  const quotes = [
    normalizeEstimateQuote({ est_nav: 1.01, est_change: 0, est_time: '2026-08-25 10:04', est_realtime: true, source: 'sinan-estimate-proxy' }, context),
    normalizeOfficialNavQuote({ nav: 1.01, change: 1, date: '2026-08-24' }, context),
    normalizeMarketModelQuote({ est_nav: 1.02, est_change: 2, est_model: true, est_model_time: '2026-08-25 10:04', est_model_weight: 82, est_confidence: 'medium' }, context),
    normalizeHoldingLookthroughQuote({ est_nav: 1.03, est_change: 3, est_holdings_model: true, est_time: '2026-08-25 10:04', est_coverage: 75 }, context),
  ];
  const keys = Object.keys(quotes[0]);
  quotes.forEach(quote => assert.deepEqual(Object.keys(quote), keys));
  assert.equal(quotes[0].changePct, 0);
  assert.equal(quotes[0].status, 'realtime');
  assert.equal(quotes[1].status, 'official');
  assert.equal(quotes[2].status, 'model');
  assert.equal(quotes[2].coverage, 82);
  assert.equal(quotes[2].confidence, 0.65);
  assert.equal(quotes[3].valueKind, 'holding_lookthrough_estimate');
});

test('selection follows realtime, delayed, model, official, stale, unavailable quality order', () => {
  const base = {
    fundCode: '000001', market: 'cn', assetKind: 'fund', valueKind: 'intraday_estimate',
    value: 1, changePct: 1, sourceId: 'test', sourceTier: 'primary', observedAt: '2026-08-25 10:00', fetchedAt: '2026-08-25T02:00:00Z',
  };
  const quotes = ['stale', 'official', 'model', 'unavailable', 'delayed', 'realtime']
    .map(status => createQuoteEnvelope({ ...base, status }, { now: NOW }));
  const sorted = [...quotes].sort(compareQuotesByQuality);
  assert.deepEqual(sorted.map(quote => quote.status), ['realtime', 'delayed', 'model', 'official', 'stale', 'unavailable']);
  assert.equal(selectPreferredQuote(quotes).status, 'realtime');
  assert.ok(quoteStatusRank('realtime') > quoteStatusRank('official'));
});

test('cache remains explicitly cache-tier and can never present itself as realtime', () => {
  const live = normalizeEstimateQuote({
    code: '000001', name: '示例基金', est_nav: 1, est_change: 0,
    est_time: '2026-08-25 10:04', est_realtime: true, source: 'sinan-estimate-proxy',
  }, { now: NOW, fetchedAt: '2026-08-25T02:04:00Z' });
  const cached = normalizeCachedQuote(live, { fresh: true, fetchedAt: '2026-08-25T02:04:00Z', now: NOW });
  assert.equal(cached.sourceId, 'local-cache');
  assert.equal(cached.sourceTier, 'cache');
  assert.equal(cached.status, 'delayed');
  assert.ok(cached.reasonCodes.includes('CACHED_FROM_SINAN_ESTIMATE_PROXY'));
  assert.equal(quoteToLegacyFreshness(cached).label, '延迟');
});

test('a stale source cannot be renewed by a fresh outer cache TTL or a later cache write time', () => {
  const staleSource = createQuoteEnvelope({
    fundCode: '000001', fundName: '示例基金', market: 'cn', assetKind: 'fund',
    valueKind: 'intraday_estimate', value: 1, changePct: -1,
    sourceId: 'sinan-estimate-proxy', sourceTier: 'primary',
    observedAt: '2026-08-24 10:04', fetchedAt: '2026-08-24T02:04:30Z',
    status: 'stale', reasonCodes: ['refresh_failed'],
  }, { now: NOW });
  const cached = normalizeCachedQuote(staleSource, {
    fresh: true,
    fetchedAt: '2026-08-25T02:04:30Z',
    now: NOW,
  });

  assert.equal(cached.status, 'stale');
  assert.equal(cached.fetchedAt, '2026-08-24T02:04:30.000Z');
  assert.ok(cached.reasonCodes.includes('CACHE_SOURCE_STALE'));
  assert.equal(quoteToLegacyFreshness(cached).label, '旧数据');
});

test('Worker fallback diagnostics survive normalization as bounded reason codes', () => {
  const quote = normalizeEstimateQuote({
    code: '005844', name: '东方人工智能主题混合A', kind: 'official_nav',
    value_nav: 3.4, estimate_change: -1.07, value_date: '2026-08-24', source_time: '2026-08-24',
    source: 'eastmoney_official_nav', status: 'latest_official', is_fallback: true,
    diagnostics: { primary_reason: 'upstream_empty', model_reason: 'http_5xx' },
  }, { fetchedAt: '2026-08-25T04:13:39Z', now: NOW });
  assert.equal(quote.valueKind, 'official_nav');
  assert.equal(quote.status, 'official');
  assert.ok(quote.reasonCodes.includes('PRIMARY_REASON_UPSTREAM_EMPTY'));
  assert.ok(quote.reasonCodes.includes('MODEL_REASON_HTTP_5XX'));
  assert.ok(quote.reasonCodes.includes('SOURCE_TIME_DATE_ONLY'));
});

test('Worker diagnostics map arbitrary upstream text to bounded codes without retaining its content', () => {
  const secretLikeValue = 'https://upstream.example/fail?token=should-not-survive';
  const quote = normalizeEstimateQuote({
    code: '005844', name: '东方人工智能主题混合A', kind: 'official_nav',
    value_nav: 3.4, source_time: '2026-08-24', source: 'eastmoney_official_nav',
    status: secretLikeValue, is_fallback: true,
    diagnostics: { primary_reason: secretLikeValue, model_reason: 'http_5xx', official_reason: '__proto__' },
  }, { fetchedAt: '2026-08-25T04:13:39Z', now: NOW });

  assert.ok(quote.reasonCodes.includes('PRIMARY_REASON_UNCLASSIFIED'));
  assert.ok(quote.reasonCodes.includes('MODEL_REASON_HTTP_5XX'));
  assert.ok(quote.reasonCodes.includes('OFFICIAL_REASON_UNCLASSIFIED'));
  assert.ok(quote.reasonCodes.includes('UPSTREAM_STATUS_UNCLASSIFIED'));
  assert.ok(quote.reasonCodes.length <= 9);
  assert.doesNotMatch(quote.reasonCodes.join('|'), /upstream\.example|token|should-not-survive/i);
});

test('an explicit proxy fallback never inherits the primary source tier', () => {
  const quote = normalizeEstimateQuote({
    code: '000001', name: '示例基金', est_nav: 1, est_change: -0.2,
    est_time: '2026-08-25 10:04', est_realtime: true,
    source: 'sinan-estimate-proxy', is_fallback: true,
  }, { fetchedAt: '2026-08-25T02:04:30Z', now: NOW });

  assert.equal(quote.sourceTier, 'secondary');
});

test('fund candidate builder keeps model and official candidates separately before selection', () => {
  const fund = {
    code: '012920', name: '全球成长 QDII', est_nav: 4.1, est_change: 1.5,
    est_model: true, est_model_time: '2026-08-25 10:00', est_model_weight: 80,
    latest_nav_move: { nav: 4, prevNav: 3.9, change: 2.56, date: '2026-08-22' },
  };
  const quotes = buildFundQuoteCandidates(fund, { fetchedAt: '2026-08-25T02:05:00Z', now: NOW });
  assert.ok(quotes.some(quote => quote.valueKind === 'model_estimate'));
  assert.ok(quotes.some(quote => quote.valueKind === 'official_nav'));
  assert.equal(selectPreferredQuote(quotes).valueKind, 'model_estimate');
});

test('a multi-day-old intraday estimate becomes stale and cannot outrank a newer official NAV', () => {
  const now = Date.parse('2026-07-28T13:47:00+08:00');
  const oldEstimate = normalizeEstimateQuote({
    code: '012920', name: '全球成长 QDII', est_nav: 3.9, est_change: -3.61,
    est_time: '2026-07-24 15:00:00', est_realtime: false,
  }, { market: 'qdii', fetchedAt: '2026-07-28T05:47:00Z', now });
  const official = normalizeOfficialNavQuote({
    nav: 4.04, prevNav: 4, change: 1, date: '2026-07-27',
  }, { fundCode: '012920', fundName: '全球成长 QDII', market: 'qdii', now });

  assert.equal(oldEstimate.status, 'stale');
  assert.ok(oldEstimate.reasonCodes.includes('SOURCE_TIME_EXPIRED'));
  assert.equal(selectPreferredQuote([oldEstimate, official]).valueKind, 'official_nav');
});

test('an estimate without a parseable source time is stale, not a high-ranked delayed quote', () => {
  const quote = normalizeEstimateQuote({
    code: '000001', name: '示例基金', est_nav: 1.1, est_change: 0,
    est_time: '', est_realtime: false,
  }, { market: 'cn', fetchedAt: '2026-08-25T02:05:00Z', now: NOW });

  assert.equal(quote.status, 'stale');
  assert.ok(quote.reasonCodes.includes('SOURCE_TIME_MISSING'));
});

test('Friday close can remain delayed during a weekend but becomes stale once Monday trading resumes', () => {
  const row = {
    code: '000001', name: '示例基金', est_nav: 1.1, est_change: 0.2,
    est_time: '2026-08-28 15:00:00', est_realtime: false,
  };
  const weekend = normalizeEstimateQuote(row, {
    market: 'cn', now: Date.parse('2026-08-29T12:00:00+08:00'),
  });
  const mondayOpen = normalizeEstimateQuote(row, {
    market: 'cn', now: Date.parse('2026-08-31T10:00:00+08:00'),
  });

  assert.equal(weekend.status, 'delayed');
  assert.equal(mondayOpen.status, 'stale');
});

test('source registry is declarative and preserves proxy/model/cache tiers', () => {
  assert.ok(listDataSources().length >= 6);
  assert.equal(getDataSourceDescriptor('sinan-estimate-proxy').requiresProxy, true);
  assert.equal(getDataSourceDescriptor('market-model').sourceTier, 'model');
  assert.equal(getDataSourceDescriptor('local-cache').freshnessPolicy, 'never-realtime');
});
