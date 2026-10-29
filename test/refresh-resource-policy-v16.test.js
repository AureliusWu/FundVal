import test from 'node:test';
import assert from 'node:assert/strict';
import { TTL } from '../js/config.js';
import { createRefreshPlan } from '../js/runtime/refresh-plan.js';
import { makeRefreshResourceEntry, validateRefreshResourceEntry } from '../js/runtime/refresh-resource-cache.js';

const loadPolicy = () => import('../js/runtime/refresh-resource-policy.js');
const NOW = Date.parse('2026-09-30T06:00:00Z');
const CODE = '005844';
const INDICES = ['sh000001', 'sh000300', 'usINX', 'usNDX'];
const INDEX_KEY = `indices:${INDICES.join(',')}`;
const policies = [
  [`nav:${CODE}`, 'nav', 'eastmoney-official-nav', 'secondary', TTL.OFFICIAL_NAV],
  [`holdings:${CODE}`, 'holdings', 'sinan-holdings-proxy', 'primary', TTL.HOLDINGS],
  [`meta:${CODE}`, 'meta', 'eastmoney-official-nav', 'secondary', TTL.FUND_META],
  ['gold:AU9999', 'gold', 'eastmoney-security-quote', 'secondary', TTL.GOLD],
  [INDEX_KEY, 'indices', 'tencent-market-quote', 'secondary', TTL.INDEX],
  [`estimates:${CODE}`, 'estimates', 'sinan-estimate-proxy', 'primary', TTL.INTRADAY],
];
const fixtures = {
  nav: { code: CODE, nav: 1.1, prevNav: 1, date: '2026-09-29', prevDate: '2026-09-28', status: 'current' },
  holdings: { code: CODE, wireVersion: 2, reportDate: '2026-06-30', status: 'ok', sourceStatus: 'ok',
    items: [{ code: '600001', name: 'Synthetic stock', market: 'sh', ratio: 20 }] },
  meta: { code: CODE, meta: {} },
  gold: { code: 'AU9999', price: 100, changePct: 0, observedAt: '2026-09-30T05:59:00Z', status: 'current' },
  indices: { codes: INDICES, quotes: INDICES.map(code => ({ code, price: 100, changePct: null,
    observedAt: '2026-09-30T05:59:00Z', status: 'current' })) },
  estimates: { codes: [CODE], rows: [{ code: CODE, status: 'ok', source_quote: {
    fundCode: CODE, market: 'cn', assetKind: 'fund', valueKind: 'intraday_estimate', value: 1.1, changePct: 0,
    baseNav: 1, baseNavDate: '2026-09-29', targetDate: '2026-09-30', sourceId: 'sinan-estimate-proxy',
    sourceTier: 'primary', status: 'realtime', observedAt: '2026-09-30T05:59:00Z', fetchedAt: '2026-09-30T06:00:00Z',
  } }] },
};
const sourceDate = kind => kind === 'nav' || kind === 'meta' ? '2026-09-29' : kind === 'holdings' ? '2026-06-30' : '2026-09-30';

test('characterization: planner and cache already bind the exact same six resource policies', () => {
  const plan = createRefreshPlan({ generation: 1, now: NOW, activeHoldings: [{ code: CODE, name: 'Synthetic mixed fund', shares: 0 }] });
  for (const [key, kind, source, tier, ttlMs] of policies) {
    const planned = plan.resources.find(item => item.key === key);
    assert.equal(planned.kind, kind);
    assert.equal(planned.provider, source);
    assert.equal(planned.ttlMs, ttlMs);
    const payload = { ...fixtures[kind], source };
    const before = structuredClone(payload);
    const entry = makeRefreshResourceEntry(key, payload, { now: NOW, sourceDate: sourceDate(kind) });
    assert.ok(entry, key);
    assert.equal(entry.originalSource, source);
    assert.equal(entry.originalSourceTier, tier);
    assert.equal(entry.ttlMs, ttlMs);
    assert.deepEqual(payload, before);
    assert.equal(validateRefreshResourceEntry(key, entry, { now: NOW + ttlMs - 1 }).cacheState, 'fresh');
    assert.equal(validateRefreshResourceEntry(key, entry, { now: NOW + ttlMs }).cacheState, 'stale');
    assert.equal(validateRefreshResourceEntry(key, { ...entry, ttlMs: ttlMs + 1, expiresAt: entry.expiresAt + 1 }, { now: NOW }), null);
    assert.equal(validateRefreshResourceEntry(key, { ...entry, originalSource: source === 'eastmoney-official-nav' ? 'sinan-estimate-proxy' : 'eastmoney-official-nav' }, { now: NOW }), null);
    assert.equal(validateRefreshResourceEntry(key, { ...entry, originalSourceTier: tier === 'primary' ? 'secondary' : 'primary' }, { now: NOW }), null);
  }
});

test('shared policy returns fixed immutable identities without adding persistence fields', async () => {
  const { refreshResourcePolicy: policy, REFRESH_INDEX_KEY } = await loadPolicy();
  assert.equal(REFRESH_INDEX_KEY, INDEX_KEY);
  for (const [key, kind, source, tier, ttlMs] of policies) {
    const result = policy(key);
    const identity = kind === 'indices' ? { codes: INDICES } : kind === 'estimates' ? { codes: [CODE] }
      : { code: kind === 'gold' ? 'AU9999' : CODE };
    assert.deepEqual(result, { kind, ...identity, source, tier, ttlMs });
    assert.equal(Object.isFrozen(result), true);
    if (result.codes) assert.equal(Object.isFrozen(result.codes), true);
    assert.notEqual(policy(key), result);
  }
});

test('policy key parser preserves exact six-digit, sorted unique batch and fixed index constraints', async () => {
  const { refreshResourcePolicy: policy } = await loadPolicy();
  const fifty = Array.from({ length: 50 }, (_, index) => String(index + 1).padStart(6, '0'));
  assert.deepEqual(policy(`estimates:${fifty.join(',')}`).codes, fifty);
  for (const key of [null, false, 0, {}, '', 'nav:5844', 'nav:005844 ', 'nav:005844:extra', 'nav:../005844',
    'holdings:00000a', 'meta:0000000', 'NAV:005844', 'gold:AU999', 'gold:au9999', 'estimates:',
    'estimates:005844,000001', 'estimates:005844,005844', 'estimates:005844,', 'estimates:005844,invalid',
    `estimates:${[...fifty, '000051'].join(',')}`, `indices:${[...INDICES].reverse().join(',')}`,
    'indices:usSPY', 'securities:union', 'models:active']) assert.equal(policy(key), null, String(key));
});

test('shared helpers are strict predicates, never epoch coercion or a fallback clock', async () => {
  const { policyEpoch: epoch, policyRecord: record, policyOwn: own } = await loadPolicy();
  for (const value of [0, NOW, 8.64e15]) assert.equal(epoch(value), true);
  for (const value of [null, undefined, '', '0', '1', true, false, -1, .1, NaN, Infinity, 8.64e15 + 1,
    new Date(NOW), new Number(NOW), {}, []]) assert.equal(epoch(value), false);
  for (const value of [{}, Object.create(null), new Date(NOW)]) assert.equal(record(value), true);
  for (const value of [null, undefined, [], 0, '', false, () => {}]) assert.equal(record(value), false);
  const inherited = Object.create({ value: 1 });
  assert.equal(own(inherited, 'value'), false);
  inherited.value = 0;
  assert.equal(own(inherited, 'value'), true);
});

test('shared estimate policy and planner retain the 50/51 split without dropping zero-share watches', async () => {
  const { refreshResourcePolicy: policy } = await loadPolicy();
  const holdings = Array.from({ length: 51 }, (_, index) => ({ code: String(index + 1).padStart(6, '0'), name: 'Synthetic fund', shares: 0 }));
  const plan = createRefreshPlan({ generation: 1, now: NOW, activeHoldings: holdings });
  const batches = plan.resources.filter(resource => resource.kind === 'estimates');
  assert.deepEqual(batches.map(batch => batch.codes.length), [50, 1]);
  assert.equal(plan.activeCodes.length, 51);
  for (const batch of batches) {
    const spec = policy(batch.key);
    assert.deepEqual(batch.codes, spec.codes);
    assert.equal(batch.provider, spec.source);
    assert.equal(batch.ttlMs, spec.ttlMs);
    assert.equal(Object.isFrozen(batch.codes), true);
  }
  assert.equal(Object.isFrozen(holdings), false);
});
