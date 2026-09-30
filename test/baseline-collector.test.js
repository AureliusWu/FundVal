import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequest, parseCoverage, parseNodeSummary, timingSummary } from '../scripts/collect-baseline.mjs';

test('baseline parsing preserves missing evidence and the original Node test totals', () => {
  assert.deepEqual(parseNodeSummary('ℹ tests 410\nℹ suites 0\nℹ pass 410\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 1234.5\n'), {
    tests: 410, suites: 0, pass: 410, fail: 0, cancelled: 0, skipped: 0, todo: 0, duration_ms: 1234.5,
  });
  assert.equal(parseNodeSummary('').tests, null);
  assert.equal(parseCoverage('').line, null);
  assert.equal(parseCoverage('').status, 'UNAVAILABLE');
  const coverage = parseCoverage('ℹ notification-controller.js | 22.58 | 50.00 | 66.67 |\nℹ all files | 89.83 | 76.80 | 92.57 |\n');
  assert.equal(coverage.line, 89.83);
  assert.equal(coverage.modules[0].line, 22.58);
  assert.match(coverage.scope, /unimported modules are not included/);
});

test('baseline timing never claims a stable p95 from three runs', () => {
  assert.deepEqual(timingSummary([{ ms: 3 }, { ms: 1 }, { ms: 2 }, { ms: null }], 'ms'), {
    samples: 3, median: 2, maximum: 3, p95: null, p95Reason: 'Three observations do not support a stable p95 estimate.',
  });
  assert.equal(timingSummary([], 'ms'), null);
});

test('network counters distinguish stable data, batched quotes and cloud writes', () => {
  assert.equal(classifyRequest('http://127.0.0.1:4173/__fundval_dev/estimates?codes=005844'), 'estimateBatch');
  assert.equal(classifyRequest('https://sinan-estimate-push.ligugu69.workers.dev/holdings?code=005844'), 'holdingsSnapshot');
  assert.equal(classifyRequest('https://fund.eastmoney.com/pingzhongdata/005844.js?v=1'), 'officialNav');
  assert.equal(classifyRequest('https://qt.gtimg.cn/q=sz000001&_t=1'), 'securityQuotes');
  assert.equal(classifyRequest('https://qt.gtimg.cn/q=sh000001,usNDX&_t=1'), 'indexQuotes');
  assert.equal(classifyRequest('https://api.github.com/gists/example', 'PATCH'), 'gistWrite');
  assert.equal(classifyRequest('https://unknown.invalid/index.html'), 'otherExternalBlocked');
});
