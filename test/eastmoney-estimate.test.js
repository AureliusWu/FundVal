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

test('loads multiple fund codes through the server-side estimate proxy', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input) => {
    requests += 1;
    const url = new URL(input);
    assert.equal(url.searchParams.get('codes'), '110011,000001');
    return new Response(JSON.stringify({ items: [
      { code: '000001', name: 'A', est_nav: 1, est_change: 1, est_time: '2026-07-22' },
      { code: '110011', name: 'B', est_nav: 2, est_change: -1, est_time: '2026-07-22' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await fetchEstimateRows(['110011', '000001']);
    assert.equal(result.get('000001').est_change, 1);
    assert.equal(result.get('110011').est_change, -1);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps requested codes missing when the proxy returns a partial batch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [
    { code: '000001', est_nav: 1, est_change: 0, est_time: '2026-07-22' },
  ] }), { status: 200 });
  try {
    const result = await fetchEstimateRows(['000001', '000002']);
    assert.equal(result.get('000001').est_change, 0);
    assert.equal(result.get('000002'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fails explicitly when the estimate proxy is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('upstream unavailable', { status: 502 });
  try {
    await assert.rejects(fetchEstimateRows(['000001']), /HTTP 502/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
