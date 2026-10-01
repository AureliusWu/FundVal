import test from 'node:test';
import assert from 'node:assert/strict';
import calendarDocument from '../data/market-calendars.json' with { type: 'json' };
import { installMarketCalendars, marketClock } from '../js/runtime/market-clock.js';
import { marketSession } from '../js/runtime/market-session.js';
import { normalizeEstimateQuote } from '../js/runtime/quote-normalizer.js';

const calendar = () => ({
  version: 'synthetic-clock-2026', valid_from: '2026-01-01', valid_until: '2026-12-31',
  holidays: [], early_closes: {},
});

function formatterCounter(t) {
  const Original = Intl.DateTimeFormat;
  let calls = 0;
  t.mock.method(Intl, 'DateTimeFormat', function(...args) {
    calls += 1;
    return new Original(...args);
  });
  return () => calls;
}

test('repeated China clock calls do not construct Intl formatters', t => {
  const now = Date.parse('2026-09-30T02:00:00Z');
  marketClock('cn', now);
  const calls = formatterCounter(t);
  for (let index = 0; index < 32; index += 1) {
    const state = marketClock('cn', now + index * 1000);
    assert.equal(state.marketState, 'open');
    assert.equal(state.dateKey, '2026-09-30');
    assert.equal(state.minute, 600);
  }
  assert.equal(calls(), 0);
});

test('warm US clock reuses its exchange formatter across winter and summer', t => {
  const winter = Date.parse('2026-01-27T14:30:00Z');
  const summer = Date.parse('2026-08-25T13:30:00Z');
  marketClock('us', winter);
  const calls = formatterCounter(t);
  for (let index = 0; index < 32; index += 1) {
    const state = marketClock('us', index % 2 ? winter : summer);
    assert.equal(state.marketState, 'open');
    assert.equal(state.minute, 570);
    assert.equal(state.timezone, 'America/New_York');
  }
  assert.equal(calls(), 0);
});

test('installed immutable calendars are not reparsed on every clock call', t => {
  assert.equal(installMarketCalendars(calendarDocument), true);
  const now = Date.parse('2026-09-30T02:00:00Z');
  const parse = t.mock.method(Date, 'parse');
  for (let index = 0; index < 32; index += 1) {
    assert.equal(marketClock('cn', now).calendarStatus, 'valid');
  }
  assert.equal(parse.mock.calls.length, 0);
});

test('legacy session and verified clock preserve market states and refresh deadlines', () => {
  const cases = [
    ['cn', '2026-08-25T01:20:00Z', 'preopen'],
    ['cn', '2026-08-25T02:00:00Z', 'open'],
    ['cn', '2026-08-25T04:00:00Z', 'break'],
    ['cn', '2026-08-25T07:00:00Z', 'closed'],
    ['hk', '2026-08-25T07:00:00Z', 'open'],
    ['jp', '2026-08-25T03:00:00Z', 'break'],
    ['kr', '2026-08-25T00:30:00Z', 'open'],
    ['us', '2026-03-06T14:30:00Z', 'open'],
    ['us', '2026-03-09T13:30:00Z', 'open'],
    ['us', '2026-11-06T14:30:00Z', 'open'],
    ['gold', '2026-08-28T17:00:00Z', 'open'],
    ['gold', '2026-08-29T19:00:00Z', 'closed'],
  ];
  for (const [market, source, expected] of cases) {
    const now = Date.parse(source);
    const legacy = marketSession(market, new Date(now));
    const current = marketClock(market, now, { calendar: calendar() });
    assert.equal(legacy.marketState, expected, `${market} ${source}`);
    for (const field of ['market', 'marketState', 'timezone', 'expectedFreshnessMs', 'nextRefreshAt']) {
      assert.equal(current[field], legacy[field], `${market} ${source} ${field}`);
    }
  }
  const options = { calendar: { ...calendar(), holidays: ['2026-10-01'] } };
  const now = Date.parse('2026-10-01T02:00:00Z');
  assert.equal(marketClock('cn', now, options).marketState, 'holiday');
  assert.equal(marketSession('cn', now, { holidays: options.calendar.holidays }).marketState, 'holiday');
});

test('calendar overrides are revalidated after mutation, and early closes remain bounded', () => {
  const input = calendar();
  const now = Date.parse('2026-11-27T18:00:00Z');
  input.early_closes['2026-11-27'] = 780;
  assert.equal(marketClock('us', now, { calendar: input }).marketState, 'closed');
  input.early_closes['2026-11-27'] = 1440;
  assert.equal(marketClock('us', now, { calendar: input }).calendarStatus, 'unverified');
  input.early_closes['2026-11-27'] = 780;
  input.holidays.push('not-a-date');
  const state = marketClock('us', now, { calendar: input });
  assert.equal(state.marketState, 'unknown');
  assert.equal(state.isTradingDay, null);
  assert.ok(state.reasonCodes.includes('MARKET_CALENDAR_UNVERIFIED'));
});

test('installed calendar copies are immune to caller mutation and invalid replacement', () => {
  const input = structuredClone(calendarDocument);
  assert.equal(installMarketCalendars(input), true);
  try {
    const now = Date.parse('2026-09-30T02:00:00Z');
    input.calendars.cn.holidays.push('2026-09-30');
    input.calendars.cn.early_closes['2026-09-30'] = 1;
    input.calendars.cn.valid_until = '2026-01-01';
    assert.equal(marketClock('cn', now).marketState, 'open');
    assert.equal(installMarketCalendars(input), false);
    assert.equal(marketClock('cn', now).marketState, 'open');
    const expired = marketClock('cn', Date.parse('2027-01-04T02:00:00Z'));
    assert.equal(expired.calendarStatus, 'unverified');
    assert.equal(expired.isTradingDay, null);
  } finally {
    installMarketCalendars(calendarDocument);
  }
});

test('Friday quote carryover shares the clock formatter and stays exchange-local', t => {
  const row = {
    code: '000001', name: 'Synthetic US fund', est_nav: 1.1, est_change: 0,
    est_time: '2026-08-28T16:00:00-04:00', est_realtime: false,
  };
  const weekend = Date.parse('2026-08-30T00:00:00Z');
  marketClock('us', weekend);
  const calls = formatterCounter(t);
  for (let index = 0; index < 16; index += 1) {
    const quote = normalizeEstimateQuote(row, { market: 'us', now: weekend });
    assert.equal(quote.status, 'delayed');
    assert.equal(quote.changePct, 0);
    assert.ok(!quote.reasonCodes.includes('SOURCE_TIME_EXPIRED'));
  }
  assert.equal(calls(), 0);
  const monday = normalizeEstimateQuote(row, { market: 'us', now: Date.parse('2026-08-31T14:00:00Z') });
  assert.equal(monday.status, 'stale');
  assert.ok(monday.reasonCodes.includes('SOURCE_TIME_EXPIRED'));
});
