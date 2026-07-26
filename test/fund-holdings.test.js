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
