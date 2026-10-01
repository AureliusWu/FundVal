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
