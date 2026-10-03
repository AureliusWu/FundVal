import { TTL } from '../config.js';
import { chinaTimeParts, chinaDateKey, marketClock, zonedTimeParts } from './market-clock.js';
import { holdingQuoteCode } from '../fund-holdings.js';
import { nullableNumber, parseQuoteTimestamp } from './quote-contract.js';
import { BRIDGE_LIMITS, validateBridgeParams, validateBridgeOperationData } from './remote-schema.js';
import { RefreshCoordinator } from './refresh-coordinator.js';
import { createSecurityQuotePlan } from './refresh-plan.js';
import { createGenerationResourceScope } from './generation-resource-scope.js';
import { throwIfAborted } from './request-signal.js';
import { validateRefreshResourceEntry } from './refresh-resource-cache.js';
import { REFRESH_INDEX_KEY, policyOwn as own, policyRecord as record } from './refresh-resource-policy.js';
import { MAX_QUOTE_AGE_MS } from '../overseas-model.js';

const MAINLAND_CODE = /^(sh|sz)\d{6}$/;
const SEED_INDEX_CODES = new Set(['usINX', 'usNDX']);
const SEED_STATUSES = new Set(['current', 'realtime', 'delayed', 'closed']);

function aborted(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'aborted' || error?.aborted === true;
}

function clock(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) {
    throw new TypeError('Security quote clock must return a real epoch.');
  }
  return value;
}

function chinaText(timestamp) {
  const parts = chinaTimeParts(timestamp);
  if (!parts) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${parts.dateKey} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

// A detail may retain a legal prior close, but its display clock never grants
// permission to use that history as today's model input. Cached times are
// already Beijing timestamps: do not convert them from exchange time again.
export function assessDetailSecurityQuote(stock, { now = Date.now(), allowMainland = false } = {}) {
  const unavailable = { displayChange: null, status: 'unavailable', needsRefresh: false,
    sourceTime: null, todayCandidate: false, caption: '行情暂不可用' };
  if (!record(stock) || !Number.isSafeInteger(now) || now <= 0 || now > 8_640_000_000_000_000) return Object.freeze(unavailable);
  const code = holdingQuoteCode(stock, { allowMainland });
  try { validateBridgeParams('securityQuotes', { codes: [code] }); }
  catch (_) { return Object.freeze(unavailable); }
  const timestamp = typeof stock.quoteTime === 'string' ? parseQuoteTimestamp(stock.quoteTime) : null;
  if (stock.quoteCode !== code || !Number.isFinite(stock.change) || timestamp == null || timestamp <= 0 || timestamp > now) {
    return Object.freeze({ ...unavailable, needsRefresh: true });
  }
  const session = marketClock(MAINLAND_CODE.test(code) ? 'cn' : code.slice(0, 2), now);
  const historical = zonedTimeParts(timestamp, session.timezone)?.dateKey !== session.dateKey
    || now - timestamp >= session.expectedFreshnessMs;
  const sourceTime = chinaText(timestamp);
  return Object.freeze({ displayChange: stock.change, status: historical ? 'historical' : 'recent',
    needsRefresh: historical && ['open', 'unknown'].includes(session.marketState), sourceTime,
    todayCandidate: chinaDateKey(timestamp) === chinaDateKey(now),
    caption: `${historical ? '旧行情' : '最近行情'} · ${sourceTime}${session.calendarStatus === 'valid' ? '' : ' · 日历未验证'}` });
}

function demandCodes(operation, input) {
  if (!Array.isArray(input)) throw new TypeError('Security quote demand must be a code array.');
  const unique = new Set();
  for (const code of input) {
    const validated = validateBridgeParams(operation, { codes: [code] });
    unique.add(validated.codes[0]);
  }
  return [...unique].sort();
}

function batches(codes, maximum) {
  const out = [];
  for (let index = 0; index < codes.length; index += maximum) out.push(codes.slice(index, index + maximum));
  return out;
}

function primaryQuotes(payload, requested, now) {
  const diff = payload?.data?.diff;
  const rows = Array.isArray(diff) ? diff : record(diff) ? Object.values(diff) : [];
  if (rows.length > requested.length) return {};
  const expected = new Set(requested), seen = new Set(), identities = [];
  // Check the entire identity set before considering any numeric values. A
  // missing f13 must never be rescued by a coincidentally matching bare f12.
  for (const row of rows) {
    if (!record(row) || typeof row.f12 !== 'string' || !/^\d{6}$/.test(row.f12) || ![0, 1].includes(row.f13)) return {};
    const code = (row.f13 === 1 ? 'sh' : 'sz') + row.f12;
    if (!expected.has(code) || seen.has(code)) return {};
    seen.add(code);
    identities.push({ code, row });
  }
  const out = {}, at = clock(now);
  for (const { code, row } of identities) {
    const changePct = nullableNumber(row.f3, { minimum: -1e6, maximum: 1e6 });
    const seconds = row.f124;
    if (changePct == null || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0
      || !Number.isSafeInteger(seconds * 1000) || seconds * 1000 > at) continue;
    const sourceTime = chinaText(seconds * 1000);
    if (!sourceTime || parseQuoteTimestamp(sourceTime) == null) continue;
    out[code] = { price: nullableNumber(row.f2, { minimum: Number.MIN_VALUE, maximum: 1e15 }), changePct, sourceTime };
  }
  return out;
}

function bridgeQuotes(payload, operation, requested, normalizeTime, now) {
  const validated = validateBridgeOperationData(operation, payload, { codes: requested });
  const out = {}, at = clock(now);
  for (const row of validated.quotes) {
    if (row.changePct == null) continue;
    let sourceTime;
    try { sourceTime = normalizeTime(row.sourceTimeRaw, row.code); } catch (_) { continue; }
    const timestamp = parseQuoteTimestamp(sourceTime);
    if (timestamp == null || timestamp <= 0 || timestamp > at) continue;
    const canonicalTime = chinaText(timestamp);
    if (!canonicalTime) continue;
    out[row.code] = { price: row.price, changePct: row.changePct, sourceTime: canonicalTime };
  }
  return out;
}

function seedQuote(seed, now, acquired = false) {
  if (!record(seed) || (own(seed, 'status')
    && !SEED_STATUSES.has(seed.status) && !(acquired && seed.status === 'stale'))) return null;
  const price = nullableNumber(seed.price, { minimum: Number.MIN_VALUE, maximum: 1e15 });
  const changePct = nullableNumber(seed.changePct, { minimum: -1e6, maximum: 1e6 });
  const source = own(seed, 'sourceTime') ? seed.sourceTime : seed.observedAt;
  const timestamp = parseQuoteTimestamp(source), at = clock(now);
  if (price == null || changePct == null || timestamp == null || timestamp <= 0 || timestamp > at
    || (acquired ? at - timestamp > MAX_QUOTE_AGE_MS : at - timestamp >= TTL.INDEX)) return null;
  const sourceTime = chinaText(timestamp);
  return sourceTime ? { price, changePct, sourceTime } : null;
}

/**
 * Clients have no UI/storage side effects. Every real acquisition passes the
 * current generation's dispatch gate, including each provider fallback batch.
 */
export async function executeSecurityQuotePlan({
  plan,
  scope,
  fetchEastmoney,
  fetchBridge,
  normalizeTime,
  seedQuotes = {},
  indexEntry,
  canAcquireModels = () => true,
  onModelAcquisition = () => {},
  now = Date.now,
} = {}) {
  if (!plan || !Number.isSafeInteger(plan.generation) || plan.generation <= 0 || typeof scope?.dispatch !== 'function'
    || typeof fetchEastmoney !== 'function' || typeof fetchBridge !== 'function' || typeof normalizeTime !== 'function'
    || typeof now !== 'function' || typeof canAcquireModels !== 'function'
    || typeof onModelAcquisition !== 'function') throw new TypeError('Invalid security quote execution context.');
  if (typeof scope.snapshot === 'function' && scope.snapshot().generation !== plan.generation) {
    throw new TypeError('Security quote plan belongs to another generation.');
  }
  clock(now);
  scope.assertCurrent?.();
  const securityCodes = demandCodes('securityQuotes', plan.securityCodes);
  const modelCodes = demandCodes('overseasComponents', plan.modelCodes);
  const demanded = [...new Set([...securityCodes, ...modelCodes])].sort();
  const acquired = {};
  const securities = new Set(securityCodes);
  const requestedModels = new Set();
  // This is a validated acquisition envelope, not a caller's "fresh" flag.
  // Reuse the real prior US close for models only; its UI status and source
  // clock stay untouched and the model's base/target interval guard still runs.
  const index = validateRefreshResourceEntry(REFRESH_INDEX_KEY, indexEntry, { now: clock(now) });
  const acquiredIndices = index?.cacheState === 'fresh'
    ? Object.fromEntries(index.payload.quotes.map(quote => [quote.code, quote])) : {};

  function permittedBatch(codes) {
    const exclusive = codes.filter(code => modelCodes.includes(code) && !securities.has(code));
    const allowed = !exclusive.length || canAcquireModels(exclusive) === true;
    const permitted = codes.filter(code => !exclusive.includes(code) || allowed);
    permitted.forEach(code => { if (exclusive.includes(code)) requestedModels.add(code); });
    return permitted;
  }

  for (const code of demanded) {
    if (!SEED_INDEX_CODES.has(code)) continue;
    const value = acquiredIndices[code] && seedQuote(acquiredIndices[code], now, modelCodes.includes(code) && !securities.has(code))
      || (record(seedQuotes) && own(seedQuotes, code) && seedQuote(seedQuotes[code], now));
    if (value) acquired[code] = value;
  }

  for (const codes of batches(demanded.filter(code => MAINLAND_CODE.test(code) && !acquired[code]), BRIDGE_LIMITS.securityCodes)) {
    const permitted = permittedBatch(codes);
    if (!permitted.length) continue;
    try {
      const payload = await scope.dispatch('eastmoney-security-quote', signal => fetchEastmoney(permitted, signal));
      Object.assign(acquired, primaryQuotes(payload, permitted, now));
    } catch (error) { if (aborted(error)) throw error; }
  }

  // Prefer the model-compatible operation for shared codes. This leaves the
  // two Tencent request sets disjoint, without widening either allowlist.
  const modelMissing = modelCodes.filter(code => !acquired[code]);
  const shared = new Set(modelMissing);
  const securityMissing = securityCodes.filter(code => !acquired[code] && !shared.has(code));
  for (const [operation, codes, maximum] of [
    ['overseasComponents', modelMissing, BRIDGE_LIMITS.overseasCodes],
    ['securityQuotes', securityMissing, BRIDGE_LIMITS.securityCodes],
  ]) {
    for (const batch of batches(codes, maximum)) {
      const permitted = permittedBatch(batch);
      if (!permitted.length) continue;
      try {
        validateBridgeParams(operation, { codes: permitted });
        const payload = await scope.dispatch('tencent-market-quote', signal => fetchBridge(operation, permitted, signal));
        Object.assign(acquired, bridgeQuotes(payload, operation, permitted, normalizeTime, now));
      } catch (error) { if (aborted(error)) throw error; }
    }
  }

  const securityQuotes = {}, modelQuotes = {};
  for (const code of securityCodes) {
    const value = acquired[code];
    if (value) securityQuotes[code] = { quoteCode: code, change: value.changePct, quoteTime: value.sourceTime };
  }
  for (const code of modelCodes) {
    const value = acquired[code];
    if (value) modelQuotes[code] = { ...value };
  }
  scope.assertCurrent?.();
  if (requestedModels.size) onModelAcquisition({ requestedCodes: [...requestedModels],
    acquiredCodes: [...requestedModels].filter(code => acquired[code]) });
  return { securityQuotes, modelQuotes };
}

/** A cold interactive detail owns a real, read-only generation, never cache writes. */
export async function executeDetailSecurityQuotes({ items, signal, now = Date.now, ...clients } = {}) {
  throwIfAborted(signal);
  const coordinator = new RefreshCoordinator({ now, execute(context) {
    throwIfAborted(signal);
    const plan = createSecurityQuotePlan({ generation: context.generation,
      snapshots: [{ validated: true, status: 'ok', items }] });
    const scope = createGenerationResourceScope({ context, now,
      plan: { generation: context.generation, resources: [] } });
    return executeSecurityQuotePlan({ ...clients, plan, scope, now });
  } });
  const cancel = () => coordinator.stop('detail_cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const outcome = await coordinator.request({ trigger: 'detail' });
    throwIfAborted(signal);
    if (outcome.status === 'failed') throw outcome.error;
    return outcome.result?.securityQuotes || {};
  } finally { signal?.removeEventListener('abort', cancel); }
}
