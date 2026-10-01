import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeTencentQuoteTime, latestOfficialNavBase } from '../js/holdings-estimate.js';
import { calculateOverseasEstimate, validateOverseasEstimatePeriod, MAX_QUOTE_AGE_MS } from '../js/overseas-model.js';

const NOW = Date.parse('2026-09-30T14:00:00+08:00');
const TIME = '2026-09-30 14:00:00';
const model = (...codes) => ({ min_weight: 100, version: 'synthetic-timezone-v16', confidence: 'medium',
  legs: codes.map(code => ({ code, weight: 100 / codes.length })) });
const validPeriod = targetDate => ({ valid: true, targetDate, reason: '' });

test('cached time conversion preserves the real US winter, summer and DST-adjacent close golden values', () => {
  for (const [raw, expected] of [
    ['20260127160001', '2026-01-28 05:00:01'],
    ['20260727160001', '2026-07-28 04:00:01'],
    ['20260306160000', '2026-03-07 05:00:00'],
    ['20260309160000', '2026-03-10 04:00:00'],
    ['20261030160000', '2026-10-31 04:00:00'],
    ['20261102160000', '2026-11-03 05:00:00'],
  ]) {
    assert.equal(normalizeTencentQuoteTime(raw, 'usQQQ'), expected, raw);
    assert.equal(normalizeTencentQuoteTime(raw, 'usSPY'), expected, raw);
  }
});

test('cached JP and KR conversion preserves the exchange offset and China day or year rollover', () => {
  for (const [raw, code, expected] of [
    ['20260930150000', 'kr000660', TIME],
    ['20260930150000', 'jp7203', TIME],
    ['20260824003000', 'jp285A', '2026-08-23 23:30:00'],
    ['20260101003000', 'kr000660', '2025-12-31 23:30:00'],
    ['20260101003000', 'jp7203', '2025-12-31 23:30:00'],
    ['2026/09/30 14:00:00', 'r_hkHSTECH', TIME],
  ]) assert.equal(normalizeTencentQuoteTime(raw, code), expected, `${raw}:${code}`);
});

test('malformed source dates or local times remain missing after timezone formatter reuse', () => {
  for (const code of ['usQQQ', 'jp7203', 'kr000660']) {
    for (const raw of [null, '', '20260230140000', '20260930240000', '20260930146000', '20260930140060']) {
      assert.equal(normalizeTencentQuoteTime(raw, code), '', `${code}:${String(raw)}`);
    }
  }
});

test('US period dates bind to the exchange session in winter and summer, not the China overnight date', () => {
  for (const [raw, now, base, target] of [
    ['20260127160001', '2026-01-28T14:00:00+08:00', '2026-01-26', '2026-01-27'],
    ['20260727160001', '2026-07-28T14:00:00+08:00', '2026-07-24', '2026-07-27'],
  ]) {
    const quotes = { usQQQ: { change: 0, time: normalizeTencentQuoteTime(raw, 'usQQQ') } };
    assert.deepEqual(validateOverseasEstimatePeriod(model('usQQQ'), quotes, base, { now: Date.parse(now) }), validPeriod(target));
    assert.equal(validateOverseasEstimatePeriod(model('usQQQ'), quotes, target, { now: Date.parse(now) }).valid, false,
      'a published NAV that already includes this session cannot receive the same return again');
  }
});

test('JP midnight session uses its local date even when the China quote date is the previous day', () => {
  const quotes = { jp7203: { change: 1, time: normalizeTencentQuoteTime('20260930003000', 'jp7203') } };
  assert.equal(quotes.jp7203.time, '2026-09-29 23:30:00');
  assert.deepEqual(validateOverseasEstimatePeriod(model('jp7203'), quotes, '2026-09-29', { now: NOW }), validPeriod('2026-09-30'));
  assert.equal(validateOverseasEstimatePeriod(model('jp7203'), quotes, '2026-09-28', { now: NOW }).valid, false);
});

test('multiple legs retain strict NAV-base alignment and reject mixed exchange session dates', () => {
  const us = model('usQQQ', 'usSPY');
  const quotes = new Map([
    ['usQQQ', { change: 1, time: normalizeTencentQuoteTime('20260929160000', 'usQQQ') }],
    ['usSPY', { change: -1, time: normalizeTencentQuoteTime('20260929160000', 'usSPY') }],
  ]);
  assert.deepEqual(validateOverseasEstimatePeriod(us, quotes, '2026-09-28', { now: NOW }), validPeriod('2026-09-29'));
  assert.equal(calculateOverseasEstimate(us, quotes, NOW).change, 0);
  for (const base of ['2026-09-25', '2026-09-29', '2026-02-30', null]) {
    assert.equal(validateOverseasEstimatePeriod(us, quotes, base, { now: NOW }).valid, false, String(base));
  }
  const mixed = { min_weight: 50, legs: [{ code: 'usQQQ', weight: 50 }, { code: 'kr000660', weight: 50 }] };
  assert.equal(validateOverseasEstimatePeriod(mixed, { usQQQ: quotes.get('usQQQ'),
    kr000660: { change: 1, time: normalizeTencentQuoteTime('20260930150000', 'kr000660') } }, '2026-09-28', { now: NOW }).valid, false,
  'reaching min weight must not permit another leg with a different session to cross the NAV interval');
});

test('the original 36-hour boundary stays inclusive, while one extra millisecond or a future clock has no value', () => {
  assert.equal(MAX_QUOTE_AGE_MS, 36 * 60 * 60 * 1000);
  const sourceTime = normalizeTencentQuoteTime('20260928160000', 'usQQQ');
  assert.equal(sourceTime, '2026-09-29 04:00:00');
  const quoteMs = Date.parse(sourceTime.replace(' ', 'T') + '+08:00');
  const quotes = { usQQQ: { change: 0, time: sourceTime } }, m = model('usQQQ');
  const boundary = quoteMs + MAX_QUOTE_AGE_MS;
  assert.equal(calculateOverseasEstimate(m, quotes, boundary).change, 0);
  assert.deepEqual(validateOverseasEstimatePeriod(m, quotes, '2026-09-25', { now: boundary }), validPeriod('2026-09-28'));
  const expired = calculateOverseasEstimate(m, quotes, boundary + 1);
  assert.equal(expired.change, null);
  assert.equal(expired.usableWeight, 0);
  assert.equal(expired.rejected.stale, 1);
  assert.equal(validateOverseasEstimatePeriod(m, quotes, '2026-09-25', { now: boundary + 1 }).valid, false);
  const future = { usQQQ: { change: 0, time: '2026-09-30 14:00:01' } };
  assert.equal(calculateOverseasEstimate(m, future, NOW).change, null);
  assert.equal(calculateOverseasEstimate(m, future, NOW).rejected.future, 1);
  assert.equal(validateOverseasEstimatePeriod(m, future, '2026-09-29', { now: NOW }).valid, false);
});

test('an unidentified market cannot bind a next-NAV period even when its numeric quote and source clock are usable', () => {
  const result = validateOverseasEstimatePeriod(model('000660'), { '000660': { change: 0, time: TIME } }, '2026-09-29', { now: NOW });
  assert.deepEqual(result, { valid: false, targetDate: null, reason: '行情市场身份不明确' });
});

test('the production model-enrichment entry publishes no modeled value for unknown, future or mismatched periods', async () => {
  const source = await readFile(new URL('../js/runtime/fund-model-enrichment.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export function applyOverseasModelEstimate(')).replace(/^export /, '');
  assert.ok(body.startsWith('function applyOverseasModelEstimate('));
  for (const [code, sourceTime, base] of [
    ['000660', TIME, '2026-09-29'],
    ['usQQQ', '2026-09-30 14:00:01', '2026-09-29'],
    ['usQQQ', '2026-09-30 04:00:00', '2026-09-29'],
    ['usQQQ', '2026-09-30 04:00:00', '2026-09-25'],
  ]) {
    const m = model(code);
    // Only the clock and selected configuration are injected. All financial
    // computation, period validation and NAV selection are production code.
    const apply = new Function('chooseOverseasModel', 'calculateOverseasEstimate', 'validateOverseasEstimatePeriod',
      'latestOfficialNavBase', 'isUsableNav', 'fmt', `${body}\nreturn applyOverseasModelEstimate;`)(
      () => m, (selected, quotes) => calculateOverseasEstimate(selected, quotes, NOW),
      (selected, quotes, date) => validateOverseasEstimatePeriod(selected, quotes, date, { now: NOW }),
      latestOfficialNavBase, value => Number.isFinite(value) && value > 0, String,
    );
    const fund = { est_realtime: false, source_quote: { valueKind: 'official_nav', value: 2, officialNavDate: base } };
    apply(fund, { [code]: { changePct: 0, sourceTime } });
    assert.equal(fund.est_model, undefined, `${code}:${sourceTime}:${base}`);
    assert.equal(fund.est_nav, undefined);
    assert.equal(fund.est_change, undefined);
  }
});

test('repeated conversions and multi-leg period validation reuse one cached formatter per overseas timezone', () => {
  const NativeFormatter = Intl.DateTimeFormat;
  const constructed = [];
  Intl.DateTimeFormat = function(...args) {
    constructed.push(args[1]?.timeZone);
    return Reflect.construct(NativeFormatter, args);
  };
  const scenarios = [
    { prefix: 'us', raw: '20260929160000', expected: '2026-09-30 04:00:00', base: '2026-09-28', target: '2026-09-29' },
    { prefix: 'jp', raw: '20260930150000', expected: TIME, base: '2026-09-29', target: '2026-09-30' },
    { prefix: 'kr', raw: '20260930150000', expected: TIME, base: '2026-09-29', target: '2026-09-30' },
    { prefix: 'sh', raw: '20260930140000', expected: TIME, base: '2026-09-29', target: '2026-09-30' },
  ];
  const wave = () => {
    for (let repeat = 0; repeat < 12; repeat++) {
      for (const { prefix, raw, expected, base, target } of scenarios) {
        const codes = Array.from({ length: 8 }, (_, index) => prefix + (prefix === 'sh' ? String(600000 + index) : `S${index}`));
        assert.equal(normalizeTencentQuoteTime(raw, codes[0]), expected);
        const quotes = Object.fromEntries(codes.map(code => [code, { change: 0, time: expected }]));
        assert.deepEqual(validateOverseasEstimatePeriod(model(...codes), quotes, base, { now: NOW }), validPeriod(target));
      }
    }
  };
  try {
    wave();
    const initialCount = constructed.length;
    wave();
    assert.ok(initialCount <= 3, `first wave constructed ${initialCount} formatters instead of reusing at most three timezones`);
    assert.equal(constructed.length - initialCount, 0, 'a warm repeated wave must construct no additional Intl formatters');
    assert.ok(constructed.every(timezone => ['America/New_York', 'Asia/Tokyo', 'Asia/Seoul'].includes(timezone)));
  } finally { Intl.DateTimeFormat = NativeFormatter; }
});
