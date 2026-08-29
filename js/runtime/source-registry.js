const DESCRIPTORS = [
  {
    id: 'sinan-estimate-proxy', markets: ['cn', 'hk', 'us', 'jp', 'kr', 'gold', 'qdii'],
    capabilities: ['intraday_estimate', 'official_nav', 'holding_lookthrough_estimate'], priority: 100,
    timeoutMs: 10000, freshnessPolicy: 'source-observed-time', requiresProxy: true, sourceTier: 'primary',
  },
  {
    id: 'eastmoney-official-nav', markets: ['cn', 'hk', 'us', 'jp', 'kr', 'gold', 'qdii'],
    capabilities: ['official_nav'], priority: 80, timeoutMs: 7000,
    freshnessPolicy: 'official-nav-date', requiresProxy: false, sourceTier: 'secondary',
  },
  {
    id: 'eastmoney-security-quote', markets: ['cn', 'gold'], capabilities: ['security_quote'], priority: 60,
    timeoutMs: 7000, freshnessPolicy: 'exact-source-time-required', requiresProxy: false, sourceTier: 'secondary',
  },
  {
    id: 'tencent-market-quote', markets: ['cn', 'hk', 'us', 'jp', 'kr'], capabilities: ['security_quote', 'index_quote'], priority: 60,
    timeoutMs: 8000, freshnessPolicy: 'exact-source-time-required', requiresProxy: false, sourceTier: 'secondary',
  },
  {
    id: 'market-model', markets: ['us', 'jp', 'kr', 'qdii'], capabilities: ['model_estimate'], priority: 40,
    timeoutMs: 8000, freshnessPolicy: 'model-underlying-time', requiresProxy: false, sourceTier: 'model',
  },
  {
    id: 'quarterly-holdings-model', markets: ['cn'], capabilities: ['holding_lookthrough_estimate'], priority: 40,
    timeoutMs: 10000, freshnessPolicy: 'same-day-lookthrough', requiresProxy: true, sourceTier: 'model',
  },
  {
    id: 'local-cache', markets: ['cn', 'hk', 'us', 'jp', 'kr', 'gold', 'qdii', 'unknown'], capabilities: ['cached_quote'], priority: 10,
    timeoutMs: 0, freshnessPolicy: 'never-realtime', requiresProxy: false, sourceTier: 'cache',
  },
].map(descriptor => Object.freeze({
  ...descriptor,
  markets: Object.freeze([...descriptor.markets]),
  capabilities: Object.freeze([...descriptor.capabilities]),
}));

const BY_ID = new Map(DESCRIPTORS.map(descriptor => [descriptor.id, descriptor]));

const ALIASES = Object.freeze({
  tiantian: 'sinan-estimate-proxy',
  'eastmoney-table': 'sinan-estimate-proxy',
  eastmoney_official_nav: 'eastmoney-official-nav',
  'official-nav': 'eastmoney-official-nav',
  eastmoney: 'eastmoney-security-quote',
  'market-model': 'market-model',
  'quarterly-holdings-model': 'quarterly-holdings-model',
  'local-cache': 'local-cache',
});

export const DATA_SOURCE_REGISTRY = Object.freeze(DESCRIPTORS);

export function canonicalSourceId(value) {
  const source = String(value || '').trim();
  return ALIASES[source] || source || 'unknown';
}

export function getDataSourceDescriptor(value) {
  return BY_ID.get(canonicalSourceId(value)) || null;
}

export function sourceTierFor(value, fallback = 'secondary') {
  return getDataSourceDescriptor(value)?.sourceTier || fallback;
}

export function listDataSources() {
  return [...DATA_SOURCE_REGISTRY];
}

// The declarations above describe the current product sources.  The helpers
// below are deliberately generic so the refresh coordinator can own an
// immutable, testable health snapshot instead of mutating those declarations.
export const SOURCE_HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  COOLDOWN: 'cooldown',
  UNAVAILABLE: 'unavailable',
});

export const DEFAULT_SOURCE_HEALTH_POLICY = Object.freeze({
  failureThreshold: 3,
  cooldownMs: 60_000,
});

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value, field) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new TypeError(`Source descriptor ${field} must be a non-empty string.`);
  return text;
}

function immutableTextList(value, field, { required = false } = {}) {
  if (!Array.isArray(value)) throw new TypeError(`Source descriptor ${field} must be an array.`);
  const list = [...new Set(value.map(item => nonEmptyText(item, field)))];
  if (required && !list.length) throw new TypeError(`Source descriptor ${field} must not be empty.`);
  return Object.freeze(list);
}

function finiteNumber(value, field, { minimum = -Infinity, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || (integer && !Number.isInteger(number))) {
    throw new TypeError(`Source ${field} must be a${integer ? 'n integer' : ''} finite number${minimum > -Infinity ? ` no smaller than ${minimum}` : ''}.`);
  }
  return number;
}

function clockAt(value) {
  return finiteNumber(value, 'clock', { minimum: 0 });
}

function optionalTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (!Number.isFinite(Date.parse(text))) throw new TypeError('Source availableAt must be a valid timestamp.');
    return text;
  }
  return finiteNumber(value, 'availableAt', { minimum: 0 });
}

function optionalResponseMs(value) {
  if (value == null || value === '') return null;
  return finiteNumber(value, 'responseMs', { minimum: 0 });
}

function optionalReason(value) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, 160) : null;
}

function preferredAvailableAt(previous, next) {
  if (next == null) return previous;
  if (previous == null) return next;
  const previousMs = typeof previous === 'number' ? previous : Date.parse(previous);
  const nextMs = typeof next === 'number' ? next : Date.parse(next);
  if (Number.isFinite(previousMs) && Number.isFinite(nextMs) && nextMs < previousMs) return previous;
  return next;
}

function freezeDescriptor(descriptor) {
  if (!isRecord(descriptor)) throw new TypeError('Source descriptor must be an object.');
  if (typeof descriptor.requiresProxy !== 'boolean') {
    throw new TypeError('Source descriptor requiresProxy must be boolean.');
  }
  return Object.freeze({
    id: nonEmptyText(descriptor.id, 'id'),
    markets: immutableTextList(descriptor.markets, 'markets', { required: true }),
    capabilities: immutableTextList(descriptor.capabilities, 'capabilities'),
    priority: finiteNumber(descriptor.priority, 'priority'),
    timeoutMs: finiteNumber(descriptor.timeoutMs, 'timeoutMs', { minimum: 0, integer: true }),
    freshnessPolicy: nonEmptyText(descriptor.freshnessPolicy, 'freshnessPolicy'),
    requiresProxy: descriptor.requiresProxy,
    sourceTier: descriptor.sourceTier ? nonEmptyText(descriptor.sourceTier, 'sourceTier') : 'secondary',
  });
}

function freezeHealth(health) {
  return Object.freeze({
    status: health.status,
    consecutiveFailures: health.consecutiveFailures,
    lastSuccessAt: health.lastSuccessAt,
    lastFailureAt: health.lastFailureAt,
    lastResponseMs: health.lastResponseMs,
    lastAvailableAt: health.lastAvailableAt,
    degradationReason: health.degradationReason,
    cooldownUntil: health.cooldownUntil,
    halfOpenProbeActive: health.halfOpenProbeActive,
    halfOpenProbeAt: health.halfOpenProbeAt,
  });
}

function initialHealth() {
  return freezeHealth({
    status: SOURCE_HEALTH.HEALTHY,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastResponseMs: null,
    lastAvailableAt: null,
    degradationReason: null,
    cooldownUntil: null,
    halfOpenProbeActive: false,
    halfOpenProbeAt: null,
  });
}

function freezeEntry(descriptor, health = initialHealth()) {
  return Object.freeze({ descriptor, health });
}

function freezeRegistry(policy, sources) {
  return Object.freeze({
    policy: Object.freeze({
      failureThreshold: policy.failureThreshold,
      cooldownMs: policy.cooldownMs,
    }),
    sources: Object.freeze(sources),
  });
}

function normalizePolicy(value = {}) {
  if (!isRecord(value)) throw new TypeError('Source health policy must be an object.');
  return {
    failureThreshold: finiteNumber(
      value.failureThreshold ?? DEFAULT_SOURCE_HEALTH_POLICY.failureThreshold,
      'failureThreshold',
      { minimum: 1, integer: true }
    ),
    cooldownMs: finiteNumber(
      value.cooldownMs ?? DEFAULT_SOURCE_HEALTH_POLICY.cooldownMs,
      'cooldownMs',
      { minimum: 0, integer: true }
    ),
  };
}

function sourceIndex(registry, sourceId) {
  const id = String(sourceId == null ? '' : sourceId).trim();
  return registry.sources.findIndex(entry => entry.descriptor.id === id);
}

function requireRegistry(registry) {
  if (!registry || !Array.isArray(registry.sources) || !registry.policy) {
    throw new TypeError('Expected a source registry created by createSourceRegistry.');
  }
  return registry;
}

function requireSourceIndex(registry, sourceId) {
  const index = sourceIndex(registry, sourceId);
  if (index < 0) throw new RangeError(`Unknown source: ${String(sourceId)}.`);
  return index;
}

function replaceHealth(registry, index, health) {
  const sources = registry.sources.map((entry, entryIndex) => entryIndex === index
    ? freezeEntry(entry.descriptor, freezeHealth(health))
    : entry);
  return freezeRegistry(registry.policy, sources);
}

function failureDetails(failure) {
  if (failure instanceof Error) return { error: failure };
  return isRecord(failure) ? failure : { reason: failure };
}

function errorField(details, field) {
  return details[field] ?? (isRecord(details.error) ? details.error[field] : undefined);
}

export function isAbortedSourceFailure(failure) {
  const details = failureDetails(failure);
  const name = String(errorField(details, 'name') || '');
  const code = String(errorField(details, 'code') || '');
  const reason = String(details.reason || '').trim().toLowerCase();
  return details.aborted === true || name === 'AbortError' || code === 'ABORT_ERR' || reason === 'aborted';
}

function isUnavailableFailure(details) {
  const status = String(details.status || '').trim().toLowerCase();
  const code = String(errorField(details, 'code') || '').trim().toUpperCase();
  return details.unavailable === true || status === SOURCE_HEALTH.UNAVAILABLE || code === 'SOURCE_UNAVAILABLE';
}

function failureReason(details) {
  return optionalReason(details.reason)
    || optionalReason(errorField(details, 'code'))
    || optionalReason(errorField(details, 'name'))
    || 'request_failed';
}

function detailClock(details, fallback) {
  return clockAt(details.now ?? fallback);
}

/** Create an immutable registry; descriptors are copied and validated on entry. */
export function createSourceRegistry(descriptors = [], policy = {}) {
  if (!Array.isArray(descriptors)) throw new TypeError('Source descriptors must be an array.');
  let registry = freezeRegistry(normalizePolicy(policy), []);
  for (const descriptor of descriptors) registry = registerSource(registry, descriptor);
  return registry;
}

/** Register one validated descriptor without mutating the prior registry. */
export function registerSource(registry, descriptor) {
  requireRegistry(registry);
  const normalized = freezeDescriptor(descriptor);
  if (sourceIndex(registry, normalized.id) >= 0) {
    throw new RangeError(`A source named ${normalized.id} is already registered.`);
  }
  return freezeRegistry(registry.policy, [...registry.sources, freezeEntry(normalized)]);
}

export function getSourceDescriptor(registry, sourceId) {
  requireRegistry(registry);
  const index = sourceIndex(registry, sourceId);
  return index < 0 ? null : registry.sources[index].descriptor;
}

export function getSourceHealth(registry, sourceId) {
  requireRegistry(registry);
  const index = sourceIndex(registry, sourceId);
  return index < 0 ? null : registry.sources[index].health;
}

/** A successful request closes any breaker and restores the source to healthy. */
export function recordSourceSuccess(registry, sourceId, details = {}, now = 0) {
  requireRegistry(registry);
  const metadata = isRecord(details) ? details : {};
  const at = detailClock(metadata, now);
  const index = requireSourceIndex(registry, sourceId);
  const previous = registry.sources[index].health;
  const responseMs = optionalResponseMs(metadata.responseMs);
  const availableAt = optionalTimestamp(metadata.availableAt ?? metadata.quoteTime);
  return replaceHealth(registry, index, {
    ...previous,
    status: SOURCE_HEALTH.HEALTHY,
    consecutiveFailures: 0,
    lastSuccessAt: at,
    lastResponseMs: responseMs ?? previous.lastResponseMs,
    lastAvailableAt: preferredAvailableAt(previous.lastAvailableAt, availableAt),
    degradationReason: null,
    cooldownUntil: null,
    halfOpenProbeActive: false,
    halfOpenProbeAt: null,
  });
}

/** A structurally valid response with incomplete business coverage stays usable but degraded. */
export function recordSourcePartial(registry, sourceId, details = {}, now = 0) {
  requireRegistry(registry);
  const metadata = isRecord(details) ? details : {};
  const at = detailClock(metadata, now);
  const index = requireSourceIndex(registry, sourceId);
  const previous = registry.sources[index].health;
  const responseMs = optionalResponseMs(metadata.responseMs);
  const availableAt = optionalTimestamp(metadata.availableAt ?? metadata.quoteTime);
  return replaceHealth(registry, index, {
    ...previous,
    status: SOURCE_HEALTH.DEGRADED,
    consecutiveFailures: 0,
    lastSuccessAt: at,
    lastResponseMs: responseMs ?? previous.lastResponseMs,
    lastAvailableAt: preferredAvailableAt(previous.lastAvailableAt, availableAt),
    degradationReason: optionalReason(metadata.reason) || 'partial_coverage',
    cooldownUntil: null,
    halfOpenProbeActive: false,
    halfOpenProbeAt: null,
  });
}

/**
 * Record a non-aborted failure.  A source in cooldown remains protected when
 * its single half-open probe fails; an explicit unavailable result stays out
 * of selection until a later success restores it.
 */
export function recordSourceFailure(registry, sourceId, failure = {}, now = 0) {
  requireRegistry(registry);
  if (isAbortedSourceFailure(failure)) return registry;
  const details = failureDetails(failure);
  const at = detailClock(details, now);
  const index = requireSourceIndex(registry, sourceId);
  const previous = registry.sources[index].health;
  const responseMs = optionalResponseMs(details.responseMs);
  const availableAt = optionalTimestamp(details.availableAt ?? details.quoteTime);
  const consecutiveFailures = previous.consecutiveFailures + 1;

  if (isUnavailableFailure(details) || previous.status === SOURCE_HEALTH.UNAVAILABLE) {
    return replaceHealth(registry, index, {
      ...previous,
      status: SOURCE_HEALTH.UNAVAILABLE,
      consecutiveFailures,
      lastFailureAt: at,
      lastResponseMs: responseMs ?? previous.lastResponseMs,
      lastAvailableAt: preferredAvailableAt(previous.lastAvailableAt, availableAt),
      degradationReason: failureReason(details),
      cooldownUntil: null,
      halfOpenProbeActive: false,
      halfOpenProbeAt: null,
    });
  }

  const enterCooldown = previous.status === SOURCE_HEALTH.COOLDOWN
    || consecutiveFailures >= registry.policy.failureThreshold;
  return replaceHealth(registry, index, {
    ...previous,
    status: enterCooldown ? SOURCE_HEALTH.COOLDOWN : SOURCE_HEALTH.DEGRADED,
    consecutiveFailures,
    lastFailureAt: at,
    lastResponseMs: responseMs ?? previous.lastResponseMs,
    lastAvailableAt: preferredAvailableAt(previous.lastAvailableAt, availableAt),
    degradationReason: failureReason(details),
    cooldownUntil: enterCooldown ? at + registry.policy.cooldownMs : null,
    halfOpenProbeActive: false,
    halfOpenProbeAt: null,
  });
}

/** True means a source may be attempted at the supplied clock instant. */
export function canAttemptSource(registry, sourceId, now = 0) {
  requireRegistry(registry);
  const index = sourceIndex(registry, sourceId);
  if (index < 0) return false;
  const at = clockAt(now);
  const health = registry.sources[index].health;
  if (health.status === SOURCE_HEALTH.UNAVAILABLE) return false;
  if (health.status !== SOURCE_HEALTH.COOLDOWN) return true;
  return at >= health.cooldownUntil && !health.halfOpenProbeActive;
}

/**
 * Reserve the one half-open probe after cooldown without mutating the input.
 * Coordinators should call this immediately before starting a selected source.
 */
export function claimSourceAttempt(registry, sourceId, now = 0) {
  requireRegistry(registry);
  const at = clockAt(now);
  if (!canAttemptSource(registry, sourceId, at)) {
    return Object.freeze({ registry, allowed: false, halfOpen: false });
  }
  const index = requireSourceIndex(registry, sourceId);
  const previous = registry.sources[index].health;
  if (previous.status !== SOURCE_HEALTH.COOLDOWN) {
    return Object.freeze({ registry, allowed: true, halfOpen: false });
  }
  return Object.freeze({
    registry: replaceHealth(registry, index, {
      ...previous,
      halfOpenProbeActive: true,
      halfOpenProbeAt: at,
    }),
    allowed: true,
    halfOpen: true,
  });
}

/** Release a cancelled half-open probe without counting it as a source failure. */
export function releaseSourceAttempt(registry, sourceId) {
  requireRegistry(registry);
  const index = sourceIndex(registry, sourceId);
  if (index < 0) return registry;
  const previous = registry.sources[index].health;
  if (!previous.halfOpenProbeActive) return registry;
  return replaceHealth(registry, index, {
    ...previous,
    halfOpenProbeActive: false,
    halfOpenProbeAt: null,
  });
}

function requestedCapabilities(criteria) {
  if (criteria.capability != null) return immutableTextList([criteria.capability], 'capability');
  if (criteria.capabilities == null) return Object.freeze([]);
  return immutableTextList(criteria.capabilities, 'capabilities');
}

function matchesSelection(entry, criteria, capabilities, at) {
  const { descriptor } = entry;
  const market = criteria.market == null ? null : String(criteria.market).trim();
  if (market && !descriptor.markets.includes(market)) return false;
  if (capabilities.some(capability => !descriptor.capabilities.includes(capability))) return false;
  if (criteria.proxyAvailable === false && descriptor.requiresProxy) return false;
  if (entry.health.status === SOURCE_HEALTH.UNAVAILABLE) return false;
  if (entry.health.status !== SOURCE_HEALTH.COOLDOWN) return true;
  return at >= entry.health.cooldownUntil && !entry.health.halfOpenProbeActive;
}

/**
 * Return immutable descriptors in priority order.  This only selects; callers
 * must use claimSourceAttempt before executing a cooldown half-open probe.
 */
export function selectAvailableSources(registry, criteria = {}, now = 0) {
  requireRegistry(registry);
  if (!isRecord(criteria)) throw new TypeError('Source selection criteria must be an object.');
  const at = clockAt(criteria.now ?? now);
  const capabilities = requestedCapabilities(criteria);
  return Object.freeze(registry.sources
    .filter(entry => matchesSelection(entry, criteria, capabilities, at))
    .sort((left, right) => right.descriptor.priority - left.descriptor.priority
      || left.descriptor.id.localeCompare(right.descriptor.id))
    .map(entry => entry.descriptor));
}
