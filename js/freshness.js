import {
  classifyMarketKind,
  marketSession,
  refreshDelayForMarketKinds,
} from './runtime/market-session.js';

const MINUTE = 60 * 1000;
export const MAX_FUTURE_SOURCE_SKEW_MS = 5 * MINUTE;

export function parseChinaSourceTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const [, year, month, day, hour = '15', minute = '0', second = '0'] = match;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minute}:${second.padStart(2, '0')}+08:00`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function classifyFundMarket(name) {
  const text = String(name || '');
  const canonical = classifyMarketKind(text);
  if (canonical === 'cn' && /指数|ETF|联接/i.test(text)) return 'cn-index';
  // Keep the historical `overseas` alias for US callers, but do not collapse
  // Japanese and Korean markets back into the US clock. The auto-refresh
  // scheduler consumes this function directly.
  if (canonical === 'us') return 'overseas';
  return canonical;
}

export function marketState(market, now = new Date()) {
  return marketSession(market, now).marketState;
}

export function refreshDelayForMarkets(markets, now = new Date()) {
  return refreshDelayForMarketKinds(markets, now);
}

export function buildFreshness({ sourceTime, fetchedAt = new Date().toISOString(), calculatedAt = null, source, isFallback = false, fallbackReason = null, market = 'cn', model = false, official = false, unavailable = false }, now = Date.now()) {
  const exactTime = /\d{1,2}:\d{2}/.test(String(sourceTime || ''));
  const sourceMs = exactTime ? parseChinaSourceTime(sourceTime) : null;
  const nowMs = Number(now);
  const referenceNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const sourceTimeInFuture = sourceMs != null && sourceMs > referenceNow + MAX_FUTURE_SOURCE_SKEW_MS;
  const ageSeconds = sourceMs == null || sourceTimeInFuture
    ? null
    : Math.max(0, Math.floor((referenceNow - sourceMs) / 1000));
  let status = 'fresh';
  let label = '实时';
  if (unavailable) { status = 'unavailable'; label = '暂不可估值'; }
  else if (sourceTimeInFuture) { status = 'stale'; label = '时间异常'; }
  else if (model) { status = 'degraded'; label = '模型估算'; }
  else if (official) { status = 'degraded'; label = '最新正式净值'; }
  else if (!exactTime && sourceTime) { status = 'delayed'; label = '延迟'; }
  else if (sourceMs == null || ageSeconds > 24 * 3600) { status = 'stale'; label = '旧数据'; }
  else if (isFallback || ageSeconds > 10 * 60 || marketState(market, new Date(referenceNow)) !== 'open') { status = 'delayed'; label = '延迟'; }
  return { sourceTime: sourceTime || null, fetchedAt, calculatedAt, ageSeconds, status, source: source || 'unknown', isFallback, fallbackReason, label, market, sourceTimeInFuture };
}
