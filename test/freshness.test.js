import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFreshness, classifyFundMarket, marketState, MAX_FUTURE_SOURCE_SKEW_MS, parseChinaSourceTime, refreshDelayForMarkets } from '../js/freshness.js';

test('parses upstream China time without replacing it with request time', () => {
  assert.equal(new Date(parseChinaSourceTime('2026-07-22 14:31')).toISOString(), '2026-07-22T06:31:00.000Z');
});

test('distinguishes markets and their refresh windows', () => {
  assert.equal(classifyFundMarket('恒生科技ETF'), 'hk');
  assert.equal(classifyFundMarket('纳斯达克100 QDII'), 'overseas');
  assert.equal(classifyFundMarket('沪深300指数'), 'cn-index');
  const chinaOpen = new Date('2026-07-22T02:00:00Z');
  assert.equal(refreshDelayForMarkets(['cn'], chinaOpen), 60_000);
  assert.equal(refreshDelayForMarkets(['overseas'], chinaOpen), 300_000);
});

test('labels stale, model, official and unavailable data explicitly', () => {
  const now = Date.parse('2026-07-22T06:35:00Z');
  assert.equal(buildFreshness({ sourceTime: '2026-07-22 14:34', source: 'tiantian', market: 'cn' }, now).label, '实时');
  assert.equal(buildFreshness({ sourceTime: '2026-07-21 14:34', source: 'cache', market: 'cn' }, now).label, '旧数据');
  assert.equal(buildFreshness({ sourceTime: '2026-07-22', source: 'eastmoney-table', market: 'cn' }, now).label, '延迟');
  assert.equal(buildFreshness({ sourceTime: null, source: 'model', model: true }, now).label, '模型估算');
  assert.equal(buildFreshness({ sourceTime: '2026-07-21', source: 'official', official: true }, now).label, '最新正式净值');
  assert.equal(buildFreshness({ sourceTime: null, source: 'none', unavailable: true }, now).label, '暂不可估值');
});

test('does not label source timestamps more than five minutes in the future as realtime', () => {
  const now = Date.parse('2026-07-22T06:30:00Z');
  const withinSkew = buildFreshness({ sourceTime: '2026-07-22 14:35', source: 'quote', market: 'cn' }, now);
  const future = buildFreshness({ sourceTime: '2026-07-22 14:36', source: 'quote', market: 'cn' }, now);

  assert.equal(withinSkew.status, 'fresh');
  assert.equal(future.status, 'stale');
  assert.equal(future.label, '时间异常');
  assert.equal(future.ageSeconds, null);
  assert.equal(future.sourceTimeInFuture, true);
  assert.equal(MAX_FUTURE_SOURCE_SKEW_MS, 5 * 60 * 1000);
});

test('uses the overseas exchange calendar instead of China weekend for US market refreshes', () => {
  // Friday 12:00 in New York is Saturday 00:00 in China during daylight saving time.
  const duringUsSession = new Date('2026-08-07T16:00:00Z');
  assert.equal(marketState('overseas', duringUsSession), 'open');
  assert.equal(refreshDelayForMarkets(['overseas'], duringUsSession), 60_000);
  assert.equal(marketState('overseas', new Date('2026-08-07T21:00:00Z')), 'closed');
});
