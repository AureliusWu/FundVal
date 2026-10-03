import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCacheEnvelope, readCacheEnvelope, adaptLegacyNavMoveCache,
} from '../js/runtime/cache-envelope.js';

const FETCHED = Date.parse('2026-09-29T12:00:00Z');
const CACHED = FETCHED + 10;
const TTL = 60_000;
const MOVE = Object.freeze({
  date: '2026-09-29', prevDate: '2026-09-28', nav: 3.2259, prevNav: 3.2037,
  change: 0.692948777351182, changeAmt: 0.0222, fundName: '合成基金A', meta: {},
});

function create(overrides = {}, payload = MOVE) {
  return createCacheEnvelope(payload, {
    originalSource: 'eastmoney-official-nav', originalSourceTier: 'secondary',
    sourceDate: MOVE.date, fetchedAt: FETCHED, cachedAt: CACHED, ttlMs: TTL, ...overrides,
  });
}

test('v16 cache envelope records original source and immutable acquisition times', () => {
  const entry = create();
  assert.deepEqual(Object.keys(entry).sort(), [
    'schemaVersion', 'payload', 'originalSource', 'originalSourceTier', 'sourceTier',
    'sourceDate', 'fetchedAt', 'cachedAt', 'ttlMs', 'expiresAt', 'cacheState',
  ].sort());
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.originalSource, 'eastmoney-official-nav');
  assert.equal(entry.originalSourceTier, 'secondary');
  assert.equal(entry.sourceTier, 'cache');
  assert.equal(entry.sourceDate, '2026-09-29');
  assert.equal(entry.fetchedAt, FETCHED);
  assert.equal(entry.cachedAt, CACHED);
  assert.equal(entry.expiresAt, CACHED + TTL);
  assert.equal(entry.cacheState, 'fresh');
  assert.deepEqual(entry.payload, MOVE);
  assert.ok(Object.isFrozen(entry));
});

test('v16 TTL boundary is stale; optional maximum stale age produces expired', () => {
  const entry = create();
  assert.equal(readCacheEnvelope(entry, { now: CACHED + TTL - 1 }).cacheState, 'fresh');
  assert.equal(readCacheEnvelope(entry, { now: CACHED + TTL }).cacheState, 'stale');
  assert.equal(readCacheEnvelope(entry, { now: CACHED + TTL + 1 }).cacheState, 'stale');
  assert.equal(readCacheEnvelope(entry, { now: CACHED + TTL + 1000, maxStaleMs: 1000 }).cacheState, 'expired');
  assert.equal(readCacheEnvelope(entry, { now: CACHED + TTL + 999, maxStaleMs: 1000 }).cacheState, 'stale');
});

test('v16 repeated failed refresh reads cannot renew timestamps, source dates or payload', () => {
  const entry = create();
  const originalJSON = JSON.stringify(entry);
  let fallback = readCacheEnvelope(originalJSON, { now: CACHED + TTL });
  for (let index = 1; index <= 10; index += 1) {
    fallback = readCacheEnvelope(JSON.stringify(fallback), { now: CACHED + TTL + index * 5000 });
    assert.equal(fallback.cacheState, 'stale');
    assert.equal(fallback.sourceTier, 'cache');
    assert.equal(fallback.originalSource, 'eastmoney-official-nav');
    assert.equal(fallback.originalSourceTier, 'secondary');
    assert.equal(fallback.sourceDate, MOVE.date);
    assert.equal(fallback.fetchedAt, FETCHED);
    assert.equal(fallback.cachedAt, CACHED);
    assert.equal(fallback.expiresAt, CACHED + TTL);
    assert.deepEqual(fallback.payload, MOVE);
  }
  assert.equal(JSON.stringify(entry), originalJSON);
});

test('v16 original source aliases normalize but unknown sources and nested cache originals fail closed', () => {
  assert.equal(create({ originalSource: 'official-nav' }).originalSource, 'eastmoney-official-nav');
  for (const originalSource of ['', null, 'unknown', 'new-invented-source', 'local-cache']) {
    assert.equal(create({ originalSource }), null);
  }
  for (const originalSourceTier of ['', null, 'cache', 'official', 'invented']) {
    assert.equal(create({ originalSourceTier }), null);
  }
  assert.equal(createCacheEnvelope(MOVE, null), null);
  assert.equal(createCacheEnvelope(null), null);
});

test('v16 malformed cache schema, dates, enum, time order and future writes are rejected', () => {
  const entry = create();
  for (const overrides of [
    { schemaVersion: 2 }, { schemaVersion: '1' },
    { originalSource: 'unknown' }, { originalSourceTier: 'cache' }, { sourceTier: 'secondary' },
    { sourceDate: null }, { sourceDate: '2026-02-30' }, { sourceDate: '2026-09-30' },
    { fetchedAt: '2026-09-29T12:00:00Z' }, { fetchedAt: NaN }, { fetchedAt: -1 },
    { fetchedAt: CACHED + 1 }, { cachedAt: FETCHED - 1 },
    { ttlMs: 0 }, { ttlMs: Infinity }, { ttlMs: '60000' },
    { expiresAt: CACHED + TTL + 1 }, { expiresAt: FETCHED - 1 },
    { cacheState: 'newest' }, { payload: null },
  ]) {
    assert.equal(readCacheEnvelope({ ...entry, ...overrides }, { now: CACHED + 1 }), null);
  }
  assert.equal(readCacheEnvelope(entry, { now: CACHED - 1 }), null);
  assert.equal(readCacheEnvelope(entry, { now: NaN }), null);
  assert.equal(readCacheEnvelope(entry, { now: CACHED + 1, maxStaleMs: -1 }), null);
  for (const raw of [null, 'null', '{', '{}', '[]', [], 0, false]) {
    assert.equal(readCacheEnvelope(raw, { now: CACHED + 1 }), null);
  }
});

test('v16 optional payload validation cannot be bypassed and validator exceptions are contained', () => {
  const entry = create();
  assert.ok(readCacheEnvelope(entry, { now: CACHED, validatePayload: payload => payload.nav > 0 }));
  assert.equal(readCacheEnvelope(entry, { now: CACHED, validatePayload: () => false }), null);
  assert.equal(readCacheEnvelope(entry, { now: CACHED, validatePayload: () => { throw new Error('invalid'); } }), null);
  assert.equal(readCacheEnvelope(entry, { now: CACHED, validatePayload: () => 'truthy' }), null);
});

test('v16 cache acquisition date is not assumed to be the market source date', () => {
  const entry = create({ sourceDate: '2026-09-24' }, { ...MOVE, date: '2026-09-24', prevDate: '2026-09-23' });
  const fresh = readCacheEnvelope(entry, { now: CACHED + 1 });
  assert.equal(fresh.cacheState, 'fresh');
  assert.equal(fresh.sourceDate, '2026-09-24');
  assert.notEqual(fresh.sourceDate, new Date(fresh.cachedAt).toISOString().slice(0, 10));
});

test('v16 legacy official NAV cache adapter retains old fetched time and expiry without rewriting the entry', () => {
  const legacy = { data: { ...MOVE }, fetchedAt: FETCHED, expiresAt: FETCHED + TTL, source: 'official-nav' };
  const original = structuredClone(legacy);
  const adapted = adaptLegacyNavMoveCache(legacy, { now: FETCHED + TTL + 1, ttlMs: TTL });
  assert.equal(adapted.cacheState, 'stale');
  assert.equal(adapted.originalSource, 'eastmoney-official-nav');
  assert.equal(adapted.sourceTier, 'cache');
  assert.equal(adapted.sourceDate, MOVE.date);
  assert.equal(adapted.fetchedAt, FETCHED);
  assert.equal(adapted.cachedAt, FETCHED);
  assert.equal(adapted.expiresAt, FETCHED + TTL);
  assert.deepEqual(adapted.payload, MOVE);
  assert.deepEqual(legacy, original);
  const later = readCacheEnvelope(adapted, { now: FETCHED + TTL + 2000 });
  assert.equal(later.expiresAt, FETCHED + TTL);
  assert.equal(later.fetchedAt, FETCHED);
});

test('v16 legacy cache missing expiry derives it only from original fetched time plus TTL', () => {
  const legacy = { data: { ...MOVE }, fetchedAt: FETCHED, source: 'eastmoney-official-nav' };
  const adapted = adaptLegacyNavMoveCache(legacy, { now: FETCHED + 2 * TTL, ttlMs: TTL });
  assert.equal(adapted.cacheState, 'stale');
  assert.equal(adapted.expiresAt, FETCHED + TTL);
  assert.equal(adapted.cachedAt, FETCHED);
  assert.equal(adaptLegacyNavMoveCache(legacy, { now: FETCHED - 1, ttlMs: TTL }), null);
});

test('v16 legacy malformed source, NAV/date pairs or contradictory expiry never become official cache', () => {
  const legacy = { data: { ...MOVE }, fetchedAt: FETCHED, expiresAt: FETCHED + TTL, source: 'official-nav' };
  for (const overrides of [
    { source: 'local-cache' }, { source: 'unknown' }, { fetchedAt: null },
    { fetchedAt: '2026-09-29T12:00:00Z' }, { expiresAt: FETCHED - 1 },
    { expiresAt: FETCHED + TTL + 1 },
  ]) {
    assert.equal(adaptLegacyNavMoveCache({ ...legacy, ...overrides }, { now: FETCHED + TTL, ttlMs: TTL }), null);
  }
  for (const overrides of [
    { nav: null }, { nav: 0 }, { nav: Infinity }, { nav: false },
    { prevNav: null }, { prevNav: -1 }, { prevDate: null },
    { date: '2026-02-30' }, { prevDate: '2026-02-30' },
    { date: '2026-09-30' }, { prevDate: MOVE.date }, { prevDate: '2026-09-30' },
  ]) {
    assert.equal(adaptLegacyNavMoveCache({ ...legacy, data: { ...MOVE, ...overrides } }, {
      now: FETCHED + TTL, ttlMs: TTL,
    }), null);
  }
});

test('cache record guards reject primitive and array inputs without coercion', () => {
  const scalars = [undefined, null, false, true, 0, -0, NaN, Infinity, '', 'record', 1n, Symbol('record'), () => {}, []];
  for (const value of scalars) {
    assert.equal(createCacheEnvelope(MOVE, value), null);
    assert.equal(createCacheEnvelope(value, { originalSource: 'official-nav', originalSourceTier: 'secondary',
      sourceDate: MOVE.date, fetchedAt: FETCHED, cachedAt: CACHED, ttlMs: TTL }), null);
    assert.equal(readCacheEnvelope(value, { now: CACHED }), null);
    assert.equal(adaptLegacyNavMoveCache(value, { now: CACHED, ttlMs: TTL }), null);
  }
  const payload = Object.assign(Object.create(null), MOVE);
  const options = Object.create({ originalSource: 'official-nav', originalSourceTier: 'secondary',
    sourceDate: MOVE.date, fetchedAt: FETCHED, cachedAt: CACHED, ttlMs: TTL });
  const entry = createCacheEnvelope(payload, options);
  assert.ok(entry);
  assert.equal(entry.payload, payload);
  const inherited = Object.create(entry);
  assert.deepEqual(readCacheEnvelope(inherited, { now: CACHED }), entry);
  assert.equal(Object.getPrototypeOf(readCacheEnvelope(inherited, { now: CACHED })), Object.prototype);
});

test('cache epoch guards preserve zero, safe epoch bounds and Date-only read clocks', () => {
  const zero = createCacheEnvelope({}, { originalSource: 'official-nav', originalSourceTier: 'secondary',
    sourceDate: '1970-01-01', fetchedAt: -0, cachedAt: 0, ttlMs: 1 });
  assert.ok(zero);
  assert.ok(Object.is(zero.fetchedAt, -0));
  assert.equal(readCacheEnvelope(zero, { now: 0 }).cacheState, 'fresh');
  assert.equal(readCacheEnvelope(zero, { now: 1 }).cacheState, 'stale');
  assert.equal(readCacheEnvelope(zero, { now: 8.64e15 }).cacheState, 'stale');
  assert.equal(readCacheEnvelope(zero, { now: 8.64e15 + 1 }), null);
  assert.equal(readCacheEnvelope(create(), { now: new Date(CACHED) }).cacheState, 'fresh');
  const poison = { valueOf() { throw new Error('epoch coercion is forbidden'); },
    [Symbol.toPrimitive]() { throw new Error('epoch coercion is forbidden'); } };
  const invalid = [undefined, null, false, true, '', String(FETCHED), -1, 0.5, NaN,
    Infinity, 8.64e15 + 1, Number.MAX_SAFE_INTEGER, 1n, Symbol('epoch'), [], poison, new Number(FETCHED)];
  const entry = create();
  for (const value of invalid) {
    if (value !== undefined) assert.equal(readCacheEnvelope(entry, { now: value }), null);
    for (const field of ['fetchedAt', 'cachedAt', 'expiresAt']) {
      assert.equal(readCacheEnvelope({ ...entry, [field]: value }, { now: CACHED }), null);
    }
  }
  for (const field of ['fetchedAt', 'cachedAt', 'expiresAt']) {
    assert.equal(readCacheEnvelope({ ...entry, [field]: new Date(FETCHED) }, { now: CACHED }), null);
  }
});

test('cache creation preserves option getter order and propagates acquisition accessor errors', () => {
  const values = { originalSource: 'official-nav', originalSourceTier: 'secondary', sourceDate: MOVE.date,
    fetchedAt: FETCHED, cachedAt: CACHED, ttlMs: TTL };
  const reads = [];
  const options = new Proxy(values, { get(target, key) { reads.push(key); return target[key]; } });
  assert.ok(createCacheEnvelope(MOVE, options));
  assert.deepEqual(reads, ['originalSource', 'originalSourceTier', 'sourceDate', 'fetchedAt', 'cachedAt', 'ttlMs', 'cachedAt', 'ttlMs']);
  const sentinel = new Error('synthetic source date getter');
  reads.length = 0;
  const failed = new Proxy(values, { get(target, key) {
    reads.push(key);
    if (key === 'sourceDate') throw sentinel;
    return target[key];
  } });
  assert.throws(() => createCacheEnvelope(MOVE, failed), error => error === sentinel);
  assert.deepEqual(reads, ['originalSource', 'originalSourceTier', 'sourceDate']);
});

test('cache read preserves validation then projection getter order and contains read accessor errors', () => {
  const value = create(), reads = [];
  const raw = new Proxy(value, { get(target, key) { reads.push(key); return target[key]; } });
  assert.ok(readCacheEnvelope(raw, { now: CACHED, validatePayload(payload) {
    assert.equal(payload, MOVE); reads.push('validatePayload'); return true;
  } }));
  const expected = ['schemaVersion', 'payload', 'originalSource', 'originalSourceTier', 'sourceTier', 'cacheState',
    'sourceDate', 'fetchedAt', 'cachedAt', 'fetchedAt', 'cachedAt', 'ttlMs', 'ttlMs', 'expiresAt', 'expiresAt',
    'cachedAt', 'ttlMs', 'sourceDate', 'fetchedAt', 'cachedAt', 'payload', 'validatePayload', 'payload',
    'originalSource', 'originalSourceTier', 'sourceDate', 'fetchedAt', 'cachedAt', 'ttlMs', 'expiresAt', 'expiresAt'];
  assert.deepEqual(reads, expected);
  for (let failAt = 0; failAt < expected.length; failAt += 1) {
    if (expected[failAt] === 'validatePayload') continue;
    const trace = [];
    const failing = new Proxy(value, { get(target, key) {
      trace.push(key);
      if (trace.length - 1 === failAt) throw new Error('synthetic envelope getter');
      return target[key];
    } });
    assert.equal(readCacheEnvelope(failing, { now: CACHED, validatePayload() {
      trace.push('validatePayload'); return true;
    } }), null);
    assert.deepEqual(trace, expected.slice(0, failAt + 1));
  }
});
