import { normalizeQuoteDate, normalizeReasonCodes } from './quote-contract.js';
import { chinaDateKey, isSingleMarketSession } from './market-clock.js';

const KINDS = new Set(['intraday_estimate', 'official_nav', 'model_estimate', 'holding_lookthrough_estimate']);
const STATUSES = new Set(['realtime', 'delayed', 'stale', 'model', 'official', 'unavailable']);
const TIERS = new Set(['primary', 'secondary', 'model', 'cache']);
const CACHE_STATES = new Set(['fresh', 'stale', 'expired']);
const positive = value => Number.isFinite(value) && value > 0;

/** Market dates, not observation or request timestamps, define displayed P/L. */
export function createValuationPeriod(quote, { shares = null, now = Date.now(), cacheState = null } = {}) {
  const source = quote && typeof quote === 'object' ? quote : {};
  const today = chinaDateKey(now);
  const baseDate = normalizeQuoteDate(source.baseNavDate);
  const targetDate = normalizeQuoteDate(source.targetDate);
  let state = cacheState ?? source.cacheState ?? null;
  const instant = now instanceof Date ? now.getTime() : now;
  if (state === 'fresh' && Number.isSafeInteger(source.expiresAt) && instant >= source.expiresAt) state = 'stale';
  const reasons = [];
  const official = source.valueKind === 'official_nav';
  const cached = source.sourceTier === 'cache' || state != null;
  const stale = source.status === 'stale' || state === 'stale' || state === 'expired';
  const isTodayInChina = Boolean(today && targetDate === today);
  let unavailable = !today || !KINDS.has(source.valueKind) || !STATUSES.has(source.status)
    || !TIERS.has(source.sourceTier) || source.status === 'unavailable'
    || (state != null && !CACHE_STATES.has(state)) || (cached && state == null);

  if (unavailable) reasons.push('PERIOD_SOURCE_UNAVAILABLE');
  if ((source.baseNavDate != null && !baseDate) || (source.targetDate != null && !targetDate)) {
    unavailable = true;
    reasons.push('PERIOD_DATE_INVALID');
  }
  if (today && ((baseDate && baseDate > today) || (targetDate && targetDate > today))) {
    unavailable = true;
    reasons.push('PERIOD_DATE_IN_FUTURE');
  }
  if (baseDate && targetDate && baseDate >= targetDate) {
    unavailable = true;
    reasons.push('PERIOD_REVERSED');
  }
  const bound = Boolean(baseDate && targetDate && baseDate < targetDate);
  if (!bound) {
    reasons.push('PERIOD_UNBOUND');
    // An official single-point NAV can still be named, never assigned P/L.
    if (!official || !targetDate) unavailable = true;
  }
  const hasValue = positive(source.value);
  const hasChange = Number.isFinite(source.changePct);
  if (!hasValue && !hasChange) {
    unavailable = true;
    reasons.push('PERIOD_VALUE_UNAVAILABLE');
  }
  const singleSession = bound && isSingleMarketSession(baseDate, targetDate, source.market);
  if (!official && bound && !singleSession) reasons.push('PERIOD_NOT_SINGLE_SESSION');
  const isTodayEstimate = !unavailable && !official && !stale && isTodayInChina && singleSession;
  const periodKind = unavailable ? 'unavailable'
    : stale ? 'stale' : official ? 'latest_official' : isTodayEstimate ? 'intraday' : 'historical';
  const amount = !unavailable && bound && hasValue && positive(source.baseNav) && positive(shares)
    ? (source.value - source.baseNav) * shares : null;
  const profitAmount = Number.isFinite(amount) ? (amount === 0 ? 0 : amount) : null;
  return Object.freeze({
    baseDate, targetDate, periodKind, isTodayInChina, isTodayEstimate, profitAmount,
    displayLabel: ({
      intraday: '今日估算', latest_official: '最新正式净值变动', historical: '历史区间变动',
      stale: '旧区间变动', unavailable: '暂无数据',
    })[periodKind],
    sourceStatus: unavailable ? 'unavailable' : cached ? (stale ? 'cached_stale' : 'cached_fresh')
      : stale ? 'cached_stale' : official ? 'official'
        : ['model_estimate', 'holding_lookthrough_estimate'].includes(source.valueKind) ? 'modeled' : 'live',
    reasonCodes: Object.freeze(normalizeReasonCodes([...reasons, ...normalizeReasonCodes(source.reasonCodes || [])])),
    comparisonKey: !unavailable && bound ? `${periodKind}:${baseDate}:${targetDate}` : null,
  });
}
