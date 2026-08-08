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
  if (/黄金|白银|贵金属|商品/i.test(text)) return 'gold';
  if (/港股|恒生|香港/i.test(text)) return 'hk';
  if (/QDII|全球|海外|纳斯达克|标普|美元|国际|日经|德国|越南|印度/i.test(text)) return 'overseas';
  if (/指数|ETF|联接/i.test(text)) return 'cn-index';
  return 'cn';
}

function clockInZone(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const values = Object.fromEntries(parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]));
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    return Number.isFinite(hour) && Number.isFinite(minute)
      ? { weekday: values.weekday, minute: hour * 60 + minute }
      : null;
  } catch (_) { return null; }
}

function isWeekend(weekday) {
  return weekday === 'Sat' || weekday === 'Sun' || weekday === 0 || weekday === 6;
}

export function marketState(market, now = new Date()) {
  if (market === 'overseas') {
    const us = clockInZone(now, 'America/New_York');
    if (us) return isWeekend(us.weekday) || us.minute < 570 || us.minute >= 960 ? 'closed' : 'open';
  }
  const china = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * MINUTE);
  const weekday = china.getDay();
  const minute = china.getHours() * 60 + china.getMinutes();
  if (isWeekend(weekday)) return 'closed';
  if (market === 'overseas') return minute >= 21 * 60 || minute < 5 * 60 ? 'open' : 'closed';
  if (market === 'hk') return (minute >= 570 && minute < 720) || (minute >= 780 && minute < 960) ? 'open' : 'closed';
  if (market === 'gold') return (minute >= 540 && minute < 930) || minute >= 1200 ? 'open' : 'closed';
  return (minute >= 570 && minute < 690) || (minute >= 780 && minute < 900) ? 'open' : 'closed';
}

export function refreshDelayForMarkets(markets, now = new Date()) {
  const list = Array.from(markets || []);
  return list.some((market) => marketState(market, now) === 'open') ? MINUTE : 5 * MINUTE;
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
