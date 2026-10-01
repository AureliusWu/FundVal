import { chinaDateKey } from './market-clock.js';
import { canonicalSourceId, getDataSourceDescriptor } from './source-registry.js';

export const QUOTE_VALUE_KINDS = Object.freeze([
  'intraday_estimate',
  'official_nav',
  'model_estimate',
  'holding_lookthrough_estimate',
]);

export const QUOTE_STATUSES = Object.freeze([
  'realtime',
  'delayed',
  'stale',
  'model',
  'official',
  'unavailable',
]);

export const QUOTE_SOURCE_TIERS = Object.freeze(['primary', 'secondary', 'model', 'cache']);
export const MARKET_KINDS = Object.freeze(['cn', 'hk', 'us', 'jp', 'kr', 'gold', 'qdii', 'unknown']);
export const ASSET_KINDS = Object.freeze(['fund', 'index_fund', 'qdii_fund', 'commodity_fund', 'unknown']);
export const MAX_QUOTE_FUTURE_SKEW_MS = 5 * 60 * 1000;

const VALUE_KIND_SET = new Set(QUOTE_VALUE_KINDS);
const STATUS_SET = new Set(QUOTE_STATUSES);
const SOURCE_TIER_SET = new Set(QUOTE_SOURCE_TIERS);
const MARKET_KIND_SET = new Set(MARKET_KINDS);
const ASSET_KIND_SET = new Set(ASSET_KINDS);

const STATUS_RANK = Object.freeze({
  realtime: 5,
  delayed: 4,
  model: 3,
  official: 2,
  stale: 1,
  unavailable: 0,
});

const SOURCE_TIER_RANK = Object.freeze({ primary: 4, secondary: 3, model: 2, cache: 1 });

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

export function nullableNumber(value, { minimum = -Infinity, maximum = Infinity } = {}) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  let raw = typeof value === 'string' ? value.trim() : String(value);
  if (raw.endsWith('%')) raw = raw.slice(0, -1).trim();
  if (!/^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return null;
  const number = Number(raw.replace(/,/g, ''));
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

export function normalizeConfidence(value) {
  if (typeof value === 'string') {
    const mapped = { low: 0.35, medium: 0.65, high: 0.85 }[value.trim().toLowerCase()];
    if (mapped != null) return mapped;
  }
  const number = nullableNumber(value, { minimum: 0, maximum: 100 });
  if (number == null) return null;
  return number > 1 ? number / 100 : number;
}

export function normalizeReasonCode(value) {
  const raw = text(value);
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/.test(raw)) return raw.slice(0, 80);
  const code = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return code || null;
}

export function normalizeReasonCodes(values) {
  const unique = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const code = normalizeReasonCode(value);
    if (code) unique.add(code);
  }
  return Array.from(unique).slice(0, 20);
}

export function parseQuoteTimestamp(value) {
  const source = text(value);
  if (!source || /^\d{4}-\d{2}-\d{2}$/.test(source)) return null;
  const china = source.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const zoned = source.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/);
  const parts = china || zoned;
  if (!parts || !normalizeQuoteDate(`${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`)
    || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] || 0) > 59) return null;
  const timestamp = china
    ? Date.parse(`${china[1]}-${String(china[2]).padStart(2, '0')}-${String(china[3]).padStart(2, '0')}T${String(china[4]).padStart(2, '0')}:${china[5]}:${String(china[6] || '0').padStart(2, '0')}+08:00`)
    : Date.parse(source);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function normalizeQuoteDate(value) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? date : null;
}

// Conservative period guard, not an exchange holiday calendar. A holiday gap
// needs cumulative returns and is deliberately not treated as a one-day move.
export function nextWeekdayDate(value) {
  const date = normalizeQuoteDate(value);
  if (!date) return null;
  const next = new Date(`${date}T00:00:00Z`);
  do { next.setUTCDate(next.getUTCDate() + 1); } while ([0, 6].includes(next.getUTCDay()));
  return next.toISOString().slice(0, 10);
}

function validFetchedAt(value, nowMs, cached = false) {
  const candidate = text(value);
  const timestamp = candidate ? parseQuoteTimestamp(candidate) : null;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : cached ? null : new Date(nowMs).toISOString();
}

function normalizeEnum(value, allowed, fallback) {
  const candidate = text(value).toLowerCase();
  return allowed.has(candidate) ? candidate : fallback;
}

export function createQuoteEnvelope(input = {}, { now = Date.now() } = {}) {
  const nowNumber = now instanceof Date ? now.getTime() : Number(now);
  const nowMs = Number.isFinite(nowNumber) ? nowNumber : Date.now();
  const observedAt = text(input.observedAt) || null;
  const observedMs = parseQuoteTimestamp(observedAt);
  const value = nullableNumber(input.value, { minimum: Number.MIN_VALUE });
  const changePct = nullableNumber(input.changePct);
  const valueKind = normalizeEnum(input.valueKind, VALUE_KIND_SET, 'intraday_estimate');
  const baseNav = nullableNumber(input.baseNav, { minimum: Number.MIN_VALUE });
  const baseNavDate = normalizeQuoteDate(input.baseNavDate);
  const targetDate = normalizeQuoteDate(input.targetDate);
  const officialNavDate = normalizeQuoteDate(input.officialNavDate);
  const reasonCodes = normalizeReasonCodes(input.reasonCodes);
  let status = normalizeEnum(input.status, STATUS_SET, 'unavailable');
  const sourceTier = normalizeEnum(input.sourceTier, SOURCE_TIER_SET, 'secondary');
  const cached = sourceTier === 'cache';
  const originalSource = canonicalSourceId(input.originalSource || (cached && input.sourceId !== 'local-cache' ? input.sourceId : null));
  const originalSourceTier = ['primary', 'secondary', 'model'].includes(input.originalSourceTier) ? input.originalSourceTier : null;
  let cacheState = ['fresh', 'stale', 'expired'].includes(input.cacheState) ? input.cacheState : null;
  const cachedAt = Number.isSafeInteger(input.cachedAt) && input.cachedAt >= 0 ? input.cachedAt : null;
  const expiresAt = Number.isSafeInteger(input.expiresAt) && input.expiresAt >= 0 ? input.expiresAt : null;
  const fetchedMs = parseQuoteTimestamp(input.fetchedAt);
  if (cached && cacheState === 'fresh' && (cachedAt == null || expiresAt == null || fetchedMs == null)) {
    cacheState = null;
    reasonCodes.push('CACHE_METADATA_MISSING');
  }
  if (cached && cacheState === 'fresh' && expiresAt != null && nowMs >= expiresAt) cacheState = 'stale';
  if (cached && cacheState === 'fresh' && (originalSource === 'local-cache' || !getDataSourceDescriptor(originalSource) || !originalSourceTier)) {
    cacheState = null;
    reasonCodes.push('CACHE_PROVENANCE_INVALID');
  }
  if (cached && ((input.cachedAt != null && cachedAt == null) || (input.expiresAt != null && expiresAt == null)
    || cachedAt > nowMs || (fetchedMs != null && cachedAt != null && fetchedMs > cachedAt)
    || (cachedAt != null && expiresAt != null && expiresAt <= cachedAt))) {
    cacheState = null;
    reasonCodes.push('CACHE_METADATA_INVALID');
  }
  let ageMs = observedMs == null ? null : Math.max(0, nowMs - observedMs);

  const invalidEnum = (input.valueKind != null && !VALUE_KIND_SET.has(text(input.valueKind).toLowerCase()))
    || (input.sourceTier != null && !SOURCE_TIER_SET.has(text(input.sourceTier).toLowerCase()))
    || (input.status != null && !STATUS_SET.has(text(input.status).toLowerCase()));
  if (invalidEnum) {
    status = 'unavailable';
    reasonCodes.push('QUOTE_ENUM_INVALID');
  }

  if (status === 'unavailable' || (value == null && changePct == null)) {
    status = 'unavailable';
    if (value == null && changePct == null) reasonCodes.push('MISSING_QUOTE_VALUE');
  } else if (observedMs != null && observedMs > nowMs + MAX_QUOTE_FUTURE_SKEW_MS) {
    status = 'stale';
    ageMs = null;
    reasonCodes.push(...normalizeReasonCodes('SOURCE_TIME_IN_FUTURE'));
  } else if ([officialNavDate, targetDate, baseNavDate].some(date => date && date > chinaDateKey(nowMs))) {
    status = 'stale';
    reasonCodes.push('SOURCE_DATE_IN_FUTURE');
  } else if (['model_estimate', 'holding_lookthrough_estimate'].includes(valueKind)
    && (baseNav == null || !baseNavDate || !targetDate || baseNavDate >= targetDate)) {
    status = 'stale';
    reasonCodes.push('MODEL_PERIOD_UNBOUND');
  }
  if (cached && status !== 'unavailable') {
    if (!cacheState || cacheState !== 'fresh' || status === 'stale') {
      status = 'stale';
      reasonCodes.push(cacheState ? 'CACHE_EXPIRED' : 'CACHE_METADATA_MISSING');
    } else if (status === 'realtime') status = 'delayed';
  }

  return Object.freeze({
    fundCode: text(input.fundCode),
    fundName: text(input.fundName) || undefined,
    market: normalizeEnum(input.market, MARKET_KIND_SET, 'unknown'),
    assetKind: normalizeEnum(input.assetKind, ASSET_KIND_SET, 'unknown'),
    valueKind,
    value: status === 'unavailable' ? null : value,
    changePct: status === 'unavailable' ? null : changePct,
    baseNav: status === 'unavailable' ? null : baseNav,
    baseNavDate,
    targetDate,
    sourceId: cached ? 'local-cache' : text(input.sourceId) || 'unknown',
    sourceTier,
    originalSource: originalSource === 'unknown' ? null : originalSource,
    originalSourceTier,
    cacheState: cached ? cacheState : null,
    cachedAt,
    expiresAt,
    observedAt,
    fetchedAt: validFetchedAt(input.fetchedAt, nowMs, cached),
    officialNavDate,
    status,
    ageMs,
    coverage: nullableNumber(input.coverage, { minimum: 0, maximum: 100 }),
    confidence: normalizeConfidence(input.confidence),
    modelVersion: text(input.modelVersion) || null,
    reasonCodes: Object.freeze(normalizeReasonCodes(reasonCodes)),
  });
}

export function unavailableQuote({ fundCode = '', fundName = '', market = 'unknown', assetKind = 'fund', reasonCodes = [] } = {}, options) {
  return createQuoteEnvelope({
    fundCode,
    fundName,
    market,
    assetKind,
    valueKind: 'intraday_estimate',
    value: null,
    changePct: null,
    sourceId: 'unavailable',
    sourceTier: 'secondary',
    observedAt: null,
    status: 'unavailable',
    reasonCodes,
  }, options);
}

export function quoteStatusRank(quoteOrStatus) {
  const status = typeof quoteOrStatus === 'string' ? quoteOrStatus : quoteOrStatus && quoteOrStatus.status;
  return STATUS_RANK[status] ?? 0;
}

export function quoteIsUsable(quote) {
  return Boolean(quote && STATUS_SET.has(quote.status) && quote.status !== 'unavailable' && (quote.value != null || quote.changePct != null));
}

export function compareQuotesByQuality(left, right) {
  if (left?.valueKind === 'official_nav' && right?.valueKind === 'official_nav'
    && left.status === 'official' && right.status === 'official') {
    const dateDifference = String(right.officialNavDate || '').localeCompare(String(left.officialNavDate || ''));
    if (dateDifference) return dateDifference;
  }
  const statusDifference = quoteStatusRank(right) - quoteStatusRank(left);
  if (statusDifference) return statusDifference;
  const tierDifference = (SOURCE_TIER_RANK[right?.sourceTier] || 0) - (SOURCE_TIER_RANK[left?.sourceTier] || 0);
  if (tierDifference) return tierDifference;
  const leftTime = parseQuoteTimestamp(left?.observedAt) || 0;
  const rightTime = parseQuoteTimestamp(right?.observedAt) || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  if (left?.value === right?.value && left?.targetDate === right?.targetDate) {
    const completeness = quote => [quote?.changePct, quote?.baseNav, quote?.baseNavDate].filter(value => value != null).length;
    const difference = completeness(right) - completeness(left);
    if (difference) return difference;
  }
  return String(left?.sourceId || '').localeCompare(String(right?.sourceId || ''));
}

export function quoteStatusLabel(quoteOrStatus) {
  const status = typeof quoteOrStatus === 'string' ? quoteOrStatus : quoteOrStatus && quoteOrStatus.status;
  return ({
    realtime: '实时',
    delayed: '延迟',
    model: '模型估算',
    official: '最新正式净值',
    stale: '旧数据',
    unavailable: '暂不可估值',
  })[status] || '暂不可估值';
}

export function quoteValueKindLabel(quoteOrKind) {
  const kind = typeof quoteOrKind === 'string' ? quoteOrKind : quoteOrKind && quoteOrKind.valueKind;
  return ({
    intraday_estimate: '盘中估值',
    official_nav: '最新净值涨跌',
    model_estimate: '海外模型估算',
    holding_lookthrough_estimate: '十大重仓估算',
  })[kind] || '估值';
}

export function quoteToLegacyFreshness(quote) {
  const status = quote?.status || 'unavailable';
  return {
    sourceTime: quote?.observedAt || quote?.officialNavDate || null,
    fetchedAt: quote?.fetchedAt || null,
    calculatedAt: ['model_estimate', 'holding_lookthrough_estimate'].includes(quote?.valueKind) ? quote?.fetchedAt || null : null,
    ageSeconds: Number.isFinite(quote?.ageMs) ? Math.floor(quote.ageMs / 1000) : null,
    status: status === 'realtime' ? 'fresh' : (['model', 'official'].includes(status) ? 'degraded' : status),
    source: quote?.sourceId || 'unavailable',
    isFallback: quote?.sourceTier !== 'primary',
    fallbackReason: quote?.reasonCodes?.join(',') || null,
    label: quoteStatusLabel(status),
    market: quote?.market || 'unknown',
    sourceTimeInFuture: Boolean(quote?.reasonCodes?.includes('SOURCE_TIME_IN_FUTURE')),
  };
}
