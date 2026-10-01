import { TTL } from '../config.js';
import { classifyFundMarket } from '../freshness.js';
import { activeHoldingCodes } from './active-holdings.js';
import { validateBridgeParams } from './remote-schema.js';
import { WORKER_REQUEST_LIMIT } from './worker-contract.js';
import { REFRESH_INDEX_KEY, refreshResourcePolicy, policyOwn as own, policyRecord as isRecord, policyEpoch as isEpoch } from './refresh-resource-policy.js';

const HOLDINGS_MARKETS = new Set(['cn', 'cn-index', 'hk']);
const SOURCE_TIERS = new Set(['primary', 'secondary', 'model', 'cache']);
const USABLE_STATUSES = new Set(['realtime', 'delayed', 'closed', 'current', 'ok', 'latest_official']);

function requireGeneration(generation) {
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new TypeError('Refresh plan generation must be a positive safe integer.');
  }
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function cacheDecision(cacheIndex, key, ttlMs, now) {
  if (!isRecord(cacheIndex) || !own(cacheIndex, key)) return { action: 'fetch', reason: 'cache_miss' };
  const meta = cacheIndex[key];
  if (!isRecord(meta) || !['validated', 'fetchedAt', 'cachedAt', 'expiresAt'].every(field => own(meta, field)) || meta.validated !== true
    || !isEpoch(meta.fetchedAt) || !isEpoch(meta.cachedAt) || !isEpoch(meta.expiresAt)
    || meta.fetchedAt > meta.cachedAt || meta.cachedAt > now || meta.expiresAt <= meta.cachedAt) {
    return { action: 'fetch', reason: 'cache_metadata_invalid' };
  }
  if ((own(meta, 'sourceTier') && !SOURCE_TIERS.has(meta.sourceTier))
    || (own(meta, 'status') && !USABLE_STATUSES.has(meta.status))
    || (own(meta, 'cacheState') && meta.cacheState !== 'fresh')) {
    return { action: 'fetch', reason: 'cache_quality_unusable' };
  }
  // A caller cannot enlarge a resource's canonical TTL by supplying a later
  // expiry. Reading this metadata never renews any acquisition timestamp.
  if (now >= meta.expiresAt || now - meta.cachedAt >= ttlMs) {
    return { action: 'fetch', reason: 'cache_expired' };
  }
  return { action: 'cache', reason: 'fresh_cache', cacheExpiresAt: Math.min(meta.expiresAt, meta.cachedAt + ttlMs) };
}

/**
 * Decide acquisitions, not their execution. Input cache entries are validated
 * metadata only; no cache payload or holding object is retained in the plan.
 */
export function createRefreshPlan({
  generation,
  trigger = 'unknown',
  now,
  activeHoldings = [],
  cacheIndex = {},
  forceLive = false,
  forceStable = [],
} = {}) {
  requireGeneration(generation);
  if (!isEpoch(now)) throw new TypeError('Refresh plan now must be an explicit safe epoch.');
  const planTrigger = typeof trigger === 'string' ? trigger.trim().slice(0, 40) || 'unknown' : 'unknown';
  const activeCodes = activeHoldingCodes(activeHoldings);
  const forcedStable = new Set(planTrigger === 'diagnostic' && Array.isArray(forceStable) ? forceStable : []);
  const resources = [];
  const primary = [];
  const stable = [];

  function add(key, isStable, eligible = true) {
    const policy = refreshResourcePolicy(key);
    const resource = { key, kind: policy.kind, provider: policy.source,
      [policy.codes ? 'codes' : 'code']: policy.codes || policy.code, ttlMs: policy.ttlMs };
    let decision;
    if (!eligible) decision = { action: 'skip', reason: 'market_ineligible' };
    else if (isStable && forcedStable.has(resource.key)) decision = { action: 'fetch', reason: 'force_stable' };
    else if (!isStable && forceLive === true) decision = { action: 'fetch', reason: 'force_live' };
    else decision = cacheDecision(cacheIndex, resource.key, resource.ttlMs, now);
    resources.push({ ...resource, cacheExpiresAt: null, ...decision });
    (isStable ? stable : primary).push(resource.key);
  }

  if (activeCodes.length) {
    const codes = [...activeCodes].sort();
    for (let index = 0; index < codes.length; index += WORKER_REQUEST_LIMIT) {
      const batch = codes.slice(index, index + WORKER_REQUEST_LIMIT);
      add(`estimates:${batch.join(',')}`, false);
    }
  }
  add(REFRESH_INDEX_KEY, false);
  add('gold:AU9999', false);

  for (const code of activeCodes) {
    const holding = activeHoldings.find(item => item?.deleted !== true && !item?.deletedAt
      && String(item?.code ?? item?.fundCode ?? '').trim() === code);
    add(`nav:${code}`, true);
    add(`holdings:${code}`, true,
      HOLDINGS_MARKETS.has(classifyFundMarket(holding?.name)));
    add(`meta:${code}`, true);
  }

  // Reserve phase-B scope keys now, while waiting for validated disclosures
  // to determine the actual demand union. These are never global cache hits.
  const securities = ['securities:union', 'models:active'];
  for (const [key, kind, provider] of [
    ['securities:union', 'securities', 'eastmoney-security-quote'],
    ['models:active', 'model-quotes', 'tencent-market-quote'],
  ]) {
    resources.push({ key, kind, provider,
      action: activeCodes.length ? 'fetch' : 'skip',
      reason: activeCodes.length ? 'phase_pending' : 'no_active_holdings',
      cacheExpiresAt: null, ttlMs: TTL.INTRADAY });
  }

  return freeze({
    generation,
    trigger: planTrigger,
    plannedAt: now,
    activeCodes,
    resources,
    phases: [
      { name: 'primary', resourceKeys: primary },
      { name: 'stable', resourceKeys: stable },
      { name: 'securities', resourceKeys: securities },
    ],
  });
}

function allowedCode(operation, code) {
  try {
    validateBridgeParams(operation, { codes: [code] });
    return true;
  } catch (_) { return false; }
}

/**
 * Second-phase demand union. Execution must still batch within the existing
 * Bridge limits and request Tencent fallback only for missing primary quotes.
 */
export function createSecurityQuotePlan({ generation, snapshots = [], selectedModels = [], indexCodes = [] } = {}) {
  requireGeneration(generation);
  const securities = new Set();
  const models = new Set();
  const indices = new Set();
  const rejected = [];
  let goldRequired = false;

  function addCode(collection, operation, code, kind, index) {
    if (!allowedCode(operation, code)) {
      // Do not echo untrusted upstream strings into diagnostics.
      rejected.push({ kind, index, reason: 'unsupported_quote_identity' });
      return;
    }
    collection.add(code.trim());
  }

  for (const [index, snapshot] of (Array.isArray(snapshots) ? snapshots : []).entries()) {
    if (!isRecord(snapshot) || snapshot.validated !== true || snapshot.status !== 'ok' || !Array.isArray(snapshot.items)) {
      rejected.push({ kind: 'snapshot', index, reason: 'snapshot_unusable' });
      continue;
    }
    snapshot.items.forEach((item, itemIndex) => addCode(securities, 'securityQuotes', item?.quoteCode, 'security', itemIndex));
  }
  for (const model of Array.isArray(selectedModels) ? selectedModels : []) {
    const legs = [...(Array.isArray(model?.legs) ? model.legs : []),
      ...(Array.isArray(model?.fallback?.legs) ? model.fallback.legs : [])];
    legs.forEach((leg, index) => {
      if (leg?.code === 'AU9999') goldRequired = true;
      else addCode(models, 'overseasComponents', leg?.code, 'model', index);
    });
  }
  (Array.isArray(indexCodes) ? indexCodes : []).forEach((code, index) => addCode(indices, 'indexQuotes', code, 'index', index));

  return freeze({
    generation,
    qualifiedCodes: [...new Set([...securities, ...models, ...indices])].sort(),
    securityCodes: [...securities].sort(),
    modelCodes: [...models].sort(),
    indexCodes: [...indices].sort(),
    goldRequired,
    rejected,
  });
}
