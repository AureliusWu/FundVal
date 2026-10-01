import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSecurityQuotePlan } from '../js/runtime/security-quote-batch.js';
import { createRefreshPlan, createSecurityQuotePlan } from '../js/runtime/refresh-plan.js';
import { createGenerationResourceScope } from '../js/runtime/generation-resource-scope.js';
import { makeRefreshResourceEntry, validateRefreshResourceEntry } from '../js/runtime/refresh-resource-cache.js';
import { normalizeTencentQuoteTime } from '../js/holdings-estimate.js';
import { calculateOverseasEstimate, validateOverseasEstimatePeriod } from '../js/overseas-model.js';
import { TTL } from '../js/config.js';

// A newly acquired index response can truthfully contain the previous US close.
// Acquisition freshness must not be confused with the instrument's source time.
const NOW = Date.parse('2026-09-30T14:00:00+08:00');
const INDEX_CODES = ['sh000001', 'sh000300', 'usINX', 'usNDX'];
const INDEX_KEY = `indices:${INDEX_CODES.join(',')}`;
const US_CLOSE = '2026-09-29T20:00:00Z';
const US_CHINA_TIME = '2026-09-30 04:00:00';
const MODEL = { legs: [{ code: 'usINX', weight: 50 }, { code: 'usNDX', weight: 50 }],
  min_weight: 100, quarter: '2026Q2', version: 'synthetic-index-v1' };

function entry({ acquiredAt = NOW, rows, status = 'ok', usStatus = 'stale', sourceTime = US_CLOSE } = {}) {
  const payload = { source: 'tencent-market-quote', codes: [...INDEX_CODES], status,
    quotes: rows || INDEX_CODES.map((code, index) => ({ code, price: 100 + index,
      changePct: index === 2 ? 0 : 1, observedAt: code.startsWith('us') ? sourceTime : '2026-09-30T05:59:00Z',
      status: code.startsWith('us') ? usStatus : 'current', cached: false })) };
  const value = makeRefreshResourceEntry(INDEX_KEY, payload, { now: NOW, fetchedAt: acquiredAt, sourceDate: '2026-09-30' });
  assert.ok(value, 'synthetic index envelope must satisfy the production resource contract');
  // Real persisted entries do not gain a new cachedAt merely because they are read.
  return acquiredAt === NOW ? value : { ...value, cachedAt: acquiredAt, expiresAt: acquiredAt + TTL.INDEX };
}

function harness({ indexEntry, seedQuotes, modelCodes = ['usINX', 'usNDX'], securityCodes = [], stopped = false,
  now = NOW, fetchBridge: customBridge } = {}) {
  let current = true;
  const controller = new AbortController();
  const context = { generation: 1, signal: controller.signal, isCurrent: () => current,
    commit: operation => current && !controller.signal.aborted
      ? { committed: true, value: operation() } : { committed: false } };
  const refresh = createRefreshPlan({ generation: 1, now, activeHoldings: [{ code: '005844', name: '合成混合基金' }] });
  const scope = createGenerationResourceScope({ context, plan: refresh, now: () => now });
  const plan = createSecurityQuotePlan({ generation: 1,
    snapshots: securityCodes.length ? [{ validated: true, status: 'ok', items: securityCodes.map(quoteCode => ({ quoteCode })) }] : [],
    selectedModels: modelCodes.length ? [{ legs: modelCodes.map(code => ({ code })) }] : [] });
  const bridgeCalls = [], primaryCalls = [], gates = [], outcomes = [];
  function stop() { current = false; controller.abort(); }
  if (stopped) stop();
  const execute = executeSecurityQuotePlan({ plan, scope, indexEntry, seedQuotes, now: () => now,
    normalizeTime: normalizeTencentQuoteTime,
    fetchEastmoney: async codes => { primaryCalls.push([...codes]); return { data: { diff: [] } }; },
    fetchBridge: async (operation, codes, signal) => {
      bridgeCalls.push({ operation, codes: [...codes] });
      assert.equal(signal.aborted, false);
      if (customBridge) return customBridge(operation, codes, signal);
      return { quotes: codes.map(code => ({ code, price: 10, changePct: 2, sourceTimeRaw: '20260929160000' })) };
    },
    canAcquireModels: codes => { gates.push([...codes]); return true; },
    onModelAcquisition: outcome => outcomes.push(outcome),
  });
  return { execute, bridgeCalls, primaryCalls, gates, outcomes, scope, stop };
}

function asModelQuotes(result) {
  return Object.fromEntries(Object.entries(result.modelQuotes).map(([code, quote]) => [code,
    { change: quote.changePct, time: quote.sourceTime }]));
}

test('fresh acquired index envelope reuses previous US close without duplicate Tencent or a fake new source time', async () => {
  const indexEntry = entry(), before = structuredClone(indexEntry);
  assert.equal(validateRefreshResourceEntry(INDEX_KEY, indexEntry, { now: NOW }).cacheState, 'fresh');
  const h = harness({ indexEntry }), result = await h.execute;
  assert.deepEqual(h.bridgeCalls, []);
  assert.deepEqual(h.primaryCalls, []);
  assert.deepEqual(h.gates, []);
  assert.deepEqual(h.outcomes, []);
  assert.equal(h.scope.snapshot().requests, 0);
  assert.deepEqual(result.modelQuotes, {
    usINX: { price: 102, changePct: 0, sourceTime: US_CHINA_TIME },
    usNDX: { price: 103, changePct: 1, sourceTime: US_CHINA_TIME },
  });
  assert.deepEqual(indexEntry, before);
  result.modelQuotes.usNDX.changePct = 99;
  assert.equal(indexEntry.payload.quotes[3].changePct, 1, 'returned model records must not alias the index envelope');
});

test('partial index acquisition satisfies only present demanded US identities and fetches the remainder once', async () => {
  const indexEntry = entry({ rows: [{ code: 'usNDX', price: 200, changePct: 0, observedAt: US_CLOSE, status: 'closed' }], status: 'partial' });
  const h = harness({ indexEntry }), result = await h.execute;
  assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usINX'] }]);
  assert.deepEqual(result.modelQuotes.usNDX, { price: 200, changePct: 0, sourceTime: US_CHINA_TIME });
  assert.equal(result.modelQuotes.usINX.changePct, 2);
  assert.deepEqual(h.outcomes, [{ requestedCodes: ['usINX'], acquiredCodes: ['usINX'] }]);
  assert.equal(h.scope.snapshot().requests, 1);
});

test('allowed index instrument quality preserves real source time rather than relabeling it as request time', async () => {
  // The UI marks a ten-hour-old US close stale even after successful acquisition.
  // Reuse is model-only, with its existing 36h bound and downstream period gate.
  for (const usStatus of ['current', 'delayed', 'closed', 'stale']) {
    const indexEntry = entry({ usStatus }), before = structuredClone(indexEntry);
    const h = harness({ indexEntry }), result = await h.execute;
    assert.deepEqual(h.bridgeCalls, [], usStatus);
    assert.equal(result.modelQuotes.usINX.sourceTime, US_CHINA_TIME, usStatus);
    assert.equal(indexEntry.payload.quotes[2].status, usStatus);
    assert.deepEqual(indexEntry, before);
  }
});

test('an acquisition fresh until the exact TTL boundary is reusable, but never at or after expiresAt', async () => {
  const fresh = harness({ indexEntry: entry({ acquiredAt: NOW - TTL.INDEX + 1 }) });
  await fresh.execute;
  assert.deepEqual(fresh.bridgeCalls, []);
  for (const acquiredAt of [NOW - TTL.INDEX, NOW - TTL.INDEX - 1]) {
    const indexEntry = entry({ acquiredAt }), before = structuredClone(indexEntry);
    assert.equal(indexEntry.cacheState, 'fresh', 'raw persisted flags deliberately cannot override elapsed expiry');
    const h = harness({ indexEntry }); await h.execute;
    assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usINX', 'usNDX'] }]);
    assert.deepEqual(indexEntry, before, 'stale reads cannot renew acquisition metadata');
  }
});

test('the full index envelope must pass source, tier, identity, date and canonical TTL validation before reuse', async () => {
  const mutations = [
    value => { value.originalSource = 'eastmoney-security-quote'; },
    value => { value.originalSourceTier = 'primary'; },
    value => { value.sourceTier = 'primary'; },
    value => { value.schemaVersion = 99; },
    value => { value.ttlMs++; value.expiresAt++; },
    value => { value.fetchedAt = NOW + 1; },
    value => { value.sourceDate = '2026-09-29'; },
    value => { value.payload.codes.reverse(); },
    value => { value.payload.quotes[3].code = 'usINX'; },
    value => { value.payload.quotes[3].code = 'usSPY'; },
    value => { value.payload.quotes[2].observedAt = '2026-09-30T06:00:01Z'; },
    value => { value.payload.quotes[2].observedAt = '2026-02-30T00:00:00Z'; },
    value => { value.payload.quotes[2].price = 0; },
    value => { value.payload.quotes[2].changePct = ''; },
    value => { value.payload.quotes[2].status = 'unavailable'; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(entry()); mutate(invalid);
    assert.equal(validateRefreshResourceEntry(INDEX_KEY, invalid, { now: NOW }), null);
    const h = harness({ indexEntry: invalid }); await h.execute;
    assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usINX', 'usNDX'] }]);
  }
});

test('valid envelope never fills a null change, while model-only reuse preserves genuine zero and original stale status', async () => {
  for (const extra of [{ changePct: null }]) {
    const payload = structuredClone(entry().payload);
    Object.assign(payload.quotes[2], extra);
    const indexEntry = entry({ rows: payload.quotes });
    assert.ok(validateRefreshResourceEntry(INDEX_KEY, indexEntry, { now: NOW }));
    const h = harness({ indexEntry }), result = await h.execute;
    assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usINX'] }]);
    assert.equal(result.modelQuotes.usINX.changePct, 2);
    assert.equal(result.modelQuotes.usNDX.sourceTime, US_CHINA_TIME);
  }
  const h = harness({ indexEntry: entry() }), result = await h.execute;
  assert.equal(result.modelQuotes.usINX.changePct, 0);
  assert.deepEqual(h.bridgeCalls, []);
});

test('fresh acquisition never reuses index observations older than the original overseas 36-hour bound', async () => {
  for (const sourceTime of ['2026-09-27T20:00:00Z', '2026-09-28T17:59:59Z']) {
    const indexEntry = entry({ sourceTime }), before = structuredClone(indexEntry);
    assert.equal(validateRefreshResourceEntry(INDEX_KEY, indexEntry, { now: NOW }).cacheState, 'fresh');
    const h = harness({ indexEntry }); await h.execute;
    assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usINX', 'usNDX'] }]);
    assert.deepEqual(indexEntry, before);
  }
  const boundary = harness({ indexEntry: entry({ sourceTime: '2026-09-28T18:00:00Z' }) });
  const result = await boundary.execute;
  assert.deepEqual(boundary.bridgeCalls, []);
  assert.equal(result.modelQuotes.usINX.sourceTime, '2026-09-29 02:00:00');
});

test('index envelope is not a global model demand: absent or unrelated selected legs are never populated from it', async () => {
  const empty = harness({ indexEntry: entry(), modelCodes: [] });
  assert.deepEqual(await empty.execute, { securityQuotes: {}, modelQuotes: {} });
  assert.deepEqual(empty.bridgeCalls, []);
  const unrelated = harness({ indexEntry: entry(), modelCodes: ['usSPY'] });
  const result = await unrelated.execute;
  assert.deepEqual(unrelated.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usSPY'] }]);
  assert.deepEqual(Object.keys(result.modelQuotes), ['usSPY']);
});

test('old unbound seedQuotes retain their existing strict source-age rule even when the new envelope path exists', async () => {
  const h = harness({ seedQuotes: { usINX: { price: 102, changePct: 0, observedAt: US_CLOSE, status: 'closed' },
    usNDX: { price: 103, changePct: 1, observedAt: US_CLOSE, status: 'closed' } } });
  await h.execute;
  assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usINX', 'usNDX'] }]);
  assert.equal(h.scope.snapshot().requests, 1);
});

test('model-only acquisition freshness cannot seed a security-only old US index quote', async () => {
  const indexEntry = entry(), before = structuredClone(indexEntry);
  const h = harness({ indexEntry, modelCodes: [], securityCodes: ['usINX'] }), result = await h.execute;
  assert.deepEqual(h.bridgeCalls, [{ operation: 'securityQuotes', codes: ['usINX'] }]);
  assert.deepEqual(result.modelQuotes, {});
  assert.deepEqual(result.securityQuotes.usINX, { quoteCode: 'usINX', change: 2, quoteTime: US_CHINA_TIME });
  assert.equal(h.scope.snapshot().requests, 1);
  assert.deepEqual(indexEntry, before);
});

test('a shared model/security index demand keeps normal security freshness even when other model-only legs can reuse an old close', async () => {
  const h = harness({ indexEntry: entry(), securityCodes: ['usINX'] }), result = await h.execute;
  assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usINX'] }]);
  assert.equal(result.securityQuotes.usINX.change, 2);
  assert.equal(result.modelQuotes.usINX.changePct, 2);
  assert.deepEqual(result.modelQuotes.usNDX, { price: 103, changePct: 1, sourceTime: US_CHINA_TIME });
  assert.equal(h.scope.snapshot().requests, 1);
});

test('a genuinely source-fresh index can satisfy shared security/model demands under the unchanged strict TTL rule', async () => {
  const indexEntry = entry({ sourceTime: new Date(NOW - TTL.INDEX + 1).toISOString(), usStatus: 'current' });
  const h = harness({ indexEntry, securityCodes: ['usINX'], modelCodes: ['usINX'] }), result = await h.execute;
  assert.deepEqual(h.bridgeCalls, []);
  assert.equal(result.securityQuotes.usINX.change, 0);
  assert.equal(result.modelQuotes.usINX.changePct, 0);
  assert.equal(result.securityQuotes.usINX.quoteTime, result.modelQuotes.usINX.sourceTime);
  assert.equal(h.scope.snapshot().requests, 0);
  assert.deepEqual(h.outcomes, []);
});

test('reused previous close still passes the real model interval guard and rejects the wrong NAV base', async () => {
  const h = harness({ indexEntry: entry() }), quotes = asModelQuotes(await h.execute);
  assert.deepEqual(h.bridgeCalls, []);
  const calculated = calculateOverseasEstimate(MODEL, quotes, NOW);
  assert.equal(calculated.change, 0.5);
  assert.equal(calculated.sourceTime, US_CHINA_TIME);
  assert.deepEqual(validateOverseasEstimatePeriod(MODEL, quotes, '2026-09-28', { now: NOW }),
    { valid: true, targetDate: '2026-09-29', reason: '' });
  assert.equal(validateOverseasEstimatePeriod(MODEL, quotes, '2026-09-29', { now: NOW }).valid, false);
});

test('fresh acquisition metadata never bypasses the real model 36-hour source-age guard', async () => {
  const h = harness({ indexEntry: entry({ sourceTime: '2026-09-28T20:00:00Z' }) });
  const quotes = asModelQuotes(await h.execute);
  assert.deepEqual(h.bridgeCalls, []);
  assert.equal(quotes.usINX.time, '2026-09-29 04:00:00');
  // At NOW this quote is 34 hours old; move the model evaluation beyond 36h.
  const later = NOW + 3 * 60 * 60 * 1000;
  const calculated = calculateOverseasEstimate(MODEL, quotes, later);
  assert.equal(calculated.change, null);
  assert.equal(calculated.rejected.stale, 2);
  assert.equal(validateOverseasEstimatePeriod(MODEL, quotes, '2026-09-25', { now: later }).valid, false);
});

test('cancelled current-generation work cannot return a seed-only successful model result or emit a probe outcome', async () => {
  for (const options of [{ indexEntry: entry() }, { seedQuotes: {
    usINX: { price: 102, changePct: 0, sourceTime: '2026-09-30 14:00:00', status: 'current' },
    usNDX: { price: 103, changePct: 1, sourceTime: '2026-09-30 14:00:00', status: 'current' },
  } }]) {
    const h = harness({ ...options, stopped: true });
    await assert.rejects(h.execute, { name: 'AbortError' });
    assert.deepEqual(h.bridgeCalls, []);
    assert.deepEqual(h.primaryCalls, []);
    assert.deepEqual(h.outcomes, []);
    assert.equal(h.scope.snapshot().requests, 0);
    assert.equal(h.scope.snapshot().cacheWrites, 0);
  }
});

test('a late noncooperative missing-index response cannot return seeded models after cancellation', async () => {
  let resolve, entered;
  const waiting = new Promise(done => { resolve = done; });
  const started = new Promise(done => { entered = done; });
  const indexEntry = entry({ rows: [{ code: 'usNDX', price: 200, changePct: 0, observedAt: US_CLOSE, status: 'closed' }], status: 'partial' });
  const h = harness({ indexEntry, fetchBridge: async () => { entered(); return waiting; } });
  await started; h.stop();
  resolve({ quotes: [{ code: 'usINX', price: 10, changePct: 2, sourceTimeRaw: '20260929160000' }] });
  await assert.rejects(h.execute, { name: 'AbortError' });
  assert.deepEqual(h.outcomes, []);
  assert.equal(h.scope.snapshot().abortedRequests, 1);
  assert.equal(h.scope.snapshot().cacheWrites, 0);
});
