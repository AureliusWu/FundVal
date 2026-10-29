import test from 'node:test';
import assert from 'node:assert/strict';
import { TTL } from '../js/config.js';

const module = () => import('../js/runtime/refresh-resource-cache.js');
const NOW = Date.parse('2026-09-30T06:00:00Z');
const CODE = '005844';
const INDEX_CODES = ['sh000001', 'sh000300', 'usINX', 'usNDX'];
const INDEX_KEY = `indices:${INDEX_CODES.join(',')}`;
const META = { scale: '10 亿', manager: 'Synthetic manager', managerWorkTime: '1年', managerId: '001', sourceRate: '1.5', currentRate: '0.15' };
const nav = extra => ({ code: CODE, source: 'eastmoney-official-nav', status: 'current',
  nav: 1.1, prevNav: 1, date: '2026-09-29', prevDate: '2026-09-28', change: 10,
  changeAmt: 0.1, fundName: 'Synthetic fund', meta: { ...META }, ...extra });
const holdings = extra => ({ code: CODE, source: 'sinan-holdings-proxy', status: 'ok', sourceStatus: 'ok', wireVersion: 2,
  reportDate: '2026-06-30', items: [{ code: '600001', name: 'Synthetic stock', market: 'sh', ratio: 20 }], ...extra });
const gold = extra => ({ code: 'AU9999', source: 'eastmoney-security-quote', price: 100, changePct: 0,
  observedAt: '2026-09-30T05:59:00Z', status: 'current', cached: false, ...extra });
const indices = () => ({ source: 'tencent-market-quote', codes: [...INDEX_CODES], quotes: INDEX_CODES.map((code, index) => ({
  code, price: 100 + index, changePct: index ? null : 0, observedAt: '2026-09-30T05:59:00Z', status: 'current',
})) });
const quote = extra => ({ fundCode: CODE, fundName: 'Synthetic fund', market: 'cn', assetKind: 'fund',
  valueKind: 'intraday_estimate', value: 1.1, changePct: 0, baseNav: 1, baseNavDate: '2026-09-29', targetDate: '2026-09-30',
  sourceId: 'sinan-estimate-proxy', sourceTier: 'primary', status: 'realtime', observedAt: '2026-09-30T05:59:00Z',
  fetchedAt: '2026-09-30T06:00:00Z', reasonCodes: [], ...extra });
const estimates = rows => ({ source: 'sinan-estimate-proxy', codes: [CODE], rows: rows || [{
  code: CODE, name: 'Synthetic fund', status: 'ok', est_change: 0, source_quote: quote(),
}] });
const makeOptions = (sourceDate, extra = {}) => ({ now: NOW, fetchedAt: NOW, sourceDate, ...extra });

test('resource envelope binds fixed source, TTL, identity and original acquisition metadata', async () => {
  const { makeRefreshResourceEntry, validateRefreshResourceEntry } = await module();
  const entry = makeRefreshResourceEntry(`nav:${CODE}`, nav(), makeOptions('2026-09-29'));
  assert.ok(entry);
  assert.equal(entry.originalSource, 'eastmoney-official-nav');
  assert.equal(entry.originalSourceTier, 'secondary');
  assert.equal(entry.ttlMs, TTL.OFFICIAL_NAV);
  assert.equal(entry.fetchedAt, NOW);
  assert.equal(entry.cachedAt, NOW);
  assert.equal(entry.sourceDate, '2026-09-29');
  assert.equal(validateRefreshResourceEntry(`nav:${CODE}`, entry, { now: NOW }).cacheState, 'fresh');
  assert.equal(validateRefreshResourceEntry(`nav:${CODE}`, entry, { now: NOW + TTL.OFFICIAL_NAV }).cacheState, 'stale');
});

test('NAV source date, prices, interval and arithmetic cannot be invented or conflict', async () => {
  const { makeRefreshResourceEntry: make } = await module();
  for (const extra of [{ code: '000001' }, { source: 'sinan-estimate-proxy' }, { nav: 0 }, { nav: null },
    { nav: true }, { nav: '1.1' }, { prevNav: Infinity }, { prevDate: '2026-09-29' }, { date: '2026-02-30' },
    { change: 20 }, { changeAmt: 1 }, { cached: true }, { sourceTier: 'cache' }]) {
    assert.equal(make(`nav:${CODE}`, nav(extra), makeOptions('2026-09-29')), null);
  }
  assert.equal(make(`nav:${CODE}`, nav(), makeOptions('2026-09-30')), null);
  assert.equal(make('nav:../005844', nav(), makeOptions('2026-09-29')), null);
});

test('holdings are admitted only after complete set/report/source quality validation', async () => {
  const { makeRefreshResourceEntry: make } = await module();
  const entry = make(`holdings:${CODE}`, holdings(), makeOptions('2026-06-30'));
  assert.ok(entry);
  assert.equal(entry.originalSource, 'sinan-holdings-proxy');
  assert.equal(entry.originalSourceTier, 'primary');
  assert.equal(entry.ttlMs, TTL.HOLDINGS);
  for (const extra of [{ status: 'degraded' }, { sourceStatus: 'partial' }, { sourceStatus: 'stale' },
    { source: 'sinan-estimate-proxy' }, { code: '000001' }, { reportDate: '2026-01-01' }, { items: [] },
    { items: [holdings().items[0], holdings().items[0]] }, { items: [{ ...holdings().items[0], ratio: 101 }] }]) {
    assert.equal(make(`holdings:${CODE}`, holdings(extra), makeOptions('2026-06-30')), null);
  }
});

test('metadata is a bounded allowlist of trusted strings, not arbitrary persisted upstream data', async () => {
  const { makeRefreshResourceEntry: make } = await module();
  const payload = { code: CODE, source: 'eastmoney-official-nav', meta: { ...META } };
  assert.equal(make(`meta:${CODE}`, payload, makeOptions('2026-09-29')).ttlMs, TTL.FUND_META);
  for (const meta of [{ ...META, scale: 0 }, { ...META, manager: '<script>' }, { ...META, token: 'synthetic-secret' }]) {
    assert.equal(make(`meta:${CODE}`, { ...payload, meta }, makeOptions('2026-09-29')), null);
  }
});

test('gold retains a real zero or null change and rejects wrong identities or future observations', async () => {
  const { makeRefreshResourceEntry: make } = await module();
  const entry = make('gold:AU9999', gold(), makeOptions('2026-09-30'));
  assert.equal(entry.payload.changePct, 0);
  assert.equal(entry.ttlMs, TTL.GOLD);
  assert.equal(make('gold:AU9999', gold({ changePct: null }), makeOptions('2026-09-30')).payload.changePct, null);
  for (const extra of [{ code: 'AU999' }, { source: 'tencent-market-quote' }, { price: 0 }, { price: null },
    { changePct: false }, { observedAt: null }, { observedAt: '2026-09-30T06:00:01Z' }, { cached: true }]) {
    assert.equal(make('gold:AU9999', gold(extra), makeOptions('2026-09-30')), null);
  }
  const old = make('gold:AU9999', gold({ observedAt: '2026-09-29T05:00:00Z', status: 'stale' }), makeOptions('2026-09-29'));
  assert.equal(old.payload.status, 'stale');
  assert.equal(old.payload.observedAt, '2026-09-29T05:00:00Z');
});

test('indices require the exact requested identities and preserve per-instrument dates and quality', async () => {
  const { makeRefreshResourceEntry: make, readRefreshResources: read } = await module();
  const payload = indices();
  payload.quotes[2].observedAt = '2026-09-29T20:00:00Z';
  payload.quotes[2].status = 'stale';
  const entry = make(INDEX_KEY, payload, makeOptions('2026-09-30'));
  assert.ok(entry);
  assert.deepEqual(entry.payload, payload);
  assert.equal(read({ refreshResources: { [INDEX_KEY]: entry } }, { now: NOW }).cacheIndex[INDEX_KEY].status, 'ok');
  for (const mutate of [p => p.codes.reverse(), p => p.quotes.pop(), p => p.quotes[0].code = 'sh000300',
    p => p.quotes[0].price = 0, p => p.quotes[0].changePct = '', p => p.quotes[0].status = 'invented',
    p => p.quotes[0].observedAt = '2026-09-30T06:00:01Z']) {
    const invalid = indices(); mutate(invalid);
    assert.equal(make(INDEX_KEY, invalid, makeOptions('2026-09-30')), null);
  }
});

test('explicit partial indices retain only validated instruments, never synthesize missing rows', async () => {
  const { makeRefreshResourceEntry: make, validateRefreshResourceEntry: validate } = await module();
  const payload = { ...indices(), status: 'partial' };
  payload.quotes = payload.quotes.slice(0, 2);
  const entry = make(INDEX_KEY, payload, makeOptions('2026-09-30'));
  assert.ok(entry);
  assert.equal(entry.payload.status, 'partial');
  assert.deepEqual(entry.payload.codes, INDEX_CODES);
  assert.deepEqual(entry.payload.quotes, payload.quotes);
  assert.equal(entry.payload.quotes[0].changePct, 0);
  assert.equal(entry.payload.quotes[1].changePct, null);
  assert.equal(validate(INDEX_KEY, entry, { now: NOW + TTL.INDEX }).cacheState, 'stale');
  for (const rows of [[], [payload.quotes[0], payload.quotes[0]],
    [{ ...payload.quotes[0], code: 'usSPY' }], [{ ...payload.quotes[0], observedAt: '2027-01-01T00:00:00Z' }]]) {
    assert.equal(make(INDEX_KEY, { ...payload, quotes: rows }, makeOptions('2026-09-30')), null);
  }
});

test('read validates source/tier/canonical TTL and retains only active fund resources', async () => {
  const { makeRefreshResourceEntry: make, readRefreshResources: read } = await module();
  const entry = make(`nav:${CODE}`, nav(), makeOptions('2026-09-29'));
  const raw = { data: [], refreshResources: { [`nav:${CODE}`]: entry, 'nav:000001': { ...entry, payload: nav({ code: '000001' }) } } };
  const result = read(JSON.stringify(raw), { now: NOW, activeCodes: [CODE] });
  assert.deepEqual(Object.keys(result.entries), [`nav:${CODE}`]);
  assert.equal(result.cacheIndex[`nav:${CODE}`].validated, true);
  assert.equal(result.cacheIndex[`nav:${CODE}`].sourceTier, 'cache');
  for (const extra of [{ originalSource: 'sinan-estimate-proxy' }, { originalSourceTier: 'primary' },
    { ttlMs: TTL.FUND_META, expiresAt: NOW + TTL.FUND_META }, { fetchedAt: NOW + 1 }, { schemaVersion: 99 }]) {
    assert.equal(Object.keys(read({ refreshResources: { [`nav:${CODE}`]: { ...entry, ...extra } } }, { now: NOW, activeCodes: [CODE] }).entries).length, 0);
  }
  for (const value of [null, '{', '[]', false]) assert.deepEqual(Object.keys(read(value, { now: NOW }).entries), []);
});

test('legacy NAV adaptation is read-only and cannot renew original expiry', async () => {
  const { readRefreshResources: read } = await module();
  const oldMove = nav(); delete oldMove.code; delete oldMove.source;
  const legacy = { data: oldMove, fetchedAt: NOW - TTL.OFFICIAL_NAV - 1, source: 'official-nav' };
  const before = structuredClone(legacy);
  const options = { now: NOW, activeCodes: [CODE], legacyNavMoves: { [CODE]: legacy } };
  const first = read(null, options).entries[`nav:${CODE}`];
  const later = read(null, { ...options, now: NOW + 5000 }).entries[`nav:${CODE}`];
  assert.ok(first);
  assert.equal(first.cacheState, 'stale');
  assert.equal(first.fetchedAt, legacy.fetchedAt);
  assert.equal(first.expiresAt, legacy.fetchedAt + TTL.OFFICIAL_NAV);
  assert.equal(later.expiresAt, first.expiresAt);
  assert.deepEqual(legacy, before);
});

test('estimate batch supports partial validated rows, source kinds and zero change without laundering', async () => {
  const { makeRefreshResourceEntry: make } = await module();
  const payload = estimates();
  payload.codes = ['000001', CODE];
  payload.rows[0].message = 'must not persist';
  payload.rows[0].diagnostics = { token: 'synthetic-secret' };
  const entry = make(`estimates:${payload.codes.join(',')}`, payload, makeOptions('2026-09-30'));
  assert.ok(entry);
  assert.equal(entry.ttlMs, TTL.INTRADAY);
  assert.equal(entry.payload.rows[0].source_quote.changePct, 0);
  assert.equal('diagnostics' in entry.payload.rows[0], false);
  assert.equal('message' in entry.payload.rows[0], false);
  const official = estimates([{ code: CODE, status: 'ok', source_quote: quote({ valueKind: 'official_nav',
    sourceId: 'eastmoney-official-nav', sourceTier: 'secondary', status: 'official', observedAt: '2026-09-29',
    officialNavDate: '2026-09-29', targetDate: '2026-09-29', baseNavDate: '2026-09-28' }) }]);
  assert.equal(make(`estimates:${CODE}`, official, makeOptions('2026-09-29')).payload.rows[0].source_quote.status, 'official');
  for (const extra of [{ status: 'invented' }, { status: 'unavailable' }, { status: 'stale' },
    { sourceId: 'invented' }, { sourceTier: 'cache' }, { value: 0 }, { value: false },
    { targetDate: null }, { baseNavDate: '2026-09-30' }, { observedAt: '2026-09-30T06:00:01Z' }]) {
    assert.equal(make(`estimates:${CODE}`, estimates([{ code: CODE, status: 'ok', source_quote: quote(extra) }]), makeOptions('2026-09-30')), null);
  }
});

test('estimate request set, row identities and canonical dates must agree', async () => {
  const { makeRefreshResourceEntry: make } = await module();
  for (const payload of [{ ...estimates(), codes: [CODE, CODE] }, estimates([{ code: '000001', status: 'ok', source_quote: quote() }]),
    estimates([estimates().rows[0], estimates().rows[0]]), estimates([]), { ...estimates(), source: 'eastmoney-official-nav' }]) {
    assert.equal(make(`estimates:${CODE}`, payload, makeOptions('2026-09-30')), null);
  }
  assert.equal(make(`estimates:${CODE}`, estimates(), makeOptions('2026-09-29')), null);
});

test('canonical quotes cannot mask conflicting legacy aliases or invalid quality metadata', async () => {
  const { makeRefreshResourceEntry: make } = await module();
  for (const extra of [{ est_nav: 99 }, { est_change: 99 }, { last_nav: 99 },
    { value_date: '2026-09-29' }, { kind: 'unavailable' }, { source: 'tencent-market-quote' }]) {
    assert.equal(make(`estimates:${CODE}`, estimates([{ ...estimates().rows[0], ...extra }]), makeOptions('2026-09-30')), null);
  }
  for (const extra of [{ market: 'invented' }, { assetKind: 'invented' }, { coverage: false }, { confidence: false }]) {
    assert.equal(make(`estimates:${CODE}`, estimates([{ code: CODE, status: 'ok', source_quote: quote(extra) }]), makeOptions('2026-09-30')), null);
  }
  const official = quote({ valueKind: 'official_nav', sourceId: 'eastmoney-official-nav', sourceTier: 'secondary',
    status: 'official', officialNavDate: '2026-09-29', targetDate: '2026-09-29', baseNavDate: '2026-09-28', observedAt: '2027-01-01' });
  assert.equal(make(`estimates:${CODE}`, estimates([{ code: CODE, status: 'ok', source_quote: official }]), makeOptions('2026-09-29')), null);
  assert.equal(make(INDEX_KEY, { ...indices(), status: 'failed' }, makeOptions('2026-09-30')), null);
  assert.equal(make(`meta:${CODE}`, { code: CODE, source: 'eastmoney-official-nav', meta: META, status: 'invented' }, makeOptions('2026-09-29')), null);
});

test('JSON placeholder aliases are allowed but finite aliases must agree with the financial quote', async () => {
  const { makeRefreshResourceEntry: make, validateRefreshResourceEntry: validate } = await module();
  const payload = estimates([{ ...estimates().rows[0], last_nav: NaN, coverage: NaN, est_nav: null }]);
  const entry = make(`estimates:${CODE}`, payload, makeOptions('2026-09-30'));
  assert.ok(entry);
  assert.equal(entry.payload.rows[0].last_nav, null);
  const restored = validate(`estimates:${CODE}`, JSON.parse(JSON.stringify(entry)), { now: NOW });
  assert.equal(restored.payload.rows[0].source_quote.changePct, 0);
  assert.equal(restored.payload.rows[0].source_quote.value, 1.1);
});

test('aggregate preserves old envelopes and each fund quote provenance without a valid staged acquisition', async () => {
  const { makeRefreshResourceEntry: make, serializeRefreshAggregate: serialize } = await module();
  const entry = make(`nav:${CODE}`, nav(), makeOptions('2026-09-29'));
  const previous = { data: [{ code: CODE }], fetchedAt: NOW, expiresAt: NOW + TTL.INTRADAY, source: 'fund-estimate', holdingsHash: 'old',
    refreshResources: { [`nav:${CODE}`]: entry } };
  const data = [{ code: CODE, quote: { ...quote(), sourceTier: 'cache', cacheState: 'stale', cachedAt: NOW - 10000, expiresAt: NOW - 1 } }];
  const before = structuredClone(previous);
  for (const staged of [{}, { [`nav:${CODE}`]: entry }, { 'nav:000001': entry }, { [`nav:${CODE}`]: { ...entry, originalSource: 'invented' } }]) {
    const result = JSON.parse(serialize({ previous, staged, data, holdingsHash: 'new', now: NOW + 1000, activeCodes: [CODE] }));
    assert.equal(result.fetchedAt, previous.fetchedAt);
    assert.equal(result.expiresAt, previous.expiresAt);
    assert.deepEqual(result.refreshResources[`nav:${CODE}`], entry);
    assert.deepEqual(result.data[0].quote, data[0].quote);
  }
  assert.deepEqual(previous, before);
});

test('only valid new staging advances top-level time and prunes inactive funds/resources', async () => {
  const { makeRefreshResourceEntry: make, serializeRefreshAggregate: serialize } = await module();
  const entry = make(`nav:${CODE}`, nav(), makeOptions('2026-09-29'));
  const later = NOW + 2000;
  const staged = make(`estimates:${CODE}`, estimates(), makeOptions('2026-09-30', { now: later, fetchedAt: later }));
  const result = JSON.parse(serialize({ previous: { fetchedAt: NOW, expiresAt: NOW + TTL.INTRADAY, source: 'fund-estimate',
    refreshResources: { [`nav:${CODE}`]: entry, 'meta:000001': null } }, staged: { [`estimates:${CODE}`]: staged },
    data: [{ code: CODE, source_quote: quote(), message: 'drop' }, { code: '000001' }], holdingsHash: 'new', now: later, activeCodes: [CODE] }));
  assert.equal(result.fetchedAt, later);
  assert.equal(result.expiresAt, later + TTL.INTRADAY);
  assert.equal(result.source, 'fund-estimate');
  assert.equal(result.holdingsHash, 'new');
  assert.deepEqual(result.data.map(row => row.code), [CODE]);
  assert.equal('message' in result.data[0], false);
  assert.deepEqual(result.refreshResources[`nav:${CODE}`], entry);
  assert.ok(result.refreshResources[`estimates:${CODE}`]);
});

test('old acquisition cannot be restaged by changing its cache write time', async () => {
  const { makeRefreshResourceEntry: make, serializeRefreshAggregate: serialize } = await module();
  const entry = make(`nav:${CODE}`, nav(), makeOptions('2026-09-29'));
  const later = NOW + 5000;
  const renewed = { ...entry, cachedAt: later, expiresAt: later + entry.ttlMs };
  const result = JSON.parse(serialize({ previous: { data: [], fetchedAt: NOW, expiresAt: NOW + TTL.INTRADAY,
    refreshResources: { [`nav:${CODE}`]: entry } }, staged: { [`nav:${CODE}`]: renewed }, data: [], now: later, activeCodes: [CODE] }));
  assert.equal(result.fetchedAt, NOW);
  assert.deepEqual(result.refreshResources[`nav:${CODE}`], entry);
});

test('market-only acquisitions persist resources without inventing an empty fund cache timestamp', async () => {
  const { makeRefreshResourceEntry: make, serializeRefreshAggregate: serialize } = await module();
  const staged = make(INDEX_KEY, indices(), makeOptions('2026-09-30'));
  const valid = JSON.parse(serialize({ staged: { [INDEX_KEY]: staged }, data: [], now: NOW, activeCodes: [] }));
  assert.deepEqual(valid.data, []);
  assert.ok(valid.refreshResources[INDEX_KEY]);
  assert.equal('fetchedAt' in valid, false);
  assert.equal('expiresAt' in valid, false);
  assert.equal('source' in valid, false);
  const invalid = JSON.parse(serialize({ staged: { 'estimates:': null }, data: [], now: NOW, activeCodes: [] }));
  assert.equal('fetchedAt' in invalid, false);
  assert.deepEqual(invalid.refreshResources, {});
});

test('new indices, gold and metadata cannot renew a previous fund projection acquisition', async () => {
  const { makeRefreshResourceEntry: make, serializeRefreshAggregate: serialize } = await module();
  const previousNav = make(`nav:${CODE}`, nav(), makeOptions('2026-09-29'));
  const data = [{ code: CODE, source_quote: quote({ sourceTier: 'cache', cacheState: 'stale', cachedAt: NOW - 2000, expiresAt: NOW - 1 }) }];
  const previous = { data, fetchedAt: NOW, expiresAt: NOW + TTL.INTRADAY, source: 'fund-estimate', time: NOW,
    refreshResources: { [`nav:${CODE}`]: previousNav } };
  const later = NOW + 5000;
  const market = make(INDEX_KEY, indices(), makeOptions('2026-09-30', { now: later, fetchedAt: later }));
  const precious = make('gold:AU9999', gold(), makeOptions('2026-09-30', { now: later, fetchedAt: later }));
  const meta = make(`meta:${CODE}`, { code: CODE, source: 'eastmoney-official-nav', meta: META },
    makeOptions('2026-09-29', { now: later, fetchedAt: later }));
  for (const staged of [{ [INDEX_KEY]: market }, { 'gold:AU9999': precious }, { [`meta:${CODE}`]: meta },
    { [INDEX_KEY]: market, 'gold:AU9999': precious, [`meta:${CODE}`]: meta }]) {
    const result = JSON.parse(serialize({ previous, staged, data, now: later, activeCodes: [CODE] }));
    for (const field of ['fetchedAt', 'expiresAt', 'source', 'time']) assert.equal(result[field], previous[field]);
    assert.deepEqual(result.data, data);
    assert.deepEqual(result.refreshResources[`nav:${CODE}`], previousNav);
    for (const key of Object.keys(staged)) assert.ok(result.refreshResources[key]);
  }
});

test('new NAV and holdings acquisitions still advance fund projection time', async () => {
  const { makeRefreshResourceEntry: make, serializeRefreshAggregate: serialize } = await module();
  const previous = { data: [{ code: CODE }], fetchedAt: NOW, expiresAt: NOW + TTL.INTRADAY, source: 'fund-estimate' };
  const later = NOW + 5000;
  for (const [key, payload, sourceDate] of [[`nav:${CODE}`, nav(), '2026-09-29'], [`holdings:${CODE}`, holdings(), '2026-06-30']]) {
    const entry = make(key, payload, makeOptions(sourceDate, { now: later, fetchedAt: later }));
    const result = JSON.parse(serialize({ previous, staged: { [key]: entry }, data: previous.data, now: later, activeCodes: [CODE] }));
    assert.equal(result.fetchedAt, later);
    assert.equal(result.expiresAt, later + TTL.INTRADAY);
    assert.equal(result.source, 'fund-estimate');
  }
});
