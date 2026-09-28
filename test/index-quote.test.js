import test from 'node:test';
import assert from 'node:assert/strict';
import { indexQuoteStatus, normalizeGoldQuote } from '../js/runtime/index-quote.js';
const now = Date.parse('2026-09-22T06:00:00Z');
test('gold never treats the security code as price or previous close as current', () => {
  assert.equal(normalizeGoldQuote({ f57: '9999', f43: null, f60: null }, now), null);
  const fallback = normalizeGoldQuote({ f43: '-', f57: '9999', f60: 800, f170: 3, f124: now / 1000 }, now);
  assert.equal(fallback.price, 800);
  assert.equal(fallback.changePct, null);
  assert.equal(fallback.observedAt, null);
  assert.equal(fallback.status, 'stale');
});
test('gold keeps genuine zero return and checks source rather than fetch time', () => {
  const current = normalizeGoldQuote({ f43: 800, f60: 800, f170: 0, f124: now / 1000 }, now);
  assert.equal(current.changePct, 0);
  assert.equal(current.status, 'current');
  assert.equal(normalizeGoldQuote({ f43: 800 }, now).status, 'stale');
  for (const time of [null, '2026-09-22', '2026-09-21 15:00:00', '2026-09-22 14:00:01']) {
    assert.equal(indexQuoteStatus(time, now), 'stale');
  }
  assert.equal(indexQuoteStatus('2026-09-22 14:00:00', now), 'current');
});
