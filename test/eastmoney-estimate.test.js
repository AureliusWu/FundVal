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
  const result = normalizeEstimateRow({ bzdm: '000001', dwjz: null, gsz: '--', gszzl: '--', coverage: null });
  assert.equal(Number.isNaN(result.last_nav), true);
  assert.equal(Number.isNaN(result.est_nav), true);
  assert.equal(Number.isNaN(result.est_change), true);
  assert.equal(Number.isNaN(result.coverage), true);
  assert.equal(result.source_quote.value, null);
  assert.equal(result.source_quote.changePct, null);
  assert.equal(result.source_quote.status, 'unavailable');
  assert.equal(result.status, 'error');
});

test('preserves an explicit unavailable proxy response for the fallback chain', () => {
  const result = normalizeEstimateRow({
    bzdm: '000001', status: 'unavailable', message: 'upstream empty', gsz: 1, gszzl: 0,
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.source_status, 'unavailable');
  assert.equal(result.message, 'upstream empty');
});

test('attaches the unified source quote without dropping a legal zero change', () => {
  const result = normalizeEstimateRow({
    code: '000001', name: '测试基金', est_nav: 1, est_change: 0,
    est_time: '2026-08-25 10:04', est_realtime: true, source: 'sinan-estimate-proxy',
  }, { fetchedAt: '2026-08-25T02:04:30Z', now: Date.parse('2026-08-25T02:05:00Z') });
  assert.equal(result.source_quote.changePct, 0);
  assert.equal(result.source_quote.observedAt, '2026-08-25 10:04');
  assert.equal(result.source_quote.fetchedAt, '2026-08-25T02:04:30.000Z');
  assert.equal(result.source_quote.status, 'realtime');
});

test('preserves the official NAV fallback semantics on non-trading days', () => {
  const result = normalizeEstimateRow({
    code: '000001',
    last_nav: 1,
    est_nav: 1.02,
    est_change: 2,
    nav_date: '2026-07-23',
    est_time: '2026-07-24',
    est_kind: 'official_nav',
    est_label: '最近净值',
    est_realtime: false,
    est_note: '盘中估值不可用；展示最近两个已公布正式净值的涨跌',
    source: 'eastmoney_official_nav',
  });
  assert.equal(result.est_kind, 'official_nav');
  assert.equal(result.est_label, '最近净值');
  assert.equal(result.est_realtime, false);
  assert.equal(result.est_time, '2026-07-24');
  assert.equal(result.source, 'eastmoney_official_nav');
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

test('honors caller cancellation instead of waiting for its own timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const controller = new AbortController();
  try {
    const pending = fetchEstimateRows(['000001'], { signal: controller.signal });
    controller.abort('superseded');
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reports its own deadline as a timeout source failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('native abort');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  try {
    await assert.rejects(fetchEstimateRows(['000001'], { timeout: 1 }), {
      name: 'TimeoutError', code: 'REQUEST_TIMEOUT',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
