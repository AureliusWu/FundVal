const MINUTE = 60 * 1000;

const REGISTRY = Object.freeze({
  cn: Object.freeze({ timezone: 'Asia/Shanghai', preopen: 9 * 60 + 15, windows: [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]], expectedFreshnessMs: 10 * MINUTE }),
  hk: Object.freeze({ timezone: 'Asia/Hong_Kong', preopen: 9 * 60, windows: [[9 * 60 + 30, 12 * 60], [13 * 60, 16 * 60 + 10]], expectedFreshnessMs: 10 * MINUTE }),
  us: Object.freeze({ timezone: 'America/New_York', preopen: 4 * 60, windows: [[9 * 60 + 30, 16 * 60]], expectedFreshnessMs: 10 * MINUTE }),
  jp: Object.freeze({ timezone: 'Asia/Tokyo', preopen: 8 * 60, windows: [[9 * 60, 11 * 60 + 30], [12 * 60 + 30, 15 * 60 + 30]], expectedFreshnessMs: 10 * MINUTE }),
  kr: Object.freeze({ timezone: 'Asia/Seoul', preopen: 8 * 60 + 30, windows: [[9 * 60, 15 * 60 + 30]], expectedFreshnessMs: 10 * MINUTE }),
  gold: Object.freeze({ timezone: 'Asia/Shanghai', preopen: 8 * 60 + 45, windows: [[9 * 60, 11 * 60 + 30], [13 * 60 + 30, 15 * 60 + 30]], expectedFreshnessMs: 10 * MINUTE }),
  qdii: Object.freeze({ timezone: 'Asia/Shanghai', preopen: null, windows: [], expectedFreshnessMs: 36 * 60 * MINUTE }),
  unknown: Object.freeze({ timezone: 'Asia/Shanghai', preopen: null, windows: [], expectedFreshnessMs: null }),
});

const ALIASES = Object.freeze({ overseas: 'us', 'cn-index': 'cn', cn_index: 'cn' });

export const MARKET_SESSION_REGISTRY = REGISTRY;

export function normalizeMarketKind(value) {
  const candidate = String(value || '').trim().toLowerCase();
  const normalized = ALIASES[candidate] || candidate;
  return REGISTRY[normalized] ? normalized : 'unknown';
}

export function classifyMarketKind(name) {
  const value = String(name || '');
  if (/黄金|白银|贵金属|商品/i.test(value)) return 'gold';
  if (/日经|日本|东京/i.test(value)) return 'jp';
  if (/韩国|韩股|韩国综合|KOSPI|KOSDAQ/i.test(value)) return 'kr';
  if (/港股|恒生|香港/i.test(value)) return 'hk';
  if (/纳斯达克|标普|美国|美股|美元|道琼斯/i.test(value)) return 'us';
  if (/QDII|全球|海外|国际|德国|越南|印度/i.test(value)) return 'qdii';
  return value.trim() ? 'cn' : 'unknown';
}

export function classifyAssetKind(name, market = classifyMarketKind(name)) {
  const value = String(name || '');
  if (market === 'qdii' || /QDII/i.test(value)) return 'qdii_fund';
  if (market === 'gold' || /商品|贵金属/i.test(value)) return 'commodity_fund';
  if (/指数|ETF|联接/i.test(value)) return 'index_fund';
  return value.trim() ? 'fund' : 'unknown';
}

function zonedParts(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return {
      weekday: ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[values.weekday],
      dateKey: `${values.year}-${values.month}-${values.day}`,
      hour, minute,
    };
  } catch (_) {
    return null;
  }
}

function holidaySet(value) {
  return value instanceof Set ? value : new Set(Array.isArray(value) ? value : []);
}

function stateForGold(day, minute) {
  const overnight = (minute >= 20 * 60 && day >= 1 && day <= 5)
    || (minute < 2 * 60 + 30 && day >= 2 && day <= 6);
  if (overnight) return 'open';
  if (day === 0 || day === 6) return 'closed';
  if (minute >= 8 * 60 + 45 && minute < 9 * 60) return 'preopen';
  if ((minute >= 9 * 60 && minute < 11 * 60 + 30) || (minute >= 13 * 60 + 30 && minute < 15 * 60 + 30)) return 'open';
  if ((minute >= 2 * 60 + 30 && minute < 8 * 60 + 45) || (minute >= 11 * 60 + 30 && minute < 13 * 60 + 30) || (minute >= 15 * 60 + 30 && minute < 20 * 60)) return 'break';
  return 'closed';
}

function stateForWindows(descriptor, day, minute) {
  if (day === 0 || day === 6) return 'closed';
  if (descriptor.preopen != null && minute >= descriptor.preopen && minute < descriptor.windows[0][0]) return 'preopen';
  for (const [start, end] of descriptor.windows) {
    if (minute >= start && minute < end) return 'open';
  }
  for (let index = 0; index < descriptor.windows.length - 1; index += 1) {
    if (minute >= descriptor.windows[index][1] && minute < descriptor.windows[index + 1][0]) return 'break';
  }
  return 'closed';
}

function refreshDelayForState(state) {
  if (state === 'open') return MINUTE;
  if (state === 'break') return 3 * MINUTE;
  return 5 * MINUTE;
}

// Both the legacy wrapper and MarketClock consume the same exchange-local
// parts. This module never imports the clock, avoiding a new dependency cycle.
export function marketStateFromParts(market, parts, options = {}) {
  if (!parts) return 'unknown';
  const kind = normalizeMarketKind(market);
  const descriptor = REGISTRY[kind];
  const day = parts.weekday;
  const minute = parts.hour * 60 + parts.minute;
  if (!Number.isInteger(day) || day < 0 || day > 6 || !Number.isInteger(minute) || minute < 0 || minute >= 1440) return 'unknown';
  if (holidaySet(options.holidays).has(parts.dateKey)) return 'holiday';
  if (kind === 'gold') return stateForGold(day, minute);
  return descriptor.windows.length ? stateForWindows(descriptor, day, minute) : 'unknown';
}

export function marketSession(market, now = new Date(), options = {}) {
  const marketKind = normalizeMarketKind(market);
  const descriptor = REGISTRY[marketKind];
  const instant = now instanceof Date ? now : new Date(now);
  const parts = Number.isFinite(instant.getTime()) ? zonedParts(instant, descriptor.timezone) : null;
  const marketState = marketStateFromParts(marketKind, parts, options);
  const nextDelay = refreshDelayForState(marketState);
  return Object.freeze({
    market: marketKind,
    marketState,
    timezone: descriptor.timezone,
    expectedFreshnessMs: descriptor.expectedFreshnessMs,
    nextRefreshAt: Number.isFinite(instant.getTime()) ? new Date(instant.getTime() + nextDelay).toISOString() : null,
  });
}

export function refreshDelayForMarketKinds(markets, now = new Date()) {
  const states = Array.from(markets || []).map(market => marketSession(market, now).marketState);
  if (states.includes('open')) return MINUTE;
  if (states.includes('break')) return 3 * MINUTE;
  return 5 * MINUTE;
}
