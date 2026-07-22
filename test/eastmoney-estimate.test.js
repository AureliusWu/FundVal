import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEstimateRows, normalizeEstimateRow } from '../js/eastmoney-estimate.js';

test('normalizes current estimate table values without inventing a quote minute', () => {
  const result = normalizeEstimateRow({
    bzdm: '000001', jjjc: '华夏成长混合', FType: '混合型-灵活',
    dwjz: '1.4450', gsz: '1.4461', gszzl: '0.08%', gzrq: '2026-07-21', gxrq: '2026-07-22',
  });
  assert.equal(result.est_change, 0.08);
  assert.equal(result.est_time, '2026-07-22');
  assert.equal(result.source_time_precision, 'date');
  assert.equal(result.est_realtime, false);
});

test('keeps missing estimate values missing', () => {
  const result = normalizeEstimateRow({ bzdm: '000001', gsz: '--', gszzl: '--' });
  assert.equal(Number.isNaN(result.est_nav), true);
  assert.equal(Number.isNaN(result.est_change), true);
});

test('finds multiple fund codes through fresh paged JSONP requests', async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let requests = 0;
  globalThis.window = {};
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: {
      appendChild(script) {
        requests += 1;
        const url = new URL(script.src);
        const callback = url.searchParams.get('callback');
        const page = Number(url.searchParams.get('pageIndex'));
        const list = page === 1
          ? [{ bzdm: '000001', jjjc: 'A', gsz: '1', gszzl: '1%', gxrq: '2026-07-22' }]
          : [{ bzdm: '110011', jjjc: 'B', gsz: '2', gszzl: '-1%', gxrq: '2026-07-22' }];
        setTimeout(() => globalThis.window[callback]({ ErrCode: 0, TotalCount: 101, Data: { list } }), 0);
      },
    },
  };
  try {
    const result = await fetchEstimateRows(['110011', '000001']);
    assert.equal(result.get('000001').est_change, 1);
    assert.equal(result.get('110011').est_change, -1);
    assert.equal(requests, 2);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});
