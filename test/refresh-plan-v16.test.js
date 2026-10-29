import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshPlan, createSecurityQuotePlan } from '../js/runtime/refresh-plan.js';
import { TTL } from '../js/config.js';

const NOW = Date.parse('2026-09-30T14:00:00+08:00');
const CN = Object.freeze({ code: '005844', name: '东方人工智能主题混合A', shares: 0 });
const OVERSEAS = Object.freeze({ code: '012920', name: '易方达全球成长精选混合(QDII)人民币A', shares: 100 });
const INDEX_CODES = ['sh000001', 'sh000300', 'usINX', 'usNDX'];

function fresh(ttl, extra = {}) {
  return { validated: true, fetchedAt: NOW - 100, cachedAt: NOW - 50, expiresAt: NOW + ttl - 50, ...extra };
}

function plan(extra = {}) {
  return createRefreshPlan({ generation: 1, trigger: 'manual', now: NOW, activeHoldings: [CN, OVERSEAS], ...extra });
}

function resource(value, key) {
  const entry = value.resources.find(item => item.key === key);
  assert.ok(entry, `missing planned resource ${key}`);
  return entry;
}

test('activity is canonical: deleted and invalid codes are absent, zero-share watch items remain, order is retained', () => {
  const value = plan({ activeHoldings: [OVERSEAS, { code: '000001', deleted: true }, CN,
    { fundCode: '000002', deletedAt: '2026-09-29T00:00:00Z' }, { code: 'invalid' },
    { ...CN, shares: 999 }, { fundCode: '000003', name: '合成指数基金', shares: 10 }] });
  assert.deepEqual(value.activeCodes, ['012920', '005844', '000003']);
  assert.deepEqual(resource(value, 'estimates:000003,005844,012920').codes, ['000003', '005844', '012920']);
  assert.equal(value.resources.filter(item => item.key === 'nav:005844').length, 1);
  assert.equal(value.resources.some(item => item.code === '000001' || item.code === '000002'), false);
});

test('plans the real estimate batch, four configured indices, gold and stable resources', () => {
  const value = plan();
  assert.equal(resource(value, 'estimates:005844,012920').provider, 'sinan-estimate-proxy');
  assert.deepEqual(resource(value, 'indices:sh000001,sh000300,usINX,usNDX').codes, INDEX_CODES);
  assert.equal(resource(value, 'gold:AU9999').ttlMs, TTL.GOLD);
  for (const code of value.activeCodes) {
    assert.equal(resource(value, `nav:${code}`).ttlMs, TTL.OFFICIAL_NAV);
    assert.equal(resource(value, `meta:${code}`).ttlMs, TTL.FUND_META);
  }
  assert.equal(resource(value, 'holdings:005844').ttlMs, TTL.HOLDINGS);
  assert.equal(resource(value, 'holdings:012920').action, 'skip');
  assert.equal(resource(value, 'holdings:012920').reason, 'market_ineligible');
});

test('an empty active portfolio does not send an empty estimates request but retains the market bar plan', () => {
  const value = plan({ activeHoldings: [] });
  assert.deepEqual(value.activeCodes, []);
  assert.equal(value.resources.some(item => item.kind === 'estimates'), false);
  assert.equal(value.resources.filter(item => item.kind === 'indices').length, 1);
  assert.equal(value.resources.filter(item => item.kind === 'gold').length, 1);
});

test('one initial plan reserves exact second-phase resource keys without guessing codes or reusing a global union cache', () => {
  const value = plan({ trigger: 'diagnostic', forceLive: true, forceStable: ['securities:union', 'models:active'],
    cacheIndex: { 'securities:union': fresh(TTL.INTRADAY), 'models:active': fresh(TTL.INTRADAY) } });
  assert.deepEqual(resource(value, 'securities:union'), {
    key: 'securities:union', kind: 'securities', provider: 'eastmoney-security-quote',
    action: 'fetch', reason: 'phase_pending', cacheExpiresAt: null, ttlMs: TTL.INTRADAY,
  });
  assert.deepEqual(resource(value, 'models:active'), {
    key: 'models:active', kind: 'model-quotes', provider: 'tencent-market-quote',
    action: 'fetch', reason: 'phase_pending', cacheExpiresAt: null, ttlMs: TTL.INTRADAY,
  });
  assert.deepEqual(value.phases.find(item => item.name === 'securities').resourceKeys, ['securities:union', 'models:active']);
  assert.equal(value.resources.filter(item => item.key === 'securities:union').length, 1);
  assert.equal(value.resources.filter(item => item.key === 'models:active').length, 1);
  assert.equal(Object.isFrozen(value.phases.find(item => item.name === 'securities').resourceKeys), true);
});

test('no active holdings disables both second-phase resources, including a portfolio containing only tombstones', () => {
  for (const activeHoldings of [[], [{ code: '005844', deleted: true }, { fundCode: '012920', deletedAt: '2026-09-30' }]]) {
    const value = plan({ activeHoldings, forceLive: true, trigger: 'diagnostic', forceStable: ['securities:union', 'models:active'] });
    for (const key of ['securities:union', 'models:active']) {
      assert.equal(resource(value, key).action, 'skip');
      assert.equal(resource(value, key).reason, 'no_active_holdings');
      assert.equal(resource(value, key).cacheExpiresAt, null);
      assert.equal('codes' in resource(value, key), false);
    }
  }
});

test('ordinary forceLive bypasses only volatile resources and never stable TTL', () => {
  const cacheIndex = {
    'estimates:005844,012920': fresh(TTL.INTRADAY),
    'indices:sh000001,sh000300,usINX,usNDX': fresh(TTL.INDEX),
    'gold:AU9999': fresh(TTL.GOLD),
    'nav:005844': fresh(TTL.OFFICIAL_NAV), 'nav:012920': fresh(TTL.OFFICIAL_NAV),
    'holdings:005844': fresh(TTL.HOLDINGS),
    'meta:005844': fresh(TTL.FUND_META), 'meta:012920': fresh(TTL.FUND_META),
  };
  for (const trigger of ['manual', 'timer', 'startup', 'visibility', 'online', 'data-change', 'notification']) {
    const value = plan({ trigger, cacheIndex, forceLive: true, forceStable: ['nav:005844', 'holdings:005844', 'meta:005844'] });
    for (const key of ['estimates:005844,012920', 'indices:sh000001,sh000300,usINX,usNDX', 'gold:AU9999']) {
      assert.equal(resource(value, key).action, 'fetch', `${trigger}: ${key}`);
      assert.equal(resource(value, key).reason, 'force_live');
    }
    for (const key of ['nav:005844', 'nav:012920', 'holdings:005844', 'meta:005844', 'meta:012920']) {
      assert.equal(resource(value, key).action, 'cache', `${trigger}: ${key}`);
      assert.equal(resource(value, key).reason, 'fresh_cache');
    }
  }
});

test('without forceLive fresh volatile data is reused', () => {
  const value = plan({ cacheIndex: { 'gold:AU9999': fresh(TTL.GOLD, { status: 'current' }) } });
  assert.equal(resource(value, 'gold:AU9999').action, 'cache');
});

test('cache hits carry an immutable TTL ceiling for a later acquisition-time recheck; all other actions carry null', () => {
  const entry = fresh(TTL.FUND_META);
  const cached = resource(plan({ cacheIndex: { 'nav:005844': entry } }), 'nav:005844');
  assert.equal(cached.cacheExpiresAt, entry.cachedAt + TTL.OFFICIAL_NAV);
  const shortExpiry = fresh(TTL.OFFICIAL_NAV, { expiresAt: NOW + 5 });
  assert.equal(resource(plan({ cacheIndex: { 'nav:005844': shortExpiry } }), 'nav:005844').cacheExpiresAt, NOW + 5);
  for (const item of plan({ forceLive: true }).resources) assert.equal(item.cacheExpiresAt, null);
  const forced = plan({ trigger: 'diagnostic', cacheIndex: { 'nav:005844': entry }, forceStable: ['nav:005844'] });
  assert.equal(resource(forced, 'nav:005844').cacheExpiresAt, null);
  entry.expiresAt = NOW + 1;
  assert.equal(cached.cacheExpiresAt, NOW - 50 + TTL.OFFICIAL_NAV);
});

test('diagnostic stable forcing is exact-key scoped; wildcards and unrelated keys do not override other resources', () => {
  const cacheIndex = { 'nav:005844': fresh(TTL.OFFICIAL_NAV), 'nav:012920': fresh(TTL.OFFICIAL_NAV),
    'holdings:005844': fresh(TTL.HOLDINGS), 'meta:005844': fresh(TTL.FUND_META) };
  const value = plan({ trigger: 'diagnostic', cacheIndex, forceStable: ['nav:005844', 'nav:*', '*', 'meta:999999'] });
  assert.equal(resource(value, 'nav:005844').action, 'fetch');
  assert.equal(resource(value, 'nav:005844').reason, 'force_stable');
  for (const key of ['nav:012920', 'holdings:005844', 'meta:005844']) assert.equal(resource(value, key).action, 'cache');
  assert.equal(resource(value, 'holdings:012920').action, 'skip');
});

test('cache expiry boundary is strict and is never rewritten by the planner', () => {
  for (const [expiresAt, action] of [[NOW + 1, 'cache'], [NOW, 'fetch'], [NOW - 1, 'fetch']]) {
    const entry = fresh(TTL.OFFICIAL_NAV, { expiresAt });
    const before = structuredClone(entry);
    assert.equal(resource(plan({ cacheIndex: { 'nav:005844': entry } }), 'nav:005844').action, action);
    assert.deepEqual(entry, before);
  }
});

test('resource TTL is an upper bound even when supplied metadata advertises a longer expiry', () => {
  const entry = { validated: true, fetchedAt: NOW - TTL.OFFICIAL_NAV, cachedAt: NOW - TTL.OFFICIAL_NAV,
    expiresAt: NOW + TTL.FUND_META };
  const value = resource(plan({ cacheIndex: { 'nav:005844': entry } }), 'nav:005844');
  assert.equal(value.action, 'fetch');
  assert.equal(value.reason, 'cache_expired');
});

test('invalid and unordered cache epochs fail closed rather than creating a fresh hit', () => {
  const invalid = [
    { validated: false }, { validated: 'true' }, { fetchedAt: '1' }, { cachedAt: NaN },
    { expiresAt: Infinity }, { cachedAt: -1 }, { fetchedAt: 1.5 },
    { fetchedAt: NOW + 1 }, { cachedAt: NOW + 1 }, { fetchedAt: NOW, cachedAt: NOW - 1 },
    { expiresAt: NOW - 51 }, { cachedAt: undefined }, { fetchedAt: undefined },
  ];
  for (const extra of invalid) {
    const value = resource(plan({ cacheIndex: { 'nav:005844': fresh(TTL.OFFICIAL_NAV, extra) } }), 'nav:005844');
    assert.equal(value.action, 'fetch', JSON.stringify(extra));
    assert.equal(value.reason, 'cache_metadata_invalid', JSON.stringify(extra));
  }
});

test('stale, unavailable, failed or unknown quality cannot be laundered by a valid TTL', () => {
  for (const extra of [{ status: 'stale' }, { status: 'unavailable' }, { status: 'error' }, { status: 'degraded' },
    { status: 'unknown_provider_enum' }, { sourceTier: 'unknown_provider_enum' }, { cacheState: 'expired' }]) {
    const value = resource(plan({ cacheIndex: { 'nav:005844': fresh(TTL.OFFICIAL_NAV, extra) } }), 'nav:005844');
    assert.equal(value.action, 'fetch', JSON.stringify(extra));
  }
  assert.equal(resource(plan({ cacheIndex: { 'nav:005844': fresh(TTL.OFFICIAL_NAV, { sourceTier: 'cache', status: 'delayed', cacheState: 'fresh' }) } }), 'nav:005844').action, 'cache');
});

test('cache metadata is read only from own resource keys', () => {
  const cacheIndex = Object.create({ 'nav:005844': fresh(TTL.OFFICIAL_NAV) });
  assert.equal(resource(plan({ cacheIndex }), 'nav:005844').action, 'fetch');
  assert.equal(resource(plan({ cacheIndex: { 'nav:005844': Object.create(fresh(TTL.OFFICIAL_NAV)) } }), 'nav:005844').action, 'fetch');
});

test('cache values are not retained or exposed and all planned structures are immutable', () => {
  const payload = { privateAmount: 999, sourceDate: '2026-09-29' };
  const cacheIndex = { 'nav:005844': fresh(TTL.OFFICIAL_NAV, { payload }) };
  const holdings = [{ ...CN }, { ...OVERSEAS }];
  const before = structuredClone({ cacheIndex, holdings });
  const value = plan({ cacheIndex, activeHoldings: holdings });
  assert.deepEqual({ cacheIndex, holdings }, before);
  assert.equal(JSON.stringify(value).includes('privateAmount'), false);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.resources), true);
  assert.equal(Object.isFrozen(value.activeCodes), true);
  for (const item of value.resources) assert.equal(Object.isFrozen(item), true);
  assert.throws(() => value.activeCodes.push('999999'), TypeError);
  assert.throws(() => resource(value, 'nav:005844').action = 'fetch', TypeError);
  payload.sourceDate = '2020-01-01';
  assert.equal(JSON.stringify(value).includes('2020-01-01'), false);
});

test('generation and now are explicit valid epochs; no hidden wall-clock dependency exists', () => {
  for (const generation of [0, -1, 1.5, '1', null, undefined]) assert.throws(() => plan({ generation }), TypeError);
  for (const now of [NaN, Infinity, -1, NOW + 0.5, '2026-09-30', null, undefined]) assert.throws(() => plan({ now }), TypeError);
  const originalNow = Date.now;
  Date.now = () => { throw new Error('planner must not read the wall clock'); };
  try {
    const first = plan();
    assert.deepEqual(plan(), first);
    assert.equal(first.plannedAt, NOW);
  } finally { Date.now = originalNow; }
});

test('holdings eligibility follows existing fund market classification', () => {
  const value = plan({ activeHoldings: [{ code: '000001', name: '合成股票混合' }, { code: '000002', name: '沪深300指数基金' },
    { code: '000003', name: '恒生香港股票' }, { code: '000004', name: '日本股票(QDII)' }] });
  for (const code of ['000001', '000002', '000003']) assert.equal(resource(value, `holdings:${code}`).action, 'fetch');
  assert.equal(resource(value, 'holdings:000004').action, 'skip');
});

test('security union dedupes qualified identities across funds and keeps different markets separate', () => {
  const value = createSecurityQuotePlan({ generation: 1, snapshots: [
    { fundCode: '005844', validated: true, status: 'ok', items: [{ quoteCode: 'sh000001' }, { quoteCode: 'sz000001' }] },
    { fundCode: '000003', validated: true, status: 'ok', items: [{ quoteCode: 'sh000001' }, { quoteCode: 'hk00700' }] },
  ] });
  assert.deepEqual(value.securityCodes, ['hk00700', 'sh000001', 'sz000001']);
  assert.deepEqual(value.qualifiedCodes, value.securityCodes);
});

test('selected model main and fallback legs are unioned; unselected global configuration is not consumed', () => {
  const selected = [{ legs: [{ code: 'usQQQ' }, { code: 'usSPY' }, { code: 'AU9999' }],
    fallback: { legs: [{ code: 'usSPY' }, { code: 'r_hkHSI' }] } }];
  const value = createSecurityQuotePlan({ generation: 3, selectedModels: selected, indexCodes: ['usNDX', 'usINX'] });
  assert.deepEqual(value.modelCodes, ['r_hkHSI', 'usQQQ', 'usSPY']);
  assert.deepEqual(value.indexCodes, ['usINX', 'usNDX']);
  assert.deepEqual(value.qualifiedCodes, ['r_hkHSI', 'usINX', 'usNDX', 'usQQQ', 'usSPY']);
  assert.equal(value.goldRequired, true);
  assert.equal(value.qualifiedCodes.includes('usEEM'), false);
  assert.deepEqual(selected[0].fallback.legs, [{ code: 'usSPY' }, { code: 'r_hkHSI' }]);
});

test('unvalidated or degraded snapshots and operation-incompatible codes are not requested', () => {
  const value = createSecurityQuotePlan({ generation: 1, snapshots: [
    { validated: false, status: 'ok', items: [{ quoteCode: 'usSPY' }] },
    { validated: true, status: 'degraded', items: [{ quoteCode: 'usQQQ' }] },
    { validated: true, status: 'ok', items: [{ quoteCode: 'r_hkHSI' }, { quoteCode: '000001' }, { quoteCode: 'hk00700' }] },
  ], selectedModels: [{ legs: [{ code: 'hk00700' }, { code: '<script>' }] }], indexCodes: ['usNDX', 'usQQQ'] });
  assert.deepEqual(value.securityCodes, ['hk00700']);
  assert.deepEqual(value.modelCodes, []);
  assert.deepEqual(value.indexCodes, ['usNDX']);
  assert.equal(value.rejected.length, 7);
});

test('a code needed by both index and model has one qualified identity without widening Bridge operations', () => {
  const value = createSecurityQuotePlan({ generation: 1, selectedModels: [{ legs: [{ code: 'usNDX' }] }], indexCodes: ['usNDX'] });
  assert.deepEqual(value.qualifiedCodes, ['usNDX']);
  assert.deepEqual(value.modelCodes, ['usNDX']);
  assert.deepEqual(value.indexCodes, ['usNDX']);
  assert.equal(Object.isFrozen(value.qualifiedCodes), true);
  assert.equal(Object.isFrozen(value.rejected), true);
  assert.throws(() => value.modelCodes.push('usSPY'), TypeError);
});
