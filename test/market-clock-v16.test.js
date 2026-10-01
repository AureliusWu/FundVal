import test from 'node:test';
import assert from 'node:assert/strict';
import { chinaDateKey, chinaTimeParts, marketClock } from '../js/runtime/market-clock.js';

const calendar = {
  version: 'synthetic-calendar-2026', valid_from: '2026-01-01', valid_until: '2026-12-31',
  holidays: ['2026-10-01'], early_closes: {},
};

test('one China clock handles UTC midnight boundaries, month/year and invalid instants', () => {
  assert.equal(chinaDateKey(Date.parse('2026-09-30T15:59:59.999Z')), '2026-09-30');
  assert.equal(chinaDateKey(Date.parse('2026-09-30T16:00:00.000Z')), '2026-10-01');
  assert.equal(chinaDateKey(Date.parse('2026-12-31T16:00:00.000Z')), '2027-01-01');
  assert.equal(chinaDateKey(NaN), null);
  assert.equal(chinaDateKey(null), null);
  assert.deepEqual(chinaTimeParts(Date.parse('2026-09-30T16:00:00Z')), { dateKey: '2026-10-01', weekday: 4, hour: 0, minute: 0, second: 0 });
});

test('a verified holiday overrides weekday opening hours', () => {
  const session = marketClock('cn', Date.parse('2026-10-01T10:00:00+08:00'), { calendar });
  assert.equal(session.marketState, 'holiday');
  assert.equal(session.calendarStatus, 'valid');
  assert.equal(session.isTradingDay, false);
});

test('expired, future or missing calendars cannot confidently label a weekday as open', () => {
  for (const input of [null, { ...calendar, valid_until: '2026-09-30' }, { ...calendar, valid_from: '2026-10-02' }]) {
    const session = marketClock('cn', Date.parse('2026-10-01T10:00:00+08:00'), { calendar: input });
    assert.equal(session.marketState, 'unknown');
    assert.equal(session.isTradingDay, null);
    assert.ok(session.reasonCodes.includes('MARKET_CALENDAR_UNVERIFIED'));
  }
});

test('exchange-local dates and DST are independent of the China calendar date', () => {
  const us = marketClock('us', Date.parse('2026-10-01T01:30:00+08:00'), { calendar: { ...calendar, holidays: [] } });
  assert.equal(us.dateKey, '2026-09-30');
  assert.equal(us.marketState, 'open');
  const winter = marketClock('us', Date.parse('2026-01-28T00:00:00+08:00'), { calendar: { ...calendar, holidays: [] } });
  assert.equal(winter.dateKey, '2026-01-27');
  assert.equal(winter.marketState, 'open');
});

test('verified early closes shorten the regular session without inventing holiday status', () => {
  const us = marketClock('us', Date.parse('2026-11-27T18:01:00Z'), { calendar: { ...calendar, holidays: [], early_closes: { '2026-11-27': 13 * 60 } } });
  assert.equal(us.marketState, 'closed');
  assert.equal(us.calendarStatus, 'valid');
});
