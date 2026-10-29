import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_CREATE_INTENT_KEY as KEY, createCloudCreateIntentStore } from '../js/storage/cloud-create-intent.js';

const NONCE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const intent = { version: 1, nonce: NONCE, createdAt: 123 };
const encoded = JSON.stringify(intent);
function fixture(options = {}) {
  let raw = options.raw ?? null, reads = 0;
  const trace = [];
  const storage = {
    getItem(key) { assert.equal(key, KEY); trace.push('read'); reads++;
      if (options.readThrows || (options.readbackThrows && reads > 1)) throw new Error('private-storage-details');
      return reads > 1 && options.wrongReadback ? '{}' : raw; },
    setItem(key, value) { assert.equal(key, KEY); trace.push(['write', value]);
      if (options.writeThrows) throw new Error('private-storage-details');
      if (!options.fakeWrite) raw = value; },
    removeItem(key) { assert.equal(key, KEY); trace.push('remove');
      if (options.removeThrows) throw new Error('private-storage-details');
      if (!options.fakeRemove) raw = null; },
  };
  const api = createCloudCreateIntentStore({ storage: () => { trace.push('storage'); return storage; },
    nonce: () => { trace.push('nonce'); return options.nonce ?? NONCE; },
    now: () => { trace.push('now'); return options.now ?? 123; } });
  return { api, trace, raw: () => raw };
}
test('intent store construction is lazy and never touches storage or credentials', () => {
  const h = fixture(); assert.deepEqual(h.trace, []);
  assert.equal(KEY, 'fuyu_cloud_create_intent_v1');
  assert.deepEqual(h.api.read(), { ok: true, intent: null });
  assert.deepEqual(h.trace, ['storage', 'read']);
});
test('prepare reads, writes unique intent and checks exact serialized readback', () => {
  const h = fixture(); assert.deepEqual(h.api.prepare(), { ok: true, intent });
  assert.deepEqual(h.trace, ['storage', 'read', 'nonce', 'now', ['write', encoded], 'read']);
  assert.equal(h.raw(), encoded);
  h.trace.length = 0;
  assert.deepEqual(h.api.prepare(), { ok: false, reason: 'cloud_create_intent_pending' });
  assert.deepEqual(h.trace, ['storage', 'read']);
});
for (const [name, options, reason] of [
  ['read denied', { readThrows: true }, 'cloud_create_intent_read_failed'],
  ['write denied', { writeThrows: true }, 'cloud_create_intent_write_failed'],
  ['fake successful write', { fakeWrite: true }, 'cloud_create_intent_write_failed'],
  ['write then unreadable', { readbackThrows: true }, 'cloud_create_intent_write_failed'],
  ['write then different readback', { wrongReadback: true }, 'cloud_create_intent_write_failed'],
  ['invalid nonce', { nonce: 'not-a-uuid' }, 'cloud_create_intent_write_failed'],
  ['negative clock', { now: -1 }, 'cloud_create_intent_write_failed'],
  ['noninteger clock', { now: 1.5 }, 'cloud_create_intent_write_failed'],
  ['unsafe clock', { now: Number.MAX_SAFE_INTEGER + 1 }, 'cloud_create_intent_write_failed'],
]) test('prepare fails closed: ' + name, () => {
  const h = fixture(options); assert.deepEqual(h.api.prepare(), { ok: false, reason });
  assert.equal(JSON.stringify(h.api.prepare()).includes('private-storage-details'), false);
});
for (const raw of ['{', 'null', '[]', '{}', JSON.stringify({ ...intent, version: 2 }),
  JSON.stringify({ ...intent, token: 'synthetic-must-not-be-accepted' }),
  JSON.stringify({ ...intent, nonce: 1 }), JSON.stringify({ ...intent, createdAt: '123' }),
  JSON.stringify({ ...intent, createdAt: -1 }), JSON.stringify({ ...intent, createdAt: 1.5 }),
  JSON.stringify({ ...intent, createdAt: Number.MAX_SAFE_INTEGER + 1 }), ' '.repeat(1025), 123,
]) test('strict bounded intent shape rejects untrusted value ' + String(raw).slice(0, 48), () => {
  const h = fixture({ raw }); assert.deepEqual(h.api.read(), { ok: false, reason: 'cloud_create_intent_invalid' });
  assert.deepEqual(h.api.prepare(), { ok: false, reason: 'cloud_create_intent_invalid' });
  assert.equal(h.trace.some(value => Array.isArray(value)), false);
});
test('untrusted object fields are never coerced into strings', () => {
  let coercions = 0;
  const h = fixture({ raw: { toString() { coercions++; throw new Error('private'); } } });
  assert.deepEqual(h.api.read(), { ok: false, reason: 'cloud_create_intent_invalid' }); assert.equal(coercions, 0);
});
test('storage supplier exceptions and missing storage stay fail-closed', () => {
  for (const storage of [() => { throw new Error('private'); }, () => null]) {
    const api = createCloudCreateIntentStore({ storage });
    assert.deepEqual(api.read(), { ok: false, reason: 'cloud_create_intent_read_failed' });
    assert.deepEqual(api.prepare(), { ok: false, reason: 'cloud_create_intent_read_failed' });
    assert.deepEqual(api.clear(NONCE), { ok: false, reason: 'cloud_create_intent_clear_failed' });
  }
});
test('no insecure nonce fallback and no secret-bearing fields are persisted', () => {
  const h = fixture({ nonce: { toString() { assert.fail('no object coercion'); } } });
  assert.deepEqual(h.api.prepare(), { ok: false, reason: 'cloud_create_intent_write_failed' });
  assert.equal(h.trace.some(value => Array.isArray(value)), false);
  const descriptors = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  try {
    const defaults = createCloudCreateIntentStore({ storage: () => ({ getItem: () => null,
      setItem: () => assert.fail('no Math.random fallback') }) });
    assert.deepEqual(defaults.prepare(), { ok: false, reason: 'cloud_create_intent_write_failed' });
  } finally { if (descriptors) Object.defineProperty(globalThis, 'crypto', descriptors); else delete globalThis.crypto; }
});
test('prepared intents never expire and future times never unlock creation', () => {
  for (const createdAt of [0, Number.MAX_SAFE_INTEGER]) {
    const h = fixture({ raw: JSON.stringify({ ...intent, createdAt }) });
    assert.equal(h.api.read().intent.createdAt, createdAt);
    assert.deepEqual(h.api.prepare(), { ok: false, reason: 'cloud_create_intent_pending' });
  }
});
test('default secure UUID changes between successfully cleared create intents', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const api = createCloudCreateIntentStore({ storage: () => storage });
  const first = api.prepare(); assert.equal(first.ok, true); assert.equal(api.clear(first.intent.nonce).ok, true);
  const second = api.prepare(); assert.equal(second.ok, true); assert.notEqual(second.intent.nonce, first.intent.nonce);
  assert.deepEqual(Object.keys(second.intent).sort(), ['createdAt', 'nonce', 'version']);
});
test('clear requires exact nonce then removes and reads back absence', () => {
  const h = fixture({ raw: encoded }); assert.deepEqual(h.api.clear(NONCE), { ok: true });
  assert.deepEqual(h.trace, ['storage', 'read', 'remove', 'read']); assert.equal(h.raw(), null);
});
for (const [name, options, nonce = NONCE] of [
  ['different nonce', { raw: encoded }, OTHER], ['absent', {}], ['malformed', { raw: '{}' }],
  ['read denied', { raw: encoded, readThrows: true }], ['remove denied', { raw: encoded, removeThrows: true }],
  ['fake successful removal', { raw: encoded, fakeRemove: true }],
  ['remove then unreadable', { raw: encoded, readbackThrows: true }],
]) test('clear remains blocked: ' + name, () => {
  const h = fixture(options); assert.deepEqual(h.api.clear(nonce), { ok: false, reason: 'cloud_create_intent_clear_failed' });
  if (name === 'different nonce') { assert.equal(h.trace.includes('remove'), false); assert.equal(h.raw(), encoded); }
});
