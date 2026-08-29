import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFundHoldings, normalizeHoldingRow } from '../js/fund-holdings.js';

test('normalizes a disclosed holding without coercing missing ratios to zero', () => {
  assert.deepEqual(normalizeHoldingRow({ code: '688361', name: '中科飞测', ratio: '9.55' }), {
    code: '688361',
    name: '中科飞测',
    ratio: 9.55,
  });
  assert.equal(normalizeHoldingRow({ code: '688361', name: '中科飞测', ratio: null }), null);
});

test('rejects malformed or executable holdings fields before they reach rendering', () => {
  for (const row of [
    { code: '<img src=x onerror=alert(1)>', name: '污染代码', ratio: 1 },
    { code: '688361', name: '<svg onload=alert(1)>', ratio: 1 },
    { code: '688361', name: '中科\u0000飞测', ratio: 1 },
    { code: '688361', name: '中科飞测', ratio: -0.1 },
    { code: '688361', name: '中科飞测', ratio: 100.1 },
    { code: '688361', name: '中科飞测', ratio: Infinity },
  ]) {
    assert.equal(normalizeHoldingRow(row), null);
  }

  assert.deepEqual(normalizeHoldingRow({ code: '00700', name: '腾讯控股', ratio: 8.25 }), {
    code: '00700', name: '腾讯控股', ratio: 8.25,
  });
  assert.deepEqual(normalizeHoldingRow({ code: 'BRK.B', name: 'Berkshire Hathaway', ratio: 3.5 }), {
    code: 'BRK.B', name: 'Berkshire Hathaway', ratio: 3.5,
  });
});

test('ignores unexpected rows and never returns more than ten validated holdings', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => Response.json({
    report_date: '2026-06-30',
    items: [
      { code: '<img src=x onerror=alert(1)>', name: '污染代码', ratio: 9 },
      ...Array.from({ length: 12 }, (_, index) => ({
        code: String(600000 + index), name: `测试股票${index}`, ratio: index + 0.5,
      })),
    ],
  });
  try {
    const result = await fetchFundHoldings('005844');
    assert.equal(result.status, 'ok');
    assert.equal(result.items.length, 10);
    assert.ok(result.items.every(item => /^\d{6}$/.test(item.code)));
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetches normalized holdings and preserves the disclosure date', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /\/holdings\?code=005844/);
    return Response.json({
      source: 'eastmoney_fund_archives',
      fetched_at: '2026-07-26T05:00:00.000Z',
      report_date: '2026-06-30',
      items: [{ code: '688361', name: '中科飞测', ratio: 9.55 }],
    });
  };
  try {
    const result = await fetchFundHoldings('005844');
    assert.equal(result.status, 'ok');
    assert.equal(result.reportDate, '2026-06-30');
    assert.deepEqual(result.items, [{ code: '688361', name: '中科飞测', ratio: 9.55 }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('keeps a valid empty disclosure distinct from an upstream failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => Response.json({ status: 'empty', report_date: '', items: [] });
  try {
    const result = await fetchFundHoldings('000001');
    assert.equal(result.status, 'empty');
    assert.deepEqual(result.items, []);
  } finally {
    global.fetch = originalFetch;
  }
});

test('throws when the holdings proxy is unavailable', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('upstream unavailable', { status: 502 });
  try {
    await assert.rejects(fetchFundHoldings('005844'), /HTTP 502/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('honors caller cancellation and distinguishes it from its own timeout', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('native abort');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  try {
    const caller = new AbortController();
    const cancelled = fetchFundHoldings('005844', { signal: caller.signal });
    caller.abort('superseded');
    await assert.rejects(cancelled, { name: 'AbortError' });
    await assert.rejects(fetchFundHoldings('005844', { timeout: 1 }), {
      name: 'TimeoutError', code: 'REQUEST_TIMEOUT',
    });
  } finally {
    global.fetch = originalFetch;
  }
});
