import { normalizeQuoteDate } from './quote-contract.js';
import { canonicalSourceId, getDataSourceDescriptor } from './source-registry.js';
import { chinaDateKey } from './market-clock.js';
import { policyEpoch as epoch, policyRecord as record } from './refresh-resource-policy.js';

const SOURCE_TIERS = new Set(['primary', 'secondary', 'model']);
const CACHE_STATES = new Set(['fresh', 'stale', 'expired']);

function originalSource(value) {
  if (typeof value !== 'string') return null;
  const id = canonicalSourceId(value);
  return id !== 'local-cache' && getDataSourceDescriptor(id) ? id : null;
}

function validEnvelope(value) {
  return record(value) && value.schemaVersion === 1 && record(value.payload)
    && originalSource(value.originalSource) != null && SOURCE_TIERS.has(value.originalSourceTier)
    && value.sourceTier === 'cache' && CACHE_STATES.has(value.cacheState)
    && normalizeQuoteDate(value.sourceDate) != null && epoch(value.fetchedAt) && epoch(value.cachedAt)
    && value.fetchedAt <= value.cachedAt && Number.isSafeInteger(value.ttlMs) && value.ttlMs > 0
    && epoch(value.expiresAt) && value.expiresAt === value.cachedAt + value.ttlMs
    && value.sourceDate <= chinaDateKey(value.fetchedAt);
}

/** Creating a cache records acquisition metadata once; reading never renews it. */
export function createCacheEnvelope(payload, options = {}) {
  if (!record(options)) return null;
  const envelope = {
    schemaVersion: 1, payload, originalSource: originalSource(options.originalSource),
    originalSourceTier: options.originalSourceTier, sourceTier: 'cache', sourceDate: options.sourceDate,
    fetchedAt: options.fetchedAt, cachedAt: options.cachedAt, ttlMs: options.ttlMs,
    expiresAt: options.cachedAt + options.ttlMs, cacheState: 'fresh',
  };
  return validEnvelope(envelope) ? Object.freeze(envelope) : null;
}

/** Invalid/corrupt/unknown envelopes are not usable fallback data. */
export function readCacheEnvelope(raw, { now = Date.now(), maxStaleMs = null, validatePayload = null } = {}) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const at = now instanceof Date ? now.getTime() : now;
    if (!validEnvelope(value) || !epoch(at) || value.cachedAt > at
      || (maxStaleMs != null && (!Number.isSafeInteger(maxStaleMs) || maxStaleMs < 0))
      || (validatePayload != null && (typeof validatePayload !== 'function' || validatePayload(value.payload) !== true))) return null;
    return Object.freeze({
      schemaVersion: 1, payload: value.payload, originalSource: originalSource(value.originalSource),
      originalSourceTier: value.originalSourceTier, sourceTier: 'cache', sourceDate: value.sourceDate,
      fetchedAt: value.fetchedAt, cachedAt: value.cachedAt, ttlMs: value.ttlMs, expiresAt: value.expiresAt,
      cacheState: at < value.expiresAt ? 'fresh'
        : maxStaleMs != null && at - value.expiresAt >= maxStaleMs ? 'expired' : 'stale',
    });
  } catch (_) { return null; }
}

/** Only the established official NAV legacy shape is admitted, without writes. */
export function adaptLegacyNavMoveCache(entry, { now = Date.now(), ttlMs, maxStaleMs = null } = {}) {
  if (!record(entry) || !record(entry.data) || originalSource(entry.source) !== 'eastmoney-official-nav') return null;
  const move = entry.data;
  const sourceDate = normalizeQuoteDate(move.date);
  const baseDate = normalizeQuoteDate(move.prevDate);
  if (!sourceDate || !baseDate || baseDate >= sourceDate
    || !Number.isFinite(move.nav) || move.nav <= 0 || !Number.isFinite(move.prevNav) || move.prevNav <= 0
    || (entry.expiresAt != null && entry.expiresAt !== entry.fetchedAt + ttlMs)) return null;
  const envelope = createCacheEnvelope(move, {
    originalSource: entry.source, originalSourceTier: 'secondary', sourceDate,
    fetchedAt: entry.fetchedAt, cachedAt: entry.fetchedAt, ttlMs,
  });
  return readCacheEnvelope(envelope, { now, maxStaleMs });
}
