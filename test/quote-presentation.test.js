import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createQuotePresentation,
  formatQuoteDataTime,
  quoteConfidenceLabel,
  quoteCoverageLabel,
  quoteReasonSummary,
} from '../js/runtime/quote-presentation.js';

const NOW = Date.parse('2026-08-27T14:30:00+08:00');

test('binds a realtime quote to its source time without inventing coverage', () => {
  const view = createQuotePresentation({
    status: 'realtime',
    valueKind: 'intraday_estimate',
    observedAt: '2026-08-27 14:21:08',
    fetchedAt: '2026-08-27T06:21:12.000Z',
    sourceId: 'sinan-estimate-proxy',
    market: 'cn',
    coverage: null,
    confidence: null,
  }, { now: NOW });

  assert.equal(view.kindLabel, '盘中估值');
  assert.equal(view.statusLabel, '实时');
  assert.equal(view.dataTimeLabel, '14:21');
  assert.equal(view.trustText, '');
  assert.equal(view.sourceLabel, '盘中估值服务');
});

test('shows model coverage, confidence, version and the explicit next-NAV meaning', () => {
  const view = createQuotePresentation({
    status: 'model',
    valueKind: 'model_estimate',
    observedAt: '2026-08-27 10:46:00',
    fetchedAt: '2026-08-27T02:46:05.000Z',
    officialNavDate: '2026-08-25',
    sourceId: 'market-model',
    market: 'qdii',
    coverage: 82.04,
    confidence: 'medium',
    modelVersion: '2026Q2-v1',
  }, { now: NOW });

  assert.equal(view.dataTimeLabel, '10:46');
  assert.equal(view.trustText, '覆盖率 82% · 置信度 中');
  assert.equal(view.targetNavLabel, '下一公布日（基于 2026-08-25 正式净值）');
  assert.equal(view.modelVersion, '2026Q2-v1');
});

test('official NAV uses its date and never the fetch clock as the displayed time', () => {
  const view = createQuotePresentation({
    status: 'official',
    valueKind: 'official_nav',
    observedAt: null,
    fetchedAt: '2026-08-27T06:30:00.000Z',
    officialNavDate: '2026-08-26',
    sourceId: 'eastmoney-official-nav',
    market: 'qdii',
  }, { now: NOW });

  assert.equal(view.dataTimeLabel, '2026-08-26');
  assert.equal(view.statusLabel, '正式净值');
  assert.equal(view.trustText, '基金公司已公布');
  assert.notEqual(view.dataTimeLabel, '14:30');
});

test('stale and unavailable quotes explain degradation and keep missing values semantic', () => {
  const stale = createQuotePresentation({
    status: 'stale',
    valueKind: 'intraday_estimate',
    observedAt: '2026-08-26 15:00:00',
    fetchedAt: '2026-08-27T06:30:00.000Z',
    sourceId: 'local-cache',
    market: 'cn',
    reasonCodes: ['refresh_failed', 'cached_from_sinan_estimate_proxy'],
  }, { now: NOW });
  const unavailable = createQuotePresentation(null, { now: NOW });

  assert.equal(stale.dataTimeLabel, '昨日 15:00');
  assert.equal(stale.reasonSummary, '本轮刷新失败，保留上次结果；当前显示来自本地缓存');
  assert.equal(unavailable.kindLabel, '暂不可估值');
  assert.equal(unavailable.dataTimeLabel, '--');
  assert.equal(unavailable.trustText, '无可用数据源');
});

test('formats confidence, coverage and reason codes without turning missing into zero', () => {
  assert.equal(quoteConfidenceLabel(null), '未知');
  assert.equal(quoteConfidenceLabel(0), '低');
  assert.equal(quoteConfidenceLabel(0.8), '高');
  assert.equal(quoteCoverageLabel(null), '未知');
  assert.equal(quoteCoverageLabel(0), '0%');
  assert.equal(quoteCoverageLabel(82.55), '82.6%');
  assert.equal(quoteReasonSummary([], 'unavailable'), '无可用数据源');
  assert.equal(formatQuoteDataTime({ observedAt: null }, { now: NOW }), '--');
});

test('explains expired and missing source time without claiming there is no reason', () => {
  assert.equal(quoteReasonSummary(['source_time_expired'], 'stale'), '行情时间已过期');
  assert.equal(quoteReasonSummary(['source_time_missing'], 'stale'), '数据源未提供行情时间，无法确认新鲜度');
});
