import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAssetKind,
  classifyMarketKind,
  marketSession,
  normalizeMarketKind,
  refreshDelayForMarketKinds,
} from '../js/runtime/market-session.js';

test('classifies canonical markets without collapsing JP, KR and generic QDII into US', () => {
  assert.equal(classifyMarketKind('沪深300指数增强'), 'cn');
  assert.equal(classifyMarketKind('恒生科技ETF'), 'hk');
  assert.equal(classifyMarketKind('纳斯达克100(QDII)'), 'us');
  assert.equal(classifyMarketKind('日经225 ETF'), 'jp');
  assert.equal(classifyMarketKind('韩国综合指数基金'), 'kr');
  assert.equal(classifyMarketKind('全球精选(QDII)'), 'qdii');
  assert.equal(classifyMarketKind('黄金ETF'), 'gold');
  assert.equal(classifyAssetKind('沪深300指数增强', 'cn'), 'index_fund');
  assert.equal(classifyAssetKind('全球精选(QDII)', 'qdii'), 'qdii_fund');
  assert.equal(normalizeMarketKind('overseas'), 'us');
});

test('returns open, break, preopen and closed states in exchange-local time', () => {
  assert.equal(marketSession('cn', new Date('2026-08-25T02:00:00Z')).marketState, 'open');
  assert.equal(marketSession('cn', new Date('2026-08-25T04:00:00Z')).marketState, 'break');
  assert.equal(marketSession('cn', new Date('2026-08-25T01:20:00Z')).marketState, 'preopen');
  assert.equal(marketSession('hk', new Date('2026-08-25T07:00:00Z')).marketState, 'open');
  assert.equal(marketSession('us', new Date('2026-08-25T14:00:00Z')).marketState, 'open');
  assert.equal(marketSession('jp', new Date('2026-08-25T00:30:00Z')).marketState, 'open');
  assert.equal(marketSession('kr', new Date('2026-08-25T00:30:00Z')).marketState, 'open');
});

test('handles Shanghai Gold Exchange day/night sessions and explicit holidays', () => {
  assert.equal(marketSession('gold', new Date('2026-08-25T13:00:00Z')).marketState, 'open');
  assert.equal(marketSession('gold', new Date('2026-08-28T17:00:00Z')).marketState, 'open');
  assert.equal(marketSession('gold', new Date('2026-08-29T19:00:00Z')).marketState, 'closed');
  assert.equal(marketSession('cn', new Date('2026-08-25T02:00:00Z'), { holidays: ['2026-08-25'] }).marketState, 'holiday');
});

test('keeps generic QDII market state unknown and emits a bounded next refresh', () => {
  const session = marketSession('qdii', new Date('2026-08-25T02:00:00Z'));
  assert.equal(session.marketState, 'unknown');
  assert.equal(session.expectedFreshnessMs, 36 * 60 * 60 * 1000);
  assert.equal(session.nextRefreshAt, '2026-08-25T02:05:00.000Z');
  assert.equal(refreshDelayForMarketKinds(['qdii'], new Date('2026-08-25T02:00:00Z')), 5 * 60 * 1000);
});
