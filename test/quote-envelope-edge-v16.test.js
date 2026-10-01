import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteEnvelope, quoteIsUsable } from '../js/runtime/quote-contract.js';
import { createValuationPeriod } from '../js/runtime/valuation-period.js';
import { holdingQuoteAmounts } from '../js/runtime/holding-quote-amounts.js';
import { normalizeCachedQuote } from '../js/runtime/quote-normalizer.js';

const now = Date.parse('2026-09-30T05:24:00Z');
const valid = { valueKind: 'intraday_estimate', status: 'realtime', sourceId: 'sinan-estimate-proxy', sourceTier: 'primary',
  value: 1.05, changePct: 5, baseNav: 1, baseNavDate: '2026-09-29', targetDate: '2026-09-30',
  observedAt: '2026-09-30 13:24:00', fetchedAt: new Date(now).toISOString() };

test('v16 unknown quote enum cannot regain usability through a later future-time branch', () => {
  for (const override of [{ valueKind: 'invented' }, { sourceTier: 'invented' }, { status: 'invented' }]) {
    const quote = createQuoteEnvelope({ ...valid, ...override, observedAt: '2026-09-30 14:24:00' }, { now });
    assert.equal(quote.status, 'unavailable');
    assert.equal(quoteIsUsable(quote), false);
    assert.equal(createValuationPeriod(quote, { shares: 100, now }).profitAmount, null);
    assert.ok(quote.reasonCodes.includes('QUOTE_ENUM_INVALID'));
    assert.equal(quote.value, null);
    assert.equal(quote.changePct, null);
    assert.equal(holdingQuoteAmounts(quote, { shares: 100, cost: 1 }, now).curr_value, null);
  }
});

test('v16 explicit unavailable remains terminal despite future timestamps and residual values', () => {
  for (const observedAt of [valid.observedAt, '2026-09-30 14:24:00']) {
    const quote = createQuoteEnvelope({ ...valid, status: 'unavailable', observedAt }, { now });
    assert.equal(quote.status, 'unavailable');
    assert.equal(quote.value, null);
    const amounts = holdingQuoteAmounts(quote, { shares: 100, cost: 1 }, now);
    assert.equal(amounts.curr_value, null);
    assert.equal(amounts.total_profit, null);
    assert.equal(amounts.total_profit_rate, null);
  }
  const raw = holdingQuoteAmounts({ ...valid, status: 'invented' }, { shares: 100, cost: 1 }, now);
  assert.equal(raw.curr_value, null);
});

test('v16 a fresh outer TTL cannot legitimize missing or invented cache provenance', () => {
  const metadata = { sourceTier: 'cache', cacheState: 'fresh', cachedAt: now, expiresAt: now + 60000,
    originalSource: 'sinan-estimate-proxy', originalSourceTier: 'primary' };
  for (const override of [{ originalSource: 'invented-provider' }, { originalSource: 'local-cache' },
    { originalSource: null, sourceId: 'local-cache' }, { originalSourceTier: 'invented' }, { originalSourceTier: null }]) {
    const quote = normalizeCachedQuote({ ...valid, ...metadata, ...override }, { fresh: true, now });
    assert.notEqual(quote.cacheState, 'fresh');
    assert.equal(createValuationPeriod(quote, { shares: 100, now }).isTodayEstimate, false);
    assert.ok(quote.reasonCodes.includes('CACHE_PROVENANCE_INVALID'));
  }
  const legacyAlias = normalizeCachedQuote({ ...valid, ...metadata, originalSource: 'tiantian' }, { fresh: true, now });
  assert.equal(legacyAlias.cacheState, 'fresh');
  assert.equal(legacyAlias.originalSource, 'sinan-estimate-proxy');
});

test('v16 nonpositive NAV is missing while a genuinely reported zero change stays zero', () => {
  for (const value of [0, -1, false, '0']) {
    const quote = createQuoteEnvelope({ ...valid, value, changePct: 0 }, { now });
    assert.equal(quote.value, null);
    assert.equal(quote.changePct, 0);
    assert.equal(createValuationPeriod(quote, { shares: 100, now }).profitAmount, null);
  }
});

test('v16 acquisition cannot occur after cache persistence or use a rollover timestamp', () => {
  for (const fetchedAt of ['2026-09-30T06:24:00Z', '2026-10-01T05:24:00Z', '2026-02-30T05:24:00Z']) {
    const quote = createQuoteEnvelope({ ...valid, sourceTier: 'cache', cacheState: 'fresh', fetchedAt,
      cachedAt: now - 1000, expiresAt: now + 60000 }, { now });
    assert.equal(quote.status, 'stale');
    assert.equal(quote.cacheState, null);
    assert.equal(createValuationPeriod(quote, { shares: 100, now }).isTodayEstimate, false);
  }
});
