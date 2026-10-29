import { TTL } from '../config.js';
import { createCacheEnvelope, readCacheEnvelope, adaptLegacyNavMoveCache } from './cache-envelope.js';
import { normalizeQuoteDate, parseQuoteTimestamp, createQuoteEnvelope, quoteIsUsable,
  QUOTE_STATUSES, QUOTE_VALUE_KINDS, QUOTE_SOURCE_TIERS, MARKET_KINDS, ASSET_KINDS } from './quote-contract.js';
import { normalizeExistingQuoteFreshness } from './quote-normalizer.js';
import { chinaDateKey } from './market-clock.js';
import { validateHoldingSet, contractText } from './holding-set-contract.js';
import { canonicalSourceId, getDataSourceDescriptor } from './source-registry.js';
import { refreshResourcePolicy as resource, policyOwn as own, policyRecord as record, policyEpoch as epoch } from './refresh-resource-policy.js';

const META_FIELDS = ['scale', 'manager', 'managerWorkTime', 'managerId', 'sourceRate', 'currentRate'];
const ROW_FIELDS = ('code name type status source kind source_status last_nav est_nav est_change nav_date est_time '
  + 'source_time source_time_precision est_label est_kind est_realtime est_note is_fallback value_date base_nav_date '
  + 'base_nav value_nav value_change estimate_nav estimate_change coverage quote_count report_date model_version '
  + 'estimate_model_version target_nav_date est_model_version fallback_reason fetched_at').split(' ');
const QUOTE_FIELDS = ('fundCode fundName market assetKind valueKind value changePct baseNav baseNavDate targetDate sourceId sourceTier '
  + 'originalSource originalSourceTier cacheState cachedAt expiresAt observedAt fetchedAt officialNavDate status ageMs coverage confidence modelVersion reasonCodes').split(' ');
const ROW_KINDS = { intraday_estimate: 'intraday_estimate', estimate: 'intraday_estimate', official_nav: 'official_nav',
  qdii_next_nav_estimate: 'model_estimate', overseas_model: 'model_estimate', holdings_model: 'holding_lookthrough_estimate' };
const SKIP_DATA_FIELDS = new Set(['_cached', 'message', 'quoteCandidates']);
const PRICE_STATUSES = new Set(['current', 'stale', 'closed', 'delayed']);
const at = value => value instanceof Date ? value.getTime() : value;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const optionalNumber = value => value === null || typeof value === 'number' && Number.isFinite(value);
const safeString = value => typeof value === 'string' && (value === '' || contractText(value, 300) === value);
const select = (value, fields) => Object.fromEntries(fields.filter(key => own(value, key)).map(key => [key, value[key]]));

function metadata(value) {
  return record(value) && Object.keys(value).every(key => META_FIELDS.includes(key) && safeString(value[key]));
}

function priceQuote(value, code, now) {
  if (!record(value) || value.code !== code || !positive(value.price) || !optionalNumber(value.changePct)
    || !PRICE_STATUSES.has(value.status) || value.cached === true || value.sourceTier === 'cache') return null;
  const observed = parseQuoteTimestamp(value.observedAt);
  return observed != null && observed <= now ? observed : null;
}

function estimateRow(row, codes, now, strict) {
  const raw = row?.source_quote;
  if (!record(row) || row.status !== 'ok' || !codes.includes(row.code) || !record(raw) || raw.fundCode !== row.code
    || !QUOTE_STATUSES.includes(raw.status) || ['stale', 'unavailable'].includes(raw.status)
    || !QUOTE_VALUE_KINDS.includes(raw.valueKind) || !QUOTE_SOURCE_TIERS.includes(raw.sourceTier) || raw.sourceTier === 'cache'
    || !MARKET_KINDS.includes(raw.market) || !ASSET_KINDS.includes(raw.assetKind)
    || raw.cacheState != null || raw.cachedAt != null || raw.expiresAt != null || !positive(raw.value)
    || !optionalNumber(raw.changePct) || raw.originalSource != null || raw.originalSourceTier != null) return null;
  for (const [field, maximum] of [['coverage', 100], ['confidence', 1]]) {
    if (raw[field] != null && (!optionalNumber(raw[field]) || raw[field] < 0 || raw[field] > maximum)) return null;
  }
  const descriptor = getDataSourceDescriptor(raw.sourceId);
  const capability = raw.valueKind === 'model_estimate' ? 'model_estimate' : raw.valueKind;
  if (!descriptor || descriptor.id !== raw.sourceId || !descriptor.capabilities.includes(capability)) return null;
  const target = normalizeQuoteDate(raw.targetDate);
  const base = normalizeQuoteDate(raw.baseNavDate);
  const fetched = parseQuoteTimestamp(raw.fetchedAt);
  const observed = parseQuoteTimestamp(raw.observedAt);
  const observedDate = normalizeQuoteDate(raw.observedAt);
  const official = raw.valueKind === 'official_nav';
  if (!target || target > chinaDateKey(now) || fetched == null || fetched > now
    || (observed != null && observed > fetched) || (observed == null && !(official && observedDate && observedDate <= chinaDateKey(now)))
    || (raw.baseNavDate != null && !base) || (raw.baseNav != null && !positive(raw.baseNav))
    || (raw.baseNav == null) !== (base == null) || (base && base >= target)
    || (!official && (base == null || raw.changePct == null))
    || (official && (raw.status !== 'official' || raw.officialNavDate != null && raw.officialNavDate !== target))
    || (!official && raw.officialNavDate != null && !normalizeQuoteDate(raw.officialNavDate))) return null;
  if (raw.valueKind.includes('model') && (raw.status !== 'model' || raw.sourceTier !== 'model')
    || raw.valueKind === 'intraday_estimate' && !['realtime', 'delayed'].includes(raw.status)) return null;
  for (const [keys, expected] of [[['est_nav', 'value_nav', 'estimate_nav'], raw.value],
    [['last_nav', 'base_nav'], raw.baseNav], [['est_change', 'value_change', 'estimate_change'], raw.changePct]]) {
    for (const key of keys) {
      const value = row[key];
      if (value != null && (typeof value !== 'number' || !Number.isFinite(value) && !Number.isNaN(value)
        || Number.isFinite(value) && (expected == null || Math.abs(value - expected) > 1e-7))) return null;
    }
  }
  for (const [key, expected] of [['value_date', target], ['base_nav_date', base], ['nav_date', base]]) {
    if (row[key] != null && row[key] !== '' && row[key] !== expected) return null;
  }
  if ((row.source != null && canonicalSourceId(row.source) !== raw.sourceId)
    || ['kind', 'est_kind'].some(key => row[key] != null && ROW_KINDS[row[key]] !== raw.valueKind)
    || row.est_realtime === true && (raw.valueKind !== 'intraday_estimate' || raw.status !== 'realtime')) return null;
  const current = normalizeExistingQuoteFreshness(raw, { now });
  if (!quoteIsUsable(current) || ['stale', 'unavailable'].includes(current.status)) return null;
  if (strict && (Object.keys(row).some(key => key !== 'source_quote' && !ROW_FIELDS.includes(key))
    || Object.keys(raw).some(key => !QUOTE_FIELDS.includes(key)))) return null;
  const clean = select(row, ROW_FIELDS);
  for (const [key, value] of Object.entries(clean)) {
    if (value != null && typeof value !== 'boolean' && typeof value !== 'number' && !safeString(value)) return null;
    if (typeof value === 'number' && !Number.isFinite(value)) clean[key] = null;
  }
  clean.source_quote = createQuoteEnvelope(raw, { now });
  return clean;
}

function payloadFor(spec, payload, now, strict = false) {
  if (!record(payload) || payload.source !== spec.source || (spec.code && payload.code !== spec.code)
    || payload.cached === true || payload.sourceTier === 'cache' || payload.cacheState != null
    || (payload.sourceTier != null && payload.sourceTier !== spec.tier)) return null;
  const common = ['code', 'source', 'sourceTier', 'cached', 'status', 'fetchedAt', 'cachedAt'];
  const fields = { nav: ['nav', 'prevNav', 'date', 'prevDate', 'change', 'changeAmt', 'fundName', 'meta'],
    holdings: ['sourceStatus', 'wireVersion', 'reportDate', 'items'], meta: ['meta'],
    gold: ['name', 'price', 'changePct', 'observedAt'], indices: ['codes', 'quotes'], estimates: ['codes', 'rows'] }[spec.kind];
  const allowed = [...common, ...fields];
  if (strict && Object.keys(payload).some(key => !allowed.includes(key))) return null;
  if (own(payload, 'fetchedAt')) {
    const fetched = epoch(payload.fetchedAt) ? payload.fetchedAt : parseQuoteTimestamp(payload.fetchedAt);
    if (fetched == null || fetched > now) return null;
  }
  if (own(payload, 'cachedAt') && (!epoch(payload.cachedAt) || payload.cachedAt > now)) return null;
  const clean = select(payload, allowed);
  if (own(payload, 'status') && (spec.kind === 'meta' && !['current', 'ok'].includes(payload.status)
    || ['indices', 'estimates'].includes(spec.kind) && !['ok', 'partial', 'degraded'].includes(payload.status))) return null;
  let sourceDate;
  if (spec.kind === 'nav') {
    sourceDate = normalizeQuoteDate(payload.date);
    const base = normalizeQuoteDate(payload.prevDate);
    if (!sourceDate || !base || base >= sourceDate || !positive(payload.nav) || !positive(payload.prevNav)
      || !['current', 'ok', 'latest_official'].includes(payload.status)
      || (own(payload, 'fundName') && !safeString(payload.fundName))
      || (own(payload, 'meta') && !metadata(payload.meta))) return null;
    if (own(payload, 'change') && (!optionalNumber(payload.change) || payload.change != null && Math.abs(payload.change - (payload.nav / payload.prevNav - 1) * 100) > 1e-7)
      || own(payload, 'changeAmt') && (!optionalNumber(payload.changeAmt) || payload.changeAmt != null && Math.abs(payload.changeAmt - (payload.nav - payload.prevNav)) > 1e-7)) return null;
  } else if (spec.kind === 'holdings') {
    if (payload.status !== 'ok' || payload.sourceStatus !== 'ok' || ![1, 2].includes(payload.wireVersion)) return null;
    const checked = validateHoldingSet(payload.items, { reportDate: payload.reportDate, now, wireVersion: payload.wireVersion });
    if (!checked.valid || !checked.items.length) return null;
    clean.items = checked.items;
    sourceDate = checked.reportDate;
  } else if (spec.kind === 'meta') {
    if (!metadata(payload.meta)) return null;
  } else if (spec.kind === 'gold') {
    const observed = priceQuote(payload, spec.code, now);
    if (observed == null || own(payload, 'name') && !safeString(payload.name)) return null;
    sourceDate = chinaDateKey(observed);
  } else {
    if (!Array.isArray(payload.codes) || payload.codes.join(',') !== spec.codes.join(',')) return null;
    const rows = spec.kind === 'indices' ? payload.quotes : payload.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > spec.codes.length) return null;
    const seen = new Set();
    const output = [];
    for (const row of rows) {
      if (!record(row) || !spec.codes.includes(row.code) || seen.has(row.code)) return null;
      seen.add(row.code);
      if (spec.kind === 'indices') {
        const observed = priceQuote(row, row.code, now);
        if (observed == null || own(row, 'name') && !safeString(row.name)) return null;
        const quoteFields = ['code', 'name', 'price', 'changePct', 'observedAt', 'status', 'cached'];
        if (strict && Object.keys(row).some(key => !quoteFields.includes(key))) return null;
        output.push(select(row, quoteFields));
        const date = chinaDateKey(observed);
        if (!sourceDate || date > sourceDate) sourceDate = date;
      } else {
        const checked = estimateRow(row, spec.codes, now, strict);
        if (!checked) return null;
        output.push(checked);
        if (!sourceDate || checked.source_quote.targetDate > sourceDate) sourceDate = checked.source_quote.targetDate;
      }
    }
    if (spec.kind === 'indices' && seen.size !== spec.codes.length && payload.status !== 'partial') return null;
    clean[spec.kind === 'indices' ? 'quotes' : 'rows'] = output;
  }
  return { payload: clean, sourceDate };
}

/** Recheck the original envelope, canonical resource policy and payload at use time. */
export function validateRefreshResourceEntry(key, raw, { now = Date.now() } = {}) {
  try {
    const spec = resource(key);
    const current = at(now);
    const entry = readCacheEnvelope(raw, { now: current });
    if (!spec || !entry || entry.originalSource !== spec.source || entry.originalSourceTier !== spec.tier || entry.ttlMs !== spec.ttlMs) return null;
    const checked = payloadFor(spec, entry.payload, current, true);
    if (!checked || checked.sourceDate != null && checked.sourceDate !== entry.sourceDate) return null;
    return Object.freeze({ ...entry, payload: checked.payload });
  } catch (_) { return null; }
}

/** Called only at successful acquisition boundaries; cached fallbacks cannot enter here. */
export function makeRefreshResourceEntry(key, payload, { now = Date.now(), fetchedAt = now, sourceDate } = {}) {
  try {
    const spec = resource(key);
    const current = at(now);
    if (!spec || !epoch(current) || !epoch(at(fetchedAt)) || at(fetchedAt) > current) return null;
    const checked = payloadFor(spec, payload, current);
    if (!checked || !normalizeQuoteDate(sourceDate) || checked.sourceDate != null && checked.sourceDate !== sourceDate) return null;
    return createCacheEnvelope(checked.payload, { originalSource: spec.source, originalSourceTier: spec.tier,
      sourceDate, fetchedAt: at(fetchedAt), cachedAt: current, ttlMs: spec.ttlMs });
  } catch (_) { return null; }
}

function aggregate(raw) {
  try { const value = typeof raw === 'string' ? JSON.parse(raw) : raw; return record(value) ? value : {}; }
  catch (_) { return {}; }
}
const codesFor = values => new Set((Array.isArray(values) ? values : []).filter(code => typeof code === 'string' && /^\d{6}$/.test(code)));
function active(spec, codes) {
  return spec && (spec.kind === 'gold' || spec.kind === 'indices' || (spec.codes ? spec.codes.every(code => codes.has(code)) : codes.has(spec.code)));
}

/** No storage writes: legacy NAV records are adapted with their original clock. */
export function readRefreshResources(raw, { now = Date.now(), activeCodes = [], legacyNavMoves = {} } = {}) {
  const entries = {};
  const cacheIndex = {};
  const current = at(now);
  const codes = codesFor(activeCodes);
  if (!epoch(current)) return { entries, cacheIndex };
  const previous = aggregate(raw);
  for (const [key, value] of Object.entries(record(previous.refreshResources) ? previous.refreshResources : {})) {
    if (active(resource(key), codes)) {
      const entry = validateRefreshResourceEntry(key, value, { now: current });
      if (entry) entries[key] = entry;
    }
  }
  for (const code of codes) {
    const key = `nav:${code}`;
    if (entries[key] || !record(legacyNavMoves)) continue;
    const rawLegacy = legacyNavMoves[code] ?? legacyNavMoves[`fuyu_nav_move_${code}`];
    const old = readCacheEnvelope(rawLegacy, { now: current })
      || adaptLegacyNavMoveCache(rawLegacy, { now: current, ttlMs: TTL.OFFICIAL_NAV });
    if (!old || old.originalSource !== 'eastmoney-official-nav' || old.ttlMs !== TTL.OFFICIAL_NAV) continue;
    const entry = validateRefreshResourceEntry(key, { ...old,
      payload: { ...old.payload, code, source: 'eastmoney-official-nav', status: 'current' } }, { now: current });
    if (entry) entries[key] = entry;
  }
  for (const [key, entry] of Object.entries(entries)) cacheIndex[key] = {
    validated: true, fetchedAt: entry.fetchedAt, cachedAt: entry.cachedAt, expiresAt: entry.expiresAt,
    sourceTier: 'cache', status: resource(key).kind === 'nav' || resource(key).kind === 'meta' ? 'current' : 'ok', cacheState: entry.cacheState,
  };
  return { entries, cacheIndex };
}

/** Serialize one generation without renewing unchanged resource or fund Quote metadata. */
export function serializeRefreshAggregate({ previous, staged = {}, data = [], holdingsHash, now = Date.now(), activeCodes = [] } = {}) {
  const current = at(now);
  if (!epoch(current)) throw new TypeError('Refresh aggregate requires a valid clock.');
  const old = aggregate(previous);
  const codes = codesFor(activeCodes);
  const resources = {};
  for (const [key, entry] of Object.entries(record(old.refreshResources) ? old.refreshResources : {})) {
    if (active(resource(key), codes) && validateRefreshResourceEntry(key, entry, { now: current })) resources[key] = entry;
  }
  let fundAcquired = false;
  const candidates = staged instanceof Map ? Object.fromEntries(staged) : staged;
  for (const [key, raw] of Object.entries(record(candidates) ? candidates : {})) {
    const spec = resource(key);
    const entry = active(spec, codes) ? validateRefreshResourceEntry(key, raw, { now: current }) : null;
    const former = resources[key];
    if (!entry || entry.cacheState !== 'fresh' || (former && (entry.fetchedAt <= former.fetchedAt || entry.cachedAt <= former.cachedAt))
      || (!former && epoch(old.fetchedAt) && entry.cachedAt <= old.fetchedAt)) continue;
    resources[key] = entry;
    // Market bars and metadata do not acquire a new fund projection.
    if (spec.kind === 'nav' || spec.kind === 'holdings' || spec.kind === 'estimates') fundAcquired = true;
  }
  const seen = new Set();
  const rows = [];
  for (const row of Array.isArray(data) ? data : []) {
    if (!record(row) || !codes.has(row.code)) continue;
    if (seen.has(row.code)) throw new TypeError('Duplicate fund data cannot be persisted.');
    seen.add(row.code);
    rows.push(Object.fromEntries(Object.entries(row).filter(([key]) => !SKIP_DATA_FIELDS.has(key))));
  }
  const output = { data: rows, refreshResources: resources };
  for (const key of ['fetchedAt', 'expiresAt', 'source', 'time', 'holdingsHash']) if (own(old, key)) output[key] = old[key];
  if (holdingsHash !== undefined) output.holdingsHash = holdingsHash;
  if (fundAcquired) {
    output.fetchedAt = current;
    output.expiresAt = current + TTL.INTRADAY;
    output.source = 'fund-estimate';
    if (own(old, 'time')) output.time = current;
  }
  return JSON.stringify(output);
}
