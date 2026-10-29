import { MARKET_SESSION_REGISTRY, marketStateFromParts, normalizeMarketKind } from './market-session.js';
import { nextWeekdayDate, normalizeQuoteDate } from './quote-contract.js';
import calendarDocument from '../../data/market-calendars.json' with { type: 'json' };

let calendars = Object.freeze({});
const formatters = new Map();

function instant(value) {
  const number = value instanceof Date ? value.getTime() : value;
  return typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 8.64e15 ? number : null;
}

export function chinaTimeParts(now = Date.now()) {
  const timestamp = instant(now);
  if (timestamp == null) return null;
  const date = new Date(timestamp + 8 * 3600000);
  if (!Number.isFinite(date.getTime())) return null;
  return { dateKey: date.toISOString().slice(0, 10), weekday: date.getUTCDay(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}

export function chinaDateKey(now = Date.now()) {
  return chinaTimeParts(now)?.dateKey || null;
}

export function zonedTimeParts(now, timezone) {
  if (timezone === 'Asia/Shanghai' || timezone === 'Asia/Hong_Kong') return chinaTimeParts(now);
  const timestamp = instant(now);
  if (timestamp == null) return null;
  try {
    if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
    const parts = Object.fromEntries(formatters.get(timezone).formatToParts(new Date(timestamp)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, weekday: ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[parts.weekday], hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
  } catch (_) { return null; }
}

function validCalendar(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.version !== 'string' || !value.version.trim()) return false;
  const start = normalizeQuoteDate(value.valid_from);
  const end = normalizeQuoteDate(value.valid_until);
  if (!start || !end || start > end || !Array.isArray(value.holidays) || value.holidays.length > 400) return false;
  if (value.holidays.some(date => !normalizeQuoteDate(date) || date < start || date > end) || new Set(value.holidays).size !== value.holidays.length) return false;
  const closes = value.early_closes;
  if (!closes || typeof closes !== 'object' || Array.isArray(closes) || Object.keys(closes).length > 100) return false;
  return Object.entries(closes).every(([date, minute]) => normalizeQuoteDate(date) && date >= start && date <= end && Number.isInteger(minute) && minute > 0 && minute < 1440);
}

export function installMarketCalendars(document) {
  if (!document || typeof document.version !== 'string' || !document.calendars || typeof document.calendars !== 'object' || Array.isArray(document.calendars)) return false;
  const entries = Object.entries(document.calendars);
  if (entries.some(([market, calendar]) => !MARKET_SESSION_REGISTRY[market] || !validCalendar(calendar))) return false;
  calendars = Object.freeze(Object.fromEntries(entries.map(([market, calendar]) => [market, Object.freeze({ ...calendar, holidays: Object.freeze([...calendar.holidays]), early_closes: Object.freeze({ ...calendar.early_closes }) })])));
  return true;
}

// Internal calendars are validated once and copied before freezing. Explicit
// caller overrides remain untrusted and are independently checked per call.
installMarketCalendars(calendarDocument);

export async function loadMarketCalendars({ request = globalThis.fetch, signal } = {}) {
  try {
    const response = await request('./data/market-calendars.json', { signal, cache: 'no-cache' });
    return response.ok && installMarketCalendars(await response.json());
  } catch (_) { return false; }
}

// This is the production session boundary. marketSession remains the legacy
// heuristic API for compatibility tests; no heuristic may assert a verified
// trading day when the exchange-specific calendar is absent or expired.
export function marketClock(market, now = Date.now(), options = {}) {
  const kind = normalizeMarketKind(market);
  const descriptor = MARKET_SESSION_REGISTRY[kind];
  const timestamp = instant(now);
  const parts = zonedTimeParts(timestamp, descriptor.timezone);
  const override = Object.hasOwn(options, 'calendar');
  const calendar = override ? options.calendar : calendars[kind];
  const verified = Boolean(parts && calendar && (!override || validCalendar(calendar)) && parts.dateKey >= calendar.valid_from && parts.dateKey <= calendar.valid_until);
  let marketState = verified ? marketStateFromParts(kind, parts, { holidays: calendar.holidays }) : 'unknown';
  const minute = parts ? parts.hour * 60 + parts.minute : null;
  if (verified && calendar.early_closes[parts.dateKey] != null && minute >= calendar.early_closes[parts.dateKey] && !['holiday', 'closed'].includes(marketState)) marketState = 'closed';
  const weekend = parts && [0, 6].includes(parts.weekday);
  const delay = marketState === 'open' ? 60000 : marketState === 'break' ? 180000 : 300000;
  return Object.freeze({ market: kind, marketState, timezone: descriptor.timezone, expectedFreshnessMs: descriptor.expectedFreshnessMs,
    nextRefreshAt: timestamp == null ? null : new Date(timestamp + delay).toISOString(), dateKey: parts?.dateKey || null, minute,
    calendarStatus: verified ? 'valid' : 'unverified', calendarVersion: verified ? calendar.version : null,
    isTradingDay: verified ? !weekend && marketState !== 'holiday' : null,
    reasonCodes: Object.freeze(verified ? [] : ['MARKET_CALENDAR_UNVERIFIED']),
  });
}

export function marketRefreshDelay(markets, now = Date.now()) {
  const states = Array.from(markets || [], market => marketClock(market, now).marketState);
  return states.includes('open') ? 60000 : states.includes('break') ? 180000 : 300000;
}

// Never bridge a missing weekday with a one-session move. A verified exchange
// holiday additionally rules out an otherwise adjacent weekday pair.
export function isSingleMarketSession(baseDate, targetDate, market) {
  const base = normalizeQuoteDate(baseDate);
  const target = normalizeQuoteDate(targetDate);
  if (!base || !target || [0, 6].includes(new Date(`${base}T00:00:00Z`).getUTCDay()) || nextWeekdayDate(base) !== target) return false;
  const calendar = calendars[normalizeMarketKind(market)];
  if (calendar && base >= calendar.valid_from && target <= calendar.valid_until) {
    return !calendar.holidays.includes(base) && !calendar.holidays.includes(target);
  }
  return !market || normalizeMarketKind(market) === 'unknown';
}
