import {
  compareQuotesByQuality,
  createQuoteEnvelope,
  parseQuoteTimestamp,
  quoteToLegacyFreshness,
  unavailableQuote,
} from './quote-contract.js';
import { classifyAssetKind, classifyMarketKind, marketSession, normalizeMarketKind } from './market-session.js';
import { canonicalSourceId, sourceTierFor } from './source-registry.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKEND_CARRYOVER_MS = 72 * 60 * 60 * 1000;
const WORKER_DIAGNOSTIC_KEYS = Object.freeze(['fallback_reason', 'primary_reason', 'model_reason', 'official_reason']);
const WORKER_DIAGNOSTIC_REASON_CODES = Object.freeze({
  upstream_empty: 'upstream_empty',
  no_data: 'no_data',
  no_quote: 'no_quote',
  unavailable: 'unavailable',
  source_unavailable: 'source_unavailable',
  timeout: 'timeout',
  network_error: 'network_error',
  http_4xx: 'http_4xx',
  http_5xx: 'http_5xx',
  invalid_response: 'invalid_response',
  invalid_payload: 'invalid_payload',
  stale: 'stale',
});
const WORKER_STATUS_REASON_CODES = Object.freeze({
  latest_official: 'latest_official',
  official: 'official',
  degraded: 'degraded',
  stale: 'stale',
  unavailable: 'unavailable',
  error: 'error',
  failed: 'failed',
});
const MAX_WORKER_DIAGNOSTIC_CODES = WORKER_DIAGNOSTIC_KEYS.length + 2;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function firstText(...values) {
  return values.map(text).find(Boolean) || '';
}

function finite(value, { positive = false } = {}) {
  if (value == null || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(String(value).replace('%', '').replace(/,/g, '').trim());
  return Number.isFinite(number) && (!positive || number > 0) ? number : null;
}

function workerDiagnosticCode(value, allowedCodes) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return Object.prototype.hasOwnProperty.call(allowedCodes, normalized)
    ? allowedCodes[normalized]
    : 'unclassified';
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
  if (['overseas_model', 'model_estimate', 'model'].includes(kind) || row?.est_model) return 'model_estimate';
  if (['holdings_model', 'holding_lookthrough_estimate'].includes(kind) || row?.est_holdings_model) return 'holding_lookthrough_estimate';
  return 'intraday_estimate';
}

function observedAtFromRow(row) {
  return firstText(row?.source_time, row?.est_time, row?.observedAt) || null;
}

function marketWeekday(timestamp, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(timestamp));
  } catch (_) {
    return null;
  }
}

function isWeekendCarryover(observedMs, nowMs, session) {
  if (!['closed', 'preopen', 'unknown'].includes(session.marketState)) return false;
  const sourceDay = marketWeekday(observedMs, session.timezone);
  const currentDay = marketWeekday(nowMs, session.timezone);
  return sourceDay === 'Fri'
    && ['Sat', 'Sun', 'Mon'].includes(currentDay)
    && nowMs - observedMs <= WEEKEND_CARRYOVER_MS;
}

function freshnessForRow(row, valueKind, observedAt, market, nowMs) {
  const hasValue = finite(row?.value_nav ?? row?.est_nav ?? row?.value, { positive: true }) != null;
  const hasChange = finite(row?.estimate_change ?? row?.est_change ?? row?.changePct) != null;
  if (!hasValue && !hasChange) return { status: 'unavailable', reasonCodes: [] };
  if (valueKind === 'official_nav') return { status: 'official', reasonCodes: [] };
  if (row?.stale || row?.est_model_stale || String(row?.status || '').toLowerCase() === 'stale') {
    return { status: 'stale', reasonCodes: ['source_marked_stale'] };
  }

  const observedMs = parseQuoteTimestamp(observedAt);
  const session = marketSession(market, new Date(nowMs));
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

function normalizeExistingQuoteFreshness(input, options = {}) {
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
  const sourceTier = valueKind.includes('model')
    ? 'model'
    : (row.is_fallback || valueKind === 'official_nav'
      ? 'secondary'
      : sourceTierFor(sourceId, 'primary'));
  const reasonCodes = diagnosticReasonCodes(row);
  const freshness = freshnessForRow(row, valueKind, observedAt, item.market, nowMs);
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
    value: finite(row.value_nav ?? row.est_nav ?? row.value, { positive: true }),
    changePct: finite(row.estimate_change ?? row.est_change ?? row.changePct),
    sourceId,
    sourceTier,
    observedAt,
    fetchedAt: firstText(options.fetchedAt, row.fetched_at, row.fetchedAt),
    officialNavDate: firstText(
      row.officialNavDate,
      valueKind === 'official_nav' ? row.value_date : '',
      valueKind === 'official_nav' ? row.est_time : '',
      row.nav_date,
    ) || null,
    status: freshness.status,
    coverage: row.coverage ?? row.model_coverage ?? row.est_coverage ?? row.est_model_weight,
    confidence: row.confidence ?? row.est_confidence,
    modelVersion: row.model_version ?? row.est_model_version,
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
    sourceId: canonicalSourceId(options.sourceId || 'eastmoney-official-nav'),
    sourceTier: 'secondary',
    observedAt: firstText(move.date) || null,
    fetchedAt: options.fetchedAt,
    officialNavDate: firstText(move.date) || null,
    status: 'official',
    reasonCodes: ['latest_published_nav'],
  }, { now: options.now });
}

export function normalizeMarketModelQuote(fund = {}, options = {}) {
  return normalizeEstimateQuote({
    ...fund,
    kind: 'model_estimate',
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
    source: 'quarterly-holdings-model',
    source_time: fund.est_time,
    coverage: fund.est_coverage,
    confidence: fund.est_confidence,
    stale: fund.est_holdings_stale,
  }, options);
}

function dedupeQuotes(quotes) {
  const seen = new Set();
  return quotes.filter(quote => {
    if (!quote) return false;
    const key = [quote.valueKind, quote.sourceId, quote.observedAt, quote.value, quote.changePct].join('|');
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
  else quotes.push(normalizeEstimateQuote(fund, context));
  if (fund.latest_nav_move) quotes.push(normalizeOfficialNavQuote(fund.latest_nav_move, context));
  if (fund.est_holdings_model) quotes.push(normalizeHoldingLookthroughQuote(fund, context));
  if (fund.est_model) quotes.push(normalizeMarketModelQuote(fund, context));
  return dedupeQuotes(quotes);
}

export function selectPreferredQuote(quotes = [], fallbackIdentity = {}, options = {}) {
  const candidates = quotes.filter(Boolean).sort(compareQuotesByQuality);
  return candidates[0] || unavailableQuote({ ...fallbackIdentity, reasonCodes: ['no_quote_candidate'] }, options);
}

export function normalizeCachedQuote(quote, { fresh = false, fetchedAt, now = Date.now(), fallbackIdentity = {} } = {}) {
  const source = quote
    ? normalizeExistingQuoteFreshness(quote, { now })
    : unavailableQuote({ ...fallbackIdentity, reasonCodes: ['legacy_cache_missing_quote'] }, { now });
  const effectiveFresh = fresh && source.status !== 'stale' && source.status !== 'unavailable';
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
    fetchedAt: source.fetchedAt || fetchedAt,
    status: cachedStatus,
    reasonCodes: [...source.reasonCodes, `cached_from_${source.sourceId}`, cacheReason],
  }, { now });
}

export function legacyFreshnessFromQuote(quote) {
  return quoteToLegacyFreshness(quote);
}
