import {
  compareQuotesByQuality,
  createQuoteEnvelope,
  normalizeQuoteDate,
  nullableNumber,
  parseQuoteTimestamp,
  quoteToLegacyFreshness,
  unavailableQuote,
} from './quote-contract.js';
import { classifyAssetKind, classifyMarketKind, normalizeMarketKind } from './market-session.js';
import { marketClock, zonedTimeParts } from './market-clock.js';
import { canonicalSourceId, sourceTierFor } from './source-registry.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKEND_CARRYOVER_MS = 72 * 60 * 60 * 1000;
const WORKER_DIAGNOSTIC_KEYS = Object.freeze(['fallback_reason', 'primary_reason', 'model_reason', 'official_reason']);
const WORKER_DIAGNOSTIC_REASON_CODES = Object.freeze([
  'upstream_empty', 'no_data', 'no_quote', 'unavailable', 'source_unavailable',
  'timeout', 'network_error', 'http_4xx', 'http_5xx', 'invalid_response', 'invalid_payload', 'stale',
]);
const WORKER_STATUS_REASON_CODES = Object.freeze([
  'latest_official', 'official', 'degraded', 'stale', 'unavailable', 'error', 'failed',
]);
const MAX_WORKER_DIAGNOSTIC_CODES = WORKER_DIAGNOSTIC_KEYS.length + 2;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function firstText(...values) {
  return values.map(text).find(Boolean) || '';
}

function finite(value, { positive = false } = {}) {
  return nullableNumber(value, { minimum: positive ? Number.MIN_VALUE : -Infinity });
}

function field(row, ...keys) {
  for (const key of keys) if (Object.hasOwn(row, key)) return row[key];
  return undefined;
}

function changeFromRow(row, kind) {
  return kind === 'official_nav' ? field(row, 'value_change', 'est_change', 'changePct')
    : field(row, 'estimate_change', 'value_change', 'est_change', 'changePct');
}

function workerDiagnosticCode(value, allowedCodes) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return allowedCodes.includes(normalized) ? normalized : 'unclassified';
}

function diagnosticReasonCodes(row) {
  const values = [];
  const diagnostics = row && typeof row.diagnostics === 'object' ? row.diagnostics : {};
  for (const key of WORKER_DIAGNOSTIC_KEYS) {
    const value = row?.[key] ?? diagnostics?.[key];
    const code = workerDiagnosticCode(value, WORKER_DIAGNOSTIC_REASON_CODES);
    if (code) values.push(`${key}_${code}`);
  }
  const status = typeof row?.status === 'string' ? row.status.trim().toLowerCase() : '';
  if (status && !['ok', 'success'].includes(status)) {
    values.push(`upstream_status_${workerDiagnosticCode(status, WORKER_STATUS_REASON_CODES)}`);
  }
  if (row?.is_fallback === true) values.push('upstream_fallback');
  return Array.from(new Set(values)).slice(0, MAX_WORKER_DIAGNOSTIC_CODES);
}

function kindFromRow(row) {
  const kind = firstText(row?.kind, row?.est_kind).toLowerCase();
  if (kind === 'official_nav') return 'official_nav';
  if (['qdii_next_nav_estimate', 'overseas_model', 'model_estimate', 'model'].includes(kind) || row?.est_model) return 'model_estimate';
  if (['holdings_model', 'holding_lookthrough_estimate'].includes(kind) || row?.est_holdings_model) return 'holding_lookthrough_estimate';
  return 'intraday_estimate';
}

function observedAtFromRow(row) {
  return firstText(row?.source_time, row?.est_time, row?.observedAt) || null;
}

function isWeekendCarryover(observedMs, nowMs, session) {
  if (!['closed', 'preopen', 'unknown'].includes(session.marketState)) return false;
  const sourceDay = zonedTimeParts(observedMs, session.timezone)?.weekday;
  const currentDay = zonedTimeParts(nowMs, session.timezone)?.weekday;
  return sourceDay === 5
    && [6, 0, 1].includes(currentDay)
    && nowMs - observedMs <= WEEKEND_CARRYOVER_MS;
}

function freshnessForRow(row, valueKind, observedAt, market, nowMs) {
  const hasValue = finite(field(row, 'value_nav', 'est_nav', 'value'), { positive: true }) != null;
  const hasChange = finite(changeFromRow(row, valueKind)) != null;
  if (!hasValue && !hasChange) return { status: 'unavailable', reasonCodes: [] };
  if (row?.stale || row?.est_model_stale || ['stale', 'expired'].includes(row.cacheState) || String(row?.source_status || row?.status || '').toLowerCase() === 'stale') {
    return { status: 'stale', reasonCodes: ['source_marked_stale'] };
  }
  if (valueKind === 'official_nav') return { status: 'official', reasonCodes: [] };

  const observedMs = parseQuoteTimestamp(observedAt);
  const session = marketClock(market, nowMs);
  const expected = session.expectedFreshnessMs || 10 * 60 * 1000;
  if (observedMs == null) {
    const raw = text(observedAt);
    return {
      status: 'stale',
      reasonCodes: [raw ? (/^\d{4}-\d{2}-\d{2}$/.test(raw) ? 'source_time_date_only' : 'source_time_unparseable') : 'source_time_missing'],
    };
  }

  const age = nowMs - observedMs;
  const staleAfter = Math.max(DAY_MS, session.expectedFreshnessMs || 0);
  if (age > staleAfter && !isWeekendCarryover(observedMs, nowMs, session)) {
    return { status: 'stale', reasonCodes: ['source_time_expired'] };
  }

  if (['model_estimate', 'holding_lookthrough_estimate'].includes(valueKind)) {
    return { status: 'model', reasonCodes: [] };
  }

  if (row?.est_realtime === true
    && session.marketState === 'open'
    && age >= 0 && age <= expected) {
    return { status: 'realtime', reasonCodes: [] };
  }

  const reasonCodes = [];
  if (session.marketState !== 'open') reasonCodes.push('market_not_open');
  if (age > expected) reasonCodes.push('source_time_delayed');
  if (row?.est_realtime !== true) reasonCodes.push('source_not_realtime');
  return { status: 'delayed', reasonCodes };
}

export function normalizeExistingQuoteFreshness(input, options = {}) {
  const nowNumber = options.now instanceof Date ? options.now.getTime() : Number(options.now);
  const nowMs = Number.isFinite(nowNumber) ? nowNumber : Date.now();
  const source = createQuoteEnvelope(input, { now: nowMs });
  if (source.status === 'unavailable' || source.valueKind === 'official_nav') return source;
  const freshness = freshnessForRow({
    value: source.value,
    changePct: source.changePct,
    est_realtime: source.status === 'realtime',
    stale: source.status === 'stale',
  }, source.valueKind, source.observedAt, source.market, nowMs);
  return createQuoteEnvelope({
    ...source,
    status: freshness.status,
    reasonCodes: [...source.reasonCodes, ...freshness.reasonCodes],
  }, { now: nowMs });
}

function identity(row, options = {}) {
  const fundCode = firstText(options.fundCode, row?.fundCode, row?.code, row?.bzdm);
  const fundName = firstText(options.fundName, row?.fundName, row?.name, row?.jjjc, fundCode);
  const market = normalizeMarketKind(options.market || row?.market || classifyMarketKind(fundName));
  return { fundCode, fundName, market, assetKind: options.assetKind || classifyAssetKind(fundName, market) };
}

export function normalizeEstimateQuote(row = {}, options = {}) {
  const nowNumber = options.now instanceof Date ? options.now.getTime() : Number(options.now);
  const nowMs = Number.isFinite(nowNumber) ? nowNumber : Date.now();
  const item = identity(row, options);
  const valueKind = kindFromRow(row);
  const observedAt = observedAtFromRow(row);
  const rawSource = firstText(row.source, row.sourceId, valueKind === 'official_nav' ? 'eastmoney-official-nav' : 'sinan-estimate-proxy');
  const sourceId = canonicalSourceId(rawSource);
  // A response explicitly marked as a fallback must remain a secondary quote
  // even when it travelled through the same proxy as the primary source.
  // Otherwise the registry's descriptor default would incorrectly make the
  // fallback appear more trustworthy than a later primary recovery.
  const sourceTier = row.sourceTier === 'cache' ? 'cache' : valueKind.includes('model')
    ? 'model'
    : (row.is_fallback || valueKind === 'official_nav'
      ? 'secondary'
      : sourceTierFor(sourceId, 'primary'));
  const reasonCodes = diagnosticReasonCodes(row);
  const freshness = freshnessForRow(row, valueKind, observedAt, item.market, nowMs);
  const baseNav = finite(field(row, 'base_nav', 'baseNav', 'last_nav'), { positive: true });
  const baseNavDate = normalizeQuoteDate(field(row, 'base_nav_date', 'baseNavDate', 'nav_date'));
  const isModel = ['model_estimate', 'holding_lookthrough_estimate'].includes(valueKind);
  const boundTarget = field(row, 'value_date', 'targetDate', 'target_nav_date');
  const targetDate = normalizeQuoteDate(boundTarget === undefined ? (isModel ? '' : text(observedAt).slice(0, 10)) : boundTarget);
  reasonCodes.push(...freshness.reasonCodes);
  if (observedAt && parseQuoteTimestamp(observedAt) == null && /^\d{4}-\d{2}-\d{2}$/.test(observedAt)) {
    reasonCodes.push('source_time_date_only');
  }
  if (valueKind === 'official_nav') reasonCodes.push('official_nav_fallback');
  if (valueKind === 'model_estimate') reasonCodes.push('model_estimate');
  if (valueKind === 'holding_lookthrough_estimate') reasonCodes.push('holdings_lookthrough');

  return createQuoteEnvelope({
    ...item,
    valueKind,
    value: finite(field(row, 'value_nav', 'est_nav', 'value'), { positive: true }),
    changePct: finite(changeFromRow(row, valueKind)),
    baseNav,
    baseNavDate,
    targetDate,
    sourceId,
    sourceTier,
    observedAt,
    fetchedAt: firstText(row.fetched_at, row.fetchedAt, options.fetchedAt),
    originalSource: row.originalSource, originalSourceTier: row.originalSourceTier,
    cacheState: row.cacheState, cachedAt: row.cachedAt, expiresAt: row.expiresAt,
    officialNavDate: firstText(
      row.officialNavDate,
      valueKind === 'official_nav' ? row.value_date : '',
      valueKind === 'official_nav' ? row.est_time : '',
      row.nav_date,
    ) || null,
    status: freshness.status,
    coverage: row.coverage ?? row.model_coverage ?? row.est_coverage ?? row.est_model_weight,
    confidence: row.confidence ?? row.est_confidence,
    modelVersion: row.model_version ?? row.estimate_model_version ?? row.est_model_version,
    reasonCodes,
  }, { now: nowMs });
}

export function normalizeOfficialNavQuote(move = {}, options = {}) {
  const item = identity(move, options);
  return createQuoteEnvelope({
    ...item,
    valueKind: 'official_nav',
    value: finite(move.nav, { positive: true }),
    changePct: finite(move.change),
    baseNav: finite(move.prevNav, { positive: true }),
    baseNavDate: move.prevDate,
    targetDate: move.date,
    sourceId: move.sourceTier === 'cache' ? 'local-cache' : canonicalSourceId(options.sourceId || 'eastmoney-official-nav'),
    sourceTier: move.sourceTier === 'cache' ? 'cache' : 'secondary',
    observedAt: firstText(move.date) || null,
    fetchedAt: move.fetchedAt || options.fetchedAt,
    originalSource: move.originalSource, originalSourceTier: move.originalSourceTier,
    cacheState: move.cacheState, cachedAt: move.cachedAt, expiresAt: move.expiresAt,
    officialNavDate: firstText(move.date) || null,
    status: ['stale', 'expired'].includes(move.cacheState) || move.status === 'stale' ? 'stale' : 'official',
    reasonCodes: ['latest_published_nav'],
  }, { now: options.now });
}

export function normalizeMarketModelQuote(fund = {}, options = {}) {
  return normalizeEstimateQuote({
    ...fund,
    kind: 'model_estimate',
    value_nav: fund.est_nav,
    value_change: fund.est_change,
    base_nav: fund.est_model_base_nav,
    base_nav_date: fund.est_model_base_date,
    last_nav: fund.est_model_base_nav,
    nav_date: fund.est_model_base_date,
    value_date: fund.est_model_target_date,
    source: 'market-model',
    source_time: fund.est_model_time || fund.est_time,
    coverage: fund.est_model_weight,
    confidence: fund.est_confidence,
    model_version: fund.est_model_version,
    stale: fund.est_model_stale,
  }, options);
}

export function normalizeHoldingLookthroughQuote(fund = {}, options = {}) {
  return normalizeEstimateQuote({
    ...fund,
    kind: 'holding_lookthrough_estimate',
    value_nav: fund.est_nav,
    value_change: fund.est_change,
    base_nav: fund.est_holdings_base_nav,
    base_nav_date: fund.est_holdings_base_date,
    last_nav: fund.est_holdings_base_nav,
    nav_date: fund.est_holdings_base_date,
    value_date: fund.est_holdings_target_date,
    source: 'quarterly-holdings-model',
    source_time: fund.est_time,
    coverage: fund.est_holdings_coverage ?? fund.est_coverage,
    confidence: fund.est_confidence,
    stale: fund.est_holdings_stale,
  }, options);
}

function dedupeQuotes(quotes) {
  const seen = new Set();
  return quotes.filter(quote => {
    if (!quote) return false;
    const key = [quote.valueKind, quote.sourceId, quote.observedAt, quote.value, quote.changePct, quote.baseNav, quote.baseNavDate, quote.targetDate,
      quote.status, quote.sourceTier, quote.cacheState, quote.expiresAt].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildFundQuoteCandidates(fund = {}, options = {}) {
  const item = identity(fund, options);
  const context = { ...options, ...item };
  const quotes = [];
  if (fund.source_quote) quotes.push(normalizeExistingQuoteFreshness(fund.source_quote, options));
  else if (!fund.est_model && !fund.est_holdings_model) quotes.push(normalizeEstimateQuote(fund, context));
  if (fund.latest_nav_move) quotes.push(normalizeOfficialNavQuote(fund.latest_nav_move, context));
  if (fund.est_holdings_model) quotes.push(normalizeHoldingLookthroughQuote(fund, context));
  if (fund.est_model) quotes.push(normalizeMarketModelQuote(fund, context));
  return dedupeQuotes(quotes);
}

export function selectPreferredQuote(quotes = [], fallbackIdentity = {}, options = {}) {
  const candidates = quotes.filter(Boolean).sort(compareQuotesByQuality);
  return candidates[0] || unavailableQuote({ ...fallbackIdentity, reasonCodes: ['no_quote_candidate'] }, options);
}

export function normalizeCachedQuote(quote, { fresh = false, fetchedAt, cachedAt, expiresAt, now = Date.now(), fallbackIdentity = {} } = {}) {
  const source = quote
    ? normalizeExistingQuoteFreshness(quote, { now })
    : unavailableQuote({ ...fallbackIdentity, reasonCodes: ['legacy_cache_missing_quote'] }, { now });
  const expiry = source.expiresAt ?? expiresAt;
  const effectiveFresh = fresh && (expiry == null || Number.isSafeInteger(expiry) && now < expiry)
    && source.status !== 'stale' && source.status !== 'unavailable';
  const cacheReason = effectiveFresh
    ? 'cache_fresh_ttl'
    : (fresh && source.status === 'stale' ? 'cache_source_stale' : 'cache_expired');
  const cachedStatus = source.status === 'unavailable'
    ? 'unavailable'
    : (!effectiveFresh
      ? 'stale'
      : ({ realtime: 'delayed', delayed: 'delayed', model: 'model', official: 'official' })[source.status] || 'stale');
  return createQuoteEnvelope({
    ...source,
    sourceId: 'local-cache',
    sourceTier: 'cache',
    originalSource: source.originalSource || source.sourceId,
    originalSourceTier: source.originalSourceTier || (source.sourceTier !== 'cache' ? source.sourceTier : null),
    cacheState: effectiveFresh ? 'fresh' : 'stale',
    cachedAt: source.cachedAt ?? cachedAt, expiresAt: source.expiresAt ?? expiresAt,
    fetchedAt: source.fetchedAt || fetchedAt,
    status: cachedStatus,
    reasonCodes: [...source.reasonCodes, `cached_from_${source.sourceId}`, cacheReason],
  }, { now });
}

export function legacyFreshnessFromQuote(quote) {
  return quoteToLegacyFreshness(quote);
}
