import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchFundHoldings, normalizeHoldingRow, holdingQuoteCode } from '../js/fund-holdings.js';
import { formatChinaQuoteTime, normalizeTencentQuoteTime } from '../js/holdings-estimate.js';

test('normalizes a disclosed holding without coercing missing ratios to zero', () => {
  assert.deepEqual(normalizeHoldingRow({ code: '688361', name: '中科飞测', ratio: '9.55' }), {
    code: '688361',
    name: '中科飞测',
    ratio: 9.55,
  });
  assert.equal(normalizeHoldingRow({ code: '688361', name: '中科飞测', ratio: null }), null);
});

test('preserves mixed alphanumeric Japanese codes and explicit exchange identity', () => {
  assert.deepEqual(normalizeHoldingRow({ code: '285A', name: 'Test Japan', ratio: 2, market: 'JP' }), {
    code: '285A', name: 'Test Japan', ratio: 2, market: 'jp',
  });
  assert.equal(normalizeHoldingRow({ code: '285A', name: 'Test Japan', ratio: 2, market: '<script>' }).market, 'unknown');
  assert.equal(holdingQuoteCode({ code: '285A', market: 'jp' }), 'jp285A');
});

test('numeric overseas holdings cannot borrow A-share quotes by matching code length', () => {
  assert.equal(holdingQuoteCode({ code: '000660' }), '');
  assert.equal(holdingQuoteCode({ code: '000660', market: 'kr' }), 'kr000660');
  assert.equal(holdingQuoteCode({ code: '000660', market: 'kr' }, { allowMainland: true }), 'kr000660');
  assert.equal(holdingQuoteCode({ code: '00700' }), '');
  assert.equal(holdingQuoteCode({ code: '00700', market: 'hk' }), 'hk00700');
  assert.equal(holdingQuoteCode({ code: 'BRK.B', market: 'us' }), 'usBRK_B');
  assert.equal(holdingQuoteCode({ code: 'BRK.B' }), '');
  assert.equal(holdingQuoteCode({ code: '688361' }, { allowMainland: true }), 'sh688361');
  assert.equal(holdingQuoteCode({ code: '300750' }, { allowMainland: true }), 'sz300750');
  assert.equal(holdingQuoteCode({ code: '000660', market: 'unknown' }, { allowMainland: true }), '');
});

test('app routes identical Korean and mainland codes independently and removes unidentified cached moves', async () => {
  const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function fetchHoldingsQuotes('), source.indexOf('function fmtQuoteNav('));
  const fetchQuotes = new Function('loadHoldingsEstimateFeature', 'loadFundHoldingsFeature', 'fundsData', 'holdings', 'classifyFundMarket',
    'fetchWithTimeout', 'TIMING', 'parseNav', 'formatChinaQuoteTime', 'loadQuoteBridgeFeature', 'normalizeTencentQuoteTime',
    `${body}\nreturn fetchHoldingsQuotes;`)(
    async () => ({}), async () => ({ holdingQuoteCode }), [{ code: '012920', name: 'Synthetic QDII' }], [], () => 'qdii',
    async url => {
      assert.match(url, /secids=0\.000660&/);
      return Response.json({ data: { diff: [{ f12: '000660', f3: 3, f124: 1788822000 }] } });
    }, { INDEX_JSONP_TIMEOUT: 100 }, Number, formatChinaQuoteTime,
    async () => ({ securityQuotes: async codes => {
      assert.deepEqual(codes, ['kr000660', 'jp285A']);
      return { quotes: [
        { code: 'kr000660', changePct: -2, sourceTimeRaw: '20260908145900' },
        { code: 'jp285A', changePct: 1, sourceTimeRaw: '20260908145900' },
      ] };
    } }), normalizeTencentQuoteTime,
  );
  const stocks = [
    { code: '000660', market: 'cn' }, { code: '000660', market: 'kr' }, { code: '285A', market: 'jp' },
    { code: '000660', change: 99, quoteTime: '2026-09-08 13:59:00' },
  ];
  await fetchQuotes('012920', stocks);
  assert.equal(stocks[0].change, 3);
  assert.equal(stocks[1].change, -2);
  assert.equal(stocks[2].change, 1);
  assert.equal(stocks[1].quoteTime, '2026-09-08 13:59:00');
  assert.equal(stocks[3].change, undefined);
  assert.equal(stocks[3].quoteTime, undefined);
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

test('rejects an oversized whole disclosure rather than hiding bad rows and truncating it', async () => {
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
    await assert.rejects(fetchFundHoldings('005844'), { name: 'WorkerContractError', code: 'HOLDINGS_TOO_MANY_ROWS' });
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
