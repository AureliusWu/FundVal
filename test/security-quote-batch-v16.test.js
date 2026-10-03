import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSecurityQuotePlan } from '../js/runtime/security-quote-batch.js';
import { createRefreshPlan, createSecurityQuotePlan } from '../js/runtime/refresh-plan.js';
import { createGenerationResourceScope } from '../js/runtime/generation-resource-scope.js';
import { normalizeTencentQuoteTime } from '../js/holdings-estimate.js';
import { TTL } from '../js/config.js';

const NOW = Date.parse('2026-09-30T14:00:00+08:00');
const TIME = '2026-09-30 14:00:00';
const stocks = count => Array.from({ length: count }, (_, index) => `sh${String(600000 + index).padStart(6, '0')}`);
function makePlan(securityCodes = [], modelCodes = [], indexCodes = []) {
  const snapshots = [];
  for (let index = 0; index < securityCodes.length; index += 10) snapshots.push({ validated: true, status: 'ok',
    items: securityCodes.slice(index, index + 10).map(quoteCode => ({ quoteCode })) });
  return createSecurityQuotePlan({ generation: 1, snapshots, indexCodes,
    selectedModels: modelCodes.length ? [{ legs: modelCodes.map(code => ({ code })) }] : [] });
}
function em(code, extra = {}) {
  return { f12: code.slice(2), f13: code.startsWith('sh') ? 1 : 0, f3: 1, f2: 10, f124: NOW / 1000, ...extra };
}
function bridge(code, extra = {}) {
  const sourceTimeRaw = code.startsWith('us') ? '20260930020000'
    : /^(jp|kr)/.test(code) ? '20260930150000' : '20260930140000';
  return { code, price: 10, changePct: 1, sourceTimeRaw, ...extra };
}
function harness() {
  let current = true;
  const controller = new AbortController();
  const context = { generation: 1, signal: controller.signal, isCurrent: () => current,
    commit: operation => current && !controller.signal.aborted ? { committed: true, value: operation() } : { committed: false } };
  const plan = createRefreshPlan({ generation: 1, now: NOW, activeHoldings: [{ code: '005844', name: '合成混合基金' }] });
  return { scope: createGenerationResourceScope({ context, plan, now: () => NOW }),
    stop() { current = false; controller.abort(); } };
}
function run(plan, extra = {}) {
  const h = harness(), emCalls = [], bridgeCalls = [];
  const execute = executeSecurityQuotePlan({ plan, scope: h.scope, now: () => NOW, normalizeTime: normalizeTencentQuoteTime,
    fetchEastmoney: async (codes, signal) => { emCalls.push([...codes]); assert.equal(signal.aborted, false);
      return { data: { diff: codes.map(code => em(code)) } }; },
    fetchBridge: async (operation, codes, signal) => { bridgeCalls.push({ operation, codes: [...codes] }); assert.equal(signal.aborted, false);
      return { quotes: codes.map(code => bridge(code)) }; }, ...extra });
  return { ...h, emCalls, bridgeCalls, execute };
}

test('overlapping two disclosures request a 12-identity union in one real Eastmoney dispatch', async () => {
  const codes = stocks(12);
  const plan = createSecurityQuotePlan({ generation: 1, snapshots: [
    { validated: true, status: 'ok', items: codes.slice(0, 10).map(quoteCode => ({ quoteCode })) },
    { validated: true, status: 'ok', items: codes.slice(2).map(quoteCode => ({ quoteCode })) },
  ] });
  const h = run(plan), result = await h.execute;
  assert.deepEqual(h.emCalls, [codes]);
  assert.deepEqual(h.bridgeCalls, []);
  assert.equal(Object.keys(result.securityQuotes).length, 12);
  assert.equal(h.scope.snapshot().requests, 1);
  assert.deepEqual(h.scope.snapshot().providers, { 'eastmoney-security-quote': 1 });
  assert.deepEqual(result.securityQuotes[codes[0]], { quoteCode: codes[0], change: 1, quoteTime: TIME });
});

test('Tencent requests only identities absent from the primary result', async () => {
  const codes = stocks(12);
  const h = run(makePlan(codes), { fetchEastmoney: async () => ({ data: { diff: codes.slice(0, 10).map(code => em(code)) } }) });
  const result = await h.execute;
  assert.deepEqual(h.bridgeCalls, [{ operation: 'securityQuotes', codes: codes.slice(10) }]);
  assert.equal(Object.keys(result.securityQuotes).length, 12);
  assert.equal(h.scope.snapshot().requests, 2);
});

test('same naked code on different markets is distributed only by f13 plus f12', async () => {
  const h = run(makePlan(['sh000001', 'sz000001']), { fetchEastmoney: async () => ({ data: { diff: [
    em('sz000001', { f3: 22 }), em('sh000001', { f3: 11 }),
  ] } }) });
  const result = await h.execute;
  assert.equal(result.securityQuotes.sh000001.change, 11);
  assert.equal(result.securityQuotes.sz000001.change, 22);
  assert.deepEqual(h.bridgeCalls, []);
});

test('a partial response for one of two colliding bare codes cannot satisfy the other exchange', async () => {
  const h = run(makePlan(['sh000001', 'sz000001']), { fetchEastmoney: async () => ({ data: { diff: [em('sh000001', { f3: 11 })] } }) });
  const result = await h.execute;
  assert.deepEqual(h.bridgeCalls, [{ operation: 'securityQuotes', codes: ['sz000001'] }]);
  assert.equal(result.securityQuotes.sh000001.change, 11);
  assert.equal(result.securityQuotes.sz000001.change, 1);
});

test('duplicate, missing-market and unrequested Eastmoney identities reject the batch, not assign poisoned values', async () => {
  for (const diff of [[em('sh600000', { f3: 99 }), em('sh600000', { f3: 88 })],
    [{ f12: '600000', f3: 99, f124: NOW / 1000 }], [em('sh600001', { f3: 99 })]]) {
    const h = run(makePlan(['sh600000']), { fetchEastmoney: async () => ({ data: { diff } }) });
    const result = await h.execute;
    assert.deepEqual(h.bridgeCalls, [{ operation: 'securityQuotes', codes: ['sh600000'] }]);
    assert.equal(result.securityQuotes.sh600000.change, 1);
    assert.equal(Object.keys(result.securityQuotes).length, 1);
  }
});

test('primary zero is usable while null, malformed or nonfinite changes fall through without manufacturing zero', async () => {
  const codes = stocks(6), bad = [null, '', true, '1%2', Infinity];
  const h = run(makePlan(codes), { fetchEastmoney: async () => ({ data: { diff: codes.map((code, index) => em(code,
    { f3: index === 0 ? 0 : bad[index - 1] })) } }),
    fetchBridge: async () => ({ quotes: [] }) });
  const result = await h.execute;
  assert.deepEqual(Object.keys(result.securityQuotes), [codes[0]]);
  assert.equal(result.securityQuotes[codes[0]].change, 0);
  assert.equal(h.scope.snapshot().requests, 2);
});

test('primary epoch must be an actual nonfuture finite integer in seconds', async () => {
  for (const f124 of [null, true, String(NOW / 1000), 0, 8.64e15, NOW / 1000 + 1, NOW / 1000 + 0.5]) {
    const h = run(makePlan(['sh600000']), { fetchEastmoney: async () => ({ data: { diff: [em('sh600000', { f124 })] } }) });
    await h.execute;
    assert.deepEqual(h.bridgeCalls, [{ operation: 'securityQuotes', codes: ['sh600000'] }], String(f124));
  }
});

test('51 primary securities split into 50 and 1 without duplicate dispatch identities', async () => {
  const codes = stocks(51), h = run(makePlan(codes));
  const result = await h.execute;
  assert.deepEqual(h.emCalls.map(batch => batch.length), [50, 1]);
  assert.deepEqual(h.emCalls.flat(), codes);
  assert.equal(Object.keys(result.securityQuotes).length, 51);
  assert.equal(h.scope.snapshot().requests, 2);
});

test('51 Tencent securities and 65 selected overseas legs respect existing operation batch limits', async () => {
  const securities = Array.from({ length: 51 }, (_, index) => `hk${String(index + 1).padStart(5, '0')}`);
  const models = Array.from({ length: 65 }, (_, index) => `usS${String(index).padStart(2, '0')}`);
  const h = run(makePlan(securities, models)), result = await h.execute;
  assert.deepEqual(h.bridgeCalls.filter(item => item.operation === 'securityQuotes').map(item => item.codes.length), [50, 1]);
  assert.deepEqual(h.bridgeCalls.filter(item => item.operation === 'overseasComponents').map(item => item.codes.length), [64, 1]);
  assert.equal(new Set(h.bridgeCalls.flatMap(item => item.codes)).size, 116);
  assert.equal(h.scope.snapshot().requests, 4);
  assert.equal(Object.keys(result.securityQuotes).length, 51);
  assert.equal(Object.keys(result.modelQuotes).length, 65);
});

test('a model/security overlap is acquired by one compatible Tencent operation and serves both consumers', async () => {
  const h = run(makePlan(['usSPY', 'hk00700'], ['usSPY', 'usQQQ'])), result = await h.execute;
  assert.equal(h.bridgeCalls.flatMap(item => item.codes).filter(code => code === 'usSPY').length, 1);
  assert.deepEqual(h.bridgeCalls.find(item => item.operation === 'overseasComponents').codes, ['usQQQ', 'usSPY']);
  assert.deepEqual(h.bridgeCalls.find(item => item.operation === 'securityQuotes').codes, ['hk00700']);
  assert.equal(result.securityQuotes.usSPY.change, 1);
  assert.deepEqual(result.modelQuotes.usSPY, { price: 10, changePct: 1, sourceTime: TIME });
});

test('a selected mainland model leg reuses the primary contribution, with missing price remaining null', async () => {
  const h = run(makePlan(['sh600000'], ['sh600000']), { fetchEastmoney: async () => ({ data: { diff: [em('sh600000', { f2: undefined })] } }) });
  const result = await h.execute;
  assert.deepEqual(h.bridgeCalls, []);
  assert.deepEqual(result.modelQuotes.sh600000, { price: null, changePct: 1, sourceTime: TIME });
});

test('only selected main/fallback legs are requested, never implicit global model defaults or index-only demands', async () => {
  const plan = createSecurityQuotePlan({ generation: 1, indexCodes: ['usNDX', 'usINX'],
    selectedModels: [{ legs: [{ code: 'usQQQ' }], fallback: { legs: [{ code: 'usSPY' }] } }] });
  const h = run(plan), result = await h.execute;
  assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usQQQ', 'usSPY'] }]);
  assert.deepEqual(Object.keys(result.modelQuotes), ['usQQQ', 'usSPY']);
});

test('valid observed index seeds are reused only for actually requested US INX/NDX legs', async () => {
  const seedQuotes = { usNDX: { price: 100, changePct: 0, observedAt: new Date(NOW).toISOString(), status: 'current' },
    usEEM: { price: 999, changePct: 99, sourceTime: TIME, status: 'current' } };
  const before = structuredClone(seedQuotes);
  const h = run(makePlan([], ['usNDX']), { seedQuotes }), result = await h.execute;
  assert.deepEqual(h.bridgeCalls, []);
  assert.deepEqual(result.modelQuotes, { usNDX: { price: 100, changePct: 0, sourceTime: TIME } });
  assert.equal(h.scope.snapshot().requests, 0);
  assert.deepEqual(seedQuotes, before);
});

test('stale, unavailable, invalid, future and expired seeds trigger a model request instead of reuse', async () => {
  for (const extra of [{ status: 'stale' }, { status: 'unavailable' }, { sourceTime: '2026-02-30 14:00:00' },
    { sourceTime: '2026-09-30 14:00:01' }, { sourceTime: '2026-09-30 13:58:59' }, { changePct: null }, { price: 0 }]) {
    const h = run(makePlan([], ['usNDX']), { seedQuotes: { usNDX: { price: 100, changePct: 0, sourceTime: TIME, status: 'current', ...extra } } });
    const result = await h.execute;
    assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usNDX'] }]);
    assert.equal(result.modelQuotes.usNDX.changePct, 1);
  }
  const validBoundary = run(makePlan([], ['usNDX']), { seedQuotes: { usNDX: { price: 100, changePct: 0,
    observedAt: new Date(NOW - TTL.INDEX + 1).toISOString(), status: 'current' } } });
  await validBoundary.execute;
  assert.deepEqual(validBoundary.bridgeCalls, []);
});

test('Bridge duplicate or unrequested identities and invalid prices reject the whole returned batch', async () => {
  for (const quotes of [[bridge('usQQQ'), bridge('usQQQ')], [bridge('usEEM')], [bridge('usQQQ', { price: Infinity })]]) {
    const h = run(makePlan([], ['usQQQ']), { fetchBridge: async () => ({ quotes }) });
    assert.deepEqual(await h.execute, { securityQuotes: {}, modelQuotes: {} });
    assert.equal(h.scope.snapshot().requests, 1);
  }
});

test('Bridge null change or impossible source clock cannot contribute, but a genuine zero remains zero', async () => {
  for (const extra of [{ changePct: null }, { sourceTimeRaw: '20260230140000' }, { sourceTimeRaw: '20260930240000' }]) {
    const h = run(makePlan(['hk00700']), { fetchBridge: async () => ({ quotes: [bridge('hk00700', extra)] }) });
    assert.deepEqual((await h.execute).securityQuotes, {});
  }
  const h = run(makePlan(['hk00700']), { fetchBridge: async () => ({ quotes: [bridge('hk00700', { changePct: 0 })] }) });
  assert.equal((await h.execute).securityQuotes.hk00700.change, 0);
});

test('an invalid normalized clock or a future Bridge observation is excluded without guessing a source date', async () => {
  for (const normalizeTime of [() => '', () => '2026-02-30 14:00:00', () => '2026-09-30 14:00:01',
    () => { throw new Error('synthetic invalid timezone'); }]) {
    const h = run(makePlan([], ['usQQQ']), { normalizeTime });
    assert.deepEqual((await h.execute).modelQuotes, {});
    assert.equal(h.scope.snapshot().requests, 1);
  }
});

test('ordinary provider outages degrade to missing records and count every real dispatch', async () => {
  const h = run(makePlan(['sh600000']), { fetchEastmoney: async () => { throw new Error('synthetic primary outage'); },
    fetchBridge: async () => { throw new Error('synthetic fallback outage'); } });
  assert.deepEqual(await h.execute, { securityQuotes: {}, modelQuotes: {} });
  assert.equal(h.scope.snapshot().requests, 2);
  assert.equal(h.scope.snapshot().failedRequests, 2);
});

test('AbortError is propagated and never converted to an empty successful contribution', async () => {
  const h = run(makePlan(['sh600000']), { fetchEastmoney: async () => { throw Object.assign(new Error('synthetic cancelled'), { name: 'AbortError' }); } });
  await assert.rejects(h.execute, { name: 'AbortError' });
  assert.deepEqual(h.bridgeCalls, []);
  assert.equal(h.scope.snapshot().requests, 1);
  assert.equal(h.scope.snapshot().abortedRequests, 1);
});

test('a late provider ignoring cancellation is rejected by the real generation scope', async () => {
  let resolve, entered;
  const wait = new Promise(done => { resolve = done; });
  const started = new Promise(done => { entered = done; });
  const h = run(makePlan(['sh600000']), { fetchEastmoney: async () => { entered(); return wait; } });
  await started;
  h.stop();
  resolve({ data: { diff: [em('sh600000')] } });
  await assert.rejects(h.execute, { name: 'AbortError' });
  assert.deepEqual(h.bridgeCalls, []);
  assert.equal(h.scope.snapshot().requests, 1);
  assert.equal(h.scope.snapshot().cacheWrites, 0);
});

test('empty demands dispatch nothing and malicious codes cannot widen Bridge permissions', async () => {
  const h = run(makePlan()), result = await h.execute;
  assert.deepEqual(result, { securityQuotes: {}, modelQuotes: {} });
  assert.equal(h.scope.snapshot().requests, 0);
  const bad = run({ generation: 1, securityCodes: ['r_hkHSI'], modelCodes: [], indexCodes: [] });
  await assert.rejects(bad.execute);
  assert.equal(bad.scope.snapshot().requests, 0);
});

test('input demand arrays, seeds and provider payloads stay unchanged and output records do not alias them', async () => {
  const payload = { data: { diff: { 0: em('sh600000') } } }, before = structuredClone(payload);
  const plan = makePlan(['sh600000'], ['sh600000']);
  const h = run(plan, { fetchEastmoney: async () => payload });
  const result = await h.execute;
  assert.deepEqual(payload, before);
  assert.equal(Object.isFrozen(plan.securityCodes), true);
  result.modelQuotes.sh600000.changePct = 99;
  assert.equal(result.securityQuotes.sh600000.change, 1);
  assert.equal(payload.data.diff[0].f3, 1);
});

test('a denied model-exclusive gate leaves domestic holdings and shared model identities available', async () => {
  const gateCalls = [], outcomes = [];
  const h = run(makePlan(['sh600000', 'sh600001'], ['sh600000', 'sh600002', 'jp7203']), {
    canAcquireModels: codes => { gateCalls.push([...codes]); return false; },
    onModelAcquisition: outcome => outcomes.push(outcome),
  });
  const result = await h.execute;
  assert.deepEqual(h.emCalls, [['sh600000', 'sh600001']]);
  assert.deepEqual(h.bridgeCalls, []);
  assert.deepEqual(Object.keys(result.securityQuotes), ['sh600000', 'sh600001']);
  assert.deepEqual(result.modelQuotes, { sh600000: { price: 10, changePct: 1, sourceTime: TIME } });
  assert.ok(gateCalls.length > 0);
  assert.ok(gateCalls.flat().every(code => ['sh600002', 'jp7203'].includes(code)));
  assert.deepEqual(outcomes, []);
  assert.deepEqual(h.scope.snapshot().providers, { 'eastmoney-security-quote': 1 });
});

test('denied exclusive models do not prevent a shared holding identity from receiving Tencent fallback', async () => {
  const gateCalls = [], outcomes = [];
  const h = run(makePlan(['sh600000'], ['sh600000', 'usQQQ']), {
    fetchEastmoney: async () => ({ data: { diff: [] } }),
    canAcquireModels: codes => { gateCalls.push([...codes]); return false; },
    onModelAcquisition: outcome => outcomes.push(outcome),
  });
  const result = await h.execute;
  assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['sh600000'] }]);
  assert.equal(result.securityQuotes.sh600000.change, 1);
  assert.equal(result.modelQuotes.sh600000.changePct, 1);
  assert.equal(result.modelQuotes.usQQQ, undefined);
  assert.deepEqual(gateCalls, [['usQQQ']]);
  assert.deepEqual(outcomes, []);
  assert.deepEqual(h.scope.snapshot().providers, { 'eastmoney-security-quote': 1, 'tencent-market-quote': 1 });
});

test('a first-only half-open gate dispatches just one batch for 65 selected overseas identities', async () => {
  const models = Array.from({ length: 65 }, (_, index) => `usS${String(index).padStart(2, '0')}`);
  const gateCalls = [], outcomes = [];
  const h = run(makePlan([], models), {
    canAcquireModels: codes => { gateCalls.push([...codes]); return gateCalls.length === 1; },
    onModelAcquisition: outcome => outcomes.push(outcome),
  });
  const result = await h.execute;
  assert.deepEqual(gateCalls.map(codes => codes.length), [64, 1]);
  assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: models.slice(0, 64) }]);
  assert.deepEqual(Object.keys(result.modelQuotes), models.slice(0, 64));
  assert.deepEqual(outcomes, [{ requestedCodes: models.slice(0, 64), acquiredCodes: models.slice(0, 64) }]);
  assert.equal(h.scope.snapshot().requests, 1);
});

test('a half-open primary model probe cannot be reacquired by fallback or later batches over 64 legs', async () => {
  const models = ['sh600000', ...Array.from({ length: 64 }, (_, index) => `usS${String(index).padStart(2, '0')}`)];
  const gateCalls = [], outcomes = [], primaryCalls = [];
  const h = run(makePlan(['sh600001'], models), {
    fetchEastmoney: async codes => { primaryCalls.push([...codes]); return { data: { diff: [em('sh600001')] } }; },
    canAcquireModels: codes => { gateCalls.push([...codes]); return gateCalls.length === 1; },
    onModelAcquisition: outcome => outcomes.push(outcome),
  });
  const result = await h.execute;
  assert.deepEqual(primaryCalls, [['sh600000', 'sh600001']]);
  assert.deepEqual(gateCalls[0], ['sh600000']);
  assert.deepEqual(gateCalls.slice(1).map(codes => codes.length), [64, 1]);
  assert.deepEqual(h.bridgeCalls, []);
  assert.equal(result.securityQuotes.sh600001.change, 1);
  assert.deepEqual(result.modelQuotes, {});
  assert.deepEqual(outcomes, [{ requestedCodes: ['sh600000'], acquiredCodes: [] }]);
  assert.deepEqual(h.scope.snapshot().providers, { 'eastmoney-security-quote': 1 });
});

test('model acquisition outcomes count genuine zero as acquired but never count null from either provider', async () => {
  const primaryOutcomes = [], primaryFallbackCalls = [];
  const primary = run(makePlan([], ['sh600000', 'sh600001']), {
    fetchEastmoney: async () => ({ data: { diff: [em('sh600000', { f3: 0 }), em('sh600001', { f3: null })] } }),
    fetchBridge: async (operation, codes) => { primaryFallbackCalls.push({ operation, codes: [...codes] });
      return { quotes: codes.map(code => bridge(code, { changePct: null })) }; },
    onModelAcquisition: outcome => primaryOutcomes.push(outcome),
  });
  const primaryResult = await primary.execute;
  assert.equal(primaryResult.modelQuotes.sh600000.changePct, 0);
  assert.equal(primaryResult.modelQuotes.sh600001, undefined);
  assert.deepEqual(primaryFallbackCalls, [{ operation: 'overseasComponents', codes: ['sh600001'] }]);
  assert.deepEqual(primaryOutcomes, [{ requestedCodes: ['sh600000', 'sh600001'], acquiredCodes: ['sh600000'] }]);
  assert.equal(primary.scope.snapshot().requests, 2);

  const overseasOutcomes = [];
  const overseas = run(makePlan([], ['usQQQ', 'usSPY']), {
    fetchBridge: async () => ({ quotes: [bridge('usQQQ', { changePct: 0 }), bridge('usSPY', { changePct: null })] }),
    onModelAcquisition: outcome => overseasOutcomes.push(outcome),
  });
  const overseasResult = await overseas.execute;
  assert.equal(overseasResult.modelQuotes.usQQQ.changePct, 0);
  assert.equal(overseasResult.modelQuotes.usSPY, undefined);
  assert.deepEqual(overseasOutcomes, [{ requestedCodes: ['usQQQ', 'usSPY'], acquiredCodes: ['usQQQ'] }]);
  assert.equal(overseas.scope.snapshot().requests, 1);
});

test('fresh valid index seeds neither acquire a model probe nor emit a network outcome', async () => {
  const gateCalls = [], outcomes = [];
  const h = run(makePlan([], ['usINX', 'usNDX']), {
    seedQuotes: { usINX: { price: 100, changePct: 0, sourceTime: TIME, status: 'current' },
      usNDX: { price: 200, changePct: -1, observedAt: new Date(NOW).toISOString(), status: 'closed' } },
    canAcquireModels: codes => { gateCalls.push([...codes]); return false; },
    onModelAcquisition: outcome => outcomes.push(outcome),
  });
  const result = await h.execute;
  assert.deepEqual(result.modelQuotes, { usINX: { price: 100, changePct: 0, sourceTime: TIME },
    usNDX: { price: 200, changePct: -1, sourceTime: TIME } });
  assert.deepEqual(gateCalls, []);
  assert.deepEqual(outcomes, []);
  assert.deepEqual(h.emCalls, []);
  assert.deepEqual(h.bridgeCalls, []);
  assert.equal(h.scope.snapshot().requests, 0);
});

test('a cancelled model acquisition propagates AbortError without emitting an outcome or fallback', async () => {
  for (const provider of ['primary', 'overseas']) {
    let resolve, entered;
    const wait = new Promise(done => { resolve = done; });
    const started = new Promise(done => { entered = done; });
    const outcomes = [], gateCalls = [];
    const h = run(makePlan([], [provider === 'primary' ? 'sh600000' : 'usQQQ']), {
      ...(provider === 'primary' ? { fetchEastmoney: async () => { entered(); return wait; } }
        : { fetchBridge: async () => { entered(); return wait; } }),
      canAcquireModels: codes => { gateCalls.push([...codes]); return true; },
      onModelAcquisition: outcome => outcomes.push(outcome),
    });
    await started;
    h.stop();
    resolve(provider === 'primary' ? { data: { diff: [em('sh600000')] } } : { quotes: [bridge('usQQQ')] });
    await assert.rejects(h.execute, { name: 'AbortError' });
    assert.equal(gateCalls.length, 1);
    assert.deepEqual(outcomes, []);
    assert.equal(h.scope.snapshot().requests, 1);
    assert.equal(h.scope.snapshot().abortedRequests, 1);
    assert.equal(h.scope.snapshot().cacheWrites, 0);
    if (provider === 'primary') assert.deepEqual(h.bridgeCalls, []);
  }
});

test('security seed record guards reject primitives and arrays without manufacturing quotes', async () => {
  for (const value of [undefined, null, false, true, 0, -0, NaN, Infinity, '', 'record', 1n, Symbol('record'), () => {}, []]) {
    const h = run(makePlan([], ['usNDX']), { seedQuotes: { usNDX: value } });
    const result = await h.execute;
    assert.deepEqual(h.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usNDX'] }]);
    assert.equal(result.modelQuotes.usNDX.changePct, 1);
    assert.equal(h.scope.snapshot().cacheWrites, 0);
  }
  const quote = Object.assign(Object.create(null), { price: 100, changePct: 0, sourceTime: TIME, status: 'current' });
  const seeds = Object.assign(Object.create(null), { usNDX: quote });
  const h = run(makePlan([], ['usNDX']), { seedQuotes: seeds });
  assert.deepEqual((await h.execute).modelQuotes, { usNDX: { price: 100, changePct: 0, sourceTime: TIME } });
  assert.deepEqual(h.bridgeCalls, []);
});

test('security seed own checks ignore inherited identities and retain inherited optional-field rules', async () => {
  const quote = { price: 100, changePct: 0, sourceTime: TIME, status: 'current' };
  const inherited = run(makePlan([], ['usNDX']), { seedQuotes: Object.create({ usNDX: quote }) });
  await inherited.execute;
  assert.deepEqual(inherited.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usNDX'] }]);
  const seed = Object.assign(Object.create({ status: 'stale', sourceTime: 'invalid' }), {
    price: 100, changePct: 0, observedAt: new Date(NOW).toISOString(),
  });
  Object.defineProperty(seed, 'hasOwnProperty', { get() { throw new Error('shadowed own method must not run'); } });
  const inheritedFields = run(makePlan([], ['usNDX']), { seedQuotes: { usNDX: seed } });
  assert.deepEqual((await inheritedFields.execute).modelQuotes.usNDX, { price: 100, changePct: 0, sourceTime: TIME });
  assert.deepEqual(inheritedFields.bridgeCalls, []);
  seed.sourceTime = null;
  const ownNull = run(makePlan([], ['usNDX']), { seedQuotes: { usNDX: seed } });
  await ownNull.execute;
  assert.deepEqual(ownNull.bridgeCalls, [{ operation: 'overseasComponents', codes: ['usNDX'] }]);
});

test('security seed ownership probes precede value reads without reading an unused observedAt', async () => {
  const reads = [];
  const seed = new Proxy({ price: 100, changePct: 0, sourceTime: TIME, status: 'current' }, {
    getOwnPropertyDescriptor(target, key) { reads.push(`own:${key}`); return Reflect.getOwnPropertyDescriptor(target, key); },
    get(target, key) { reads.push(`get:${key}`); if (key === 'observedAt') throw new Error('unused source clock'); return target[key]; },
  });
  const seeds = new Proxy({ usNDX: seed }, {
    getOwnPropertyDescriptor(target, key) { reads.push(`own-seed:${key}`); return Reflect.getOwnPropertyDescriptor(target, key); },
    get(target, key) { reads.push(`get-seed:${key}`); return target[key]; },
  });
  const h = run(makePlan([], ['usNDX']), { seedQuotes: seeds });
  assert.deepEqual((await h.execute).modelQuotes.usNDX, { price: 100, changePct: 0, sourceTime: TIME });
  assert.deepEqual(reads, ['own-seed:usNDX', 'get-seed:usNDX', 'own:status', 'get:status',
    'get:price', 'get:changePct', 'own:sourceTime', 'get:sourceTime']);
  assert.equal(h.scope.snapshot().requests, 0);
  assert.equal(h.scope.snapshot().cacheWrites, 0);
});

test('security seed own-probe and accessor errors propagate before network or cache side effects', async () => {
  const expected = ['own-seed:usNDX', 'get-seed:usNDX', 'own:status', 'get:status',
    'get:price', 'get:changePct', 'own:sourceTime', 'get:sourceTime'];
  for (const failAt of expected) {
    const reads = [], sentinel = new Error(`synthetic ${failAt}`);
    const visit = step => { reads.push(step); if (step === failAt) throw sentinel; };
    const seed = new Proxy({ price: 100, changePct: 0, sourceTime: TIME, status: 'current' }, {
      getOwnPropertyDescriptor(target, key) { visit(`own:${key}`); return Reflect.getOwnPropertyDescriptor(target, key); },
      get(target, key) { visit(`get:${key}`); return target[key]; },
    });
    const seeds = new Proxy({ usNDX: seed }, {
      getOwnPropertyDescriptor(target, key) { visit(`own-seed:${key}`); return Reflect.getOwnPropertyDescriptor(target, key); },
      get(target, key) { visit(`get-seed:${key}`); return target[key]; },
    });
    const h = run(makePlan([], ['usNDX']), { seedQuotes: seeds });
    await assert.rejects(h.execute, error => error === sentinel);
    assert.deepEqual(reads, expected.slice(0, expected.indexOf(failAt) + 1));
    assert.deepEqual(h.emCalls, []);
    assert.deepEqual(h.bridgeCalls, []);
    assert.equal(h.scope.snapshot().requests, 0);
    assert.equal(h.scope.snapshot().cacheWrites, 0);
  }
});
