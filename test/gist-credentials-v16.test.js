import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGistCredentialStore,
  getGistCredentialMetadata,
} from '../js/storage/gist-credentials.js';

const TOKEN_KEY = 'fuyu_gist_token';
const CONSENT_KEY = 'fuyu_gist_token_persist';
const SESSION_TOKEN = 'test-session-token';
const OLD_TOKEN = 'test-old-token';
const NEW_TOKEN = 'test-new-token';
const SENSITIVE_ERROR = 'synthetic-private-credential-must-not-escape';

function storage(entries = {}, hooks = {}) {
  const data = new Map(Object.entries(entries));
  const calls = [];
  const api = {
    get length() {
      calls.push('length');
      return hooks.length ? hooks.length(data) : data.size;
    },
    key(index) {
      calls.push('key');
      return hooks.key ? hooks.key(index, data) : [...data.keys()][index] ?? null;
    },
    getItem(key) {
      calls.push(`get:${key}`);
      return hooks.get ? hooks.get(key, data) : data.get(key) ?? null;
    },
    setItem(key, value) {
      calls.push(`set:${key}`);
      if (hooks.set) return hooks.set(key, value, data);
      data.set(key, value);
    },
    removeItem(key) {
      calls.push(`remove:${key}`);
      if (hooks.remove) return hooks.remove(key, data);
      data.delete(key);
    },
  };
  return { data, calls, api };
}

function setup({ session = storage(), local = storage(), ...options } = {}) {
  return { session, local, store: createGistCredentialStore({ sessionStorage: session?.api, localStorage: local?.api, ...options }) };
}

function expectSafeResult(result, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, key);
  assert.equal(Object.hasOwn(result, 'token'), false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SESSION_TOKEN}|${OLD_TOKEN}|${NEW_TOKEN}|${SENSITIVE_ERROR}`));
  assert.match(result.reason, /^credential_[a-z_]+$/);
}

test('construction performs no storage reads or writes and never uses global storage', () => {
  const session = storage(), local = storage();
  createGistCredentialStore({ sessionStorage: session.api, localStorage: local.api });
  assert.deepEqual(session.calls, []);
  assert.deepEqual(local.calls, []);
  assert.deepEqual(createGistCredentialStore().read(), { token: '', mode: 'none', legacyPending: false, storageAvailable: false });
});

test('unconsented legacy token is detected by key only, never read or enabled', () => {
  const local = storage({ [TOKEN_KEY]: OLD_TOKEN });
  const { store } = setup({ local });
  assert.deepEqual(store.read(), { token: '', mode: 'none', legacyPending: true, storageAvailable: true });
  assert.equal(local.calls.includes(`get:${TOKEN_KEY}`), false);
  assert.equal(local.calls.some(value => /set:|remove:/.test(value)), false);
});

test('only exact string true opts an existing persistent token in', () => {
  for (const consent of ['false', '1', 'TRUE', '', ' true ']) {
    const local = storage({ [TOKEN_KEY]: OLD_TOKEN, [CONSENT_KEY]: consent });
    assert.equal(setup({ local }).store.read().token, '');
    assert.equal(local.calls.includes(`get:${TOKEN_KEY}`), false);
  }
  assert.equal(setup({ local: storage({ [TOKEN_KEY]: OLD_TOKEN, [CONSENT_KEY]: 'true' }) }).store.read().mode, 'persistent');
});

test('session token survives a new store instance without persistent fallback', () => {
  const session = storage();
  const local = storage();
  const first = setup({ session, local }).store;
  expectSafeResult(first.save(SESSION_TOKEN), { ok: true, mode: 'session', reason: 'credential_saved_session' });
  const reloaded = setup({ session, local }).store;
  assert.equal(reloaded.read().token, SESSION_TOKEN);
  assert.equal(reloaded.read().mode, 'session');
  assert.equal(local.calls.some(value => value.startsWith('set:')), false);
});

test('session takes precedence over explicitly consented persistence', () => {
  const { store } = setup({ session: storage({ [TOKEN_KEY]: SESSION_TOKEN }), local: storage({ [TOKEN_KEY]: OLD_TOKEN, [CONSENT_KEY]: 'true' }) });
  assert.equal(store.read().token, SESSION_TOKEN);
  assert.equal(store.read().mode, 'session');
});

test('explicit persistence writes consent last, verifies both values and reloads', () => {
  const { session, local, store } = setup({ session: storage({ [TOKEN_KEY]: OLD_TOKEN }) });
  expectSafeResult(store.save(NEW_TOKEN, { persist: true }), { ok: true, mode: 'persistent', reason: 'credential_saved_persistent' });
  assert.equal(session.data.has(TOKEN_KEY), false);
  assert.equal(local.data.get(TOKEN_KEY), NEW_TOKEN);
  assert.equal(local.data.get(CONSENT_KEY), 'true');
  assert.ok(local.calls.indexOf(`set:${TOKEN_KEY}`) < local.calls.indexOf(`set:${CONSENT_KEY}`));
  assert.equal(setup({ session, local }).store.read().token, NEW_TOKEN);
});

test('default save revokes persistent token and consent before session storage', () => {
  const { local, store } = setup({ local: storage({ [TOKEN_KEY]: OLD_TOKEN, [CONSENT_KEY]: 'true' }) });
  expectSafeResult(store.save(SESSION_TOKEN), { ok: true, mode: 'session', legacyPending: false });
  assert.equal(local.data.has(TOKEN_KEY), false);
  assert.equal(local.data.has(CONSENT_KEY), false);
  assert.ok(local.calls.indexOf(`remove:${CONSENT_KEY}`) < local.calls.indexOf(`remove:${TOKEN_KEY}`));
  assert.equal(store.read().token, SESSION_TOKEN);
});

test('truthy nonboolean persistence options never opt into local storage', () => {
  for (const persist of ['true', 1, {}, null]) {
    const { local, store } = setup();
    expectSafeResult(store.save(SESSION_TOKEN, { persist }), { ok: true, mode: 'session' });
    assert.equal(local.calls.some(value => value.startsWith('set:')), false);
  }
});

test('lexical validation supports classic, fine-grained and reasonable synthetic values', () => {
  const tokens = ['a'.repeat(40), ['ghp', 'b'.repeat(36)].join('_'), ['github', 'pat', 'c'.repeat(82)].join('_'), 'test-token', 'token'];
  for (const token of tokens) {
    const { store } = setup();
    assert.equal(store.save(token).ok, true);
    assert.equal(store.read().token, token);
  }
});

test('invalid token shapes are rejected without writes or replacing an active token', () => {
  const { session, local, store } = setup({ session: storage({ [TOKEN_KEY]: SESSION_TOKEN }) });
  for (const token of ['', ' ', ' token', 'token ', 'token\n', 'token\r', 'token\u2028', 'token\u2029', 'a\nb', 'a\rb', 'a\tb', 'a/b', 'a:b', 'a.b', '-token', '_token', 'ghp_', 'github_pat_', '基金', 'a'.repeat(256), 123, null, {}]) {
    expectSafeResult(store.save(token), { ok: false, mode: 'session', reason: 'credential_token_invalid' });
    assert.equal(store.read().token, SESSION_TOKEN);
  }
  assert.equal([...session.calls, ...local.calls].some(value => /set:|remove:/.test(value)), false);
});

test('malformed persisted token is not activated even with consent', () => {
  const { store } = setup({ local: storage({ [TOKEN_KEY]: 'not a token', [CONSENT_KEY]: 'true' }) });
  const result = store.read();
  assert.equal(result.token, '');
  assert.equal(result.mode, 'none');
  assert.equal(result.legacyPending, true);
});

test('missing session storage degrades to memory without local token writes', () => {
  const { store, local } = setup({ session: null });
  expectSafeResult(store.save(SESSION_TOKEN), { ok: false, mode: 'memory', reason: 'credential_session_write_failed' });
  assert.equal(store.read().token, SESSION_TOKEN);
  assert.equal(local.calls.some(value => value.startsWith('set:')), false);
});

test('quota exception does not leak its message or write a persistent fallback', () => {
  const session = storage({}, { set() { throw new Error(SENSITIVE_ERROR); } });
  const { store, local } = setup({ session });
  expectSafeResult(store.save(SESSION_TOKEN), { ok: false, mode: 'memory', reason: 'credential_session_write_failed' });
  assert.equal(store.read().token, SESSION_TOKEN);
  assert.equal(local.calls.some(value => value.startsWith('set:')), false);
});

test('explicit storage write rejection is not reported as session success', () => {
  const { store } = setup({ session: storage({}, { set() { return false; } }) });
  expectSafeResult(store.save(SESSION_TOKEN), { ok: false, mode: 'memory', reason: 'credential_session_write_failed' });
});

test('silent session write drop and forged readback both fail closed', () => {
  for (const set of [() => {}, (key, value, data) => data.set(key, OLD_TOKEN)]) {
    const { store } = setup({ session: storage({}, { set }) });
    expectSafeResult(store.save(SESSION_TOKEN), { ok: false, mode: 'memory', reason: 'credential_session_write_failed' });
    assert.equal(store.read().token, SESSION_TOKEN);
  }
});

test('a getItem getter that throws cannot escape or leak an error message', () => {
  const failing = {};
  Object.defineProperty(failing, 'getItem', { get() { throw new Error(SENSITIVE_ERROR); } });
  const store = createGistCredentialStore({ sessionStorage: failing, localStorage: failing });
  assert.doesNotThrow(() => store.read());
  expectSafeResult(store.save(SESSION_TOKEN), { ok: false, mode: 'memory' });
  assert.equal(store.read().storageAvailable, false);
});

test('legacy enumeration failure is a pending choice, not permission to read token', () => {
  const local = storage({ [TOKEN_KEY]: OLD_TOKEN }, { key() { throw new Error(SENSITIVE_ERROR); } });
  const result = setup({ local }).store.read();
  assert.equal(result.token, '');
  assert.equal(result.legacyPending, true);
  assert.equal(local.calls.includes(`get:${TOKEN_KEY}`), false);
});

test('storage without enumeration cannot silently enable an unconsented token', () => {
  let tokenRead = false;
  const store = createGistCredentialStore({ localStorage: { getItem(key) { if (key === TOKEN_KEY) tokenRead = true; return key === TOKEN_KEY ? OLD_TOKEN : null; } } });
  assert.equal(store.read().legacyPending, true);
  assert.equal(store.read().mode, 'none');
  assert.equal(tokenRead, false);
});

test('persistent token write failure rolls back token and consent and uses memory', () => {
  const local = storage({}, { set(key, value, data) { if (key === TOKEN_KEY) throw new Error(SENSITIVE_ERROR); data.set(key, value); } });
  const { store } = setup({ local });
  expectSafeResult(store.save(NEW_TOKEN, { persist: true }), { ok: false, mode: 'memory', reason: 'credential_persistent_write_failed' });
  assert.equal(local.data.has(TOKEN_KEY), false);
  assert.equal(local.data.has(CONSENT_KEY), false);
});

test('consent write rejection removes a previously written persistent token', () => {
  const local = storage({}, { set(key, value, data) { if (key === CONSENT_KEY) return false; data.set(key, value); } });
  const { store } = setup({ local });
  expectSafeResult(store.save(NEW_TOKEN, { persist: true }), { ok: false, mode: 'memory', reason: 'credential_persistent_write_failed' });
  assert.equal(local.data.has(TOKEN_KEY), false);
  assert.equal(local.data.has(CONSENT_KEY), false);
});

test('persistent mismatch cannot claim persistence and rollback is verified', () => {
  const local = storage({}, { set(key, value, data) { data.set(key, key === TOKEN_KEY ? OLD_TOKEN : value); } });
  const { store } = setup({ local });
  expectSafeResult(store.save(NEW_TOKEN, { persist: true }), { ok: false, mode: 'memory', reason: 'credential_persistent_write_failed' });
  assert.equal(local.data.has(TOKEN_KEY), false);
  assert.equal(store.read().token, NEW_TOKEN);
});

test('missing local storage cannot be described as successful persistence', () => {
  const { store } = setup({ local: null });
  expectSafeResult(store.save(NEW_TOKEN, { persist: true }), { ok: false, mode: 'memory', reason: 'credential_persistent_write_failed' });
});

test('failed persistent deletion is reported even when new session storage succeeds', () => {
  const local = storage({ [TOKEN_KEY]: OLD_TOKEN, [CONSENT_KEY]: 'true' }, { remove() { throw new Error(SENSITIVE_ERROR); } });
  const { store } = setup({ local });
  expectSafeResult(store.save(SESSION_TOKEN), { ok: false, mode: 'session', reason: 'credential_persistence_clear_failed', legacyPending: true });
  assert.equal(store.read().token, SESSION_TOKEN);
  assert.equal(store.read().token === OLD_TOKEN, false);
});

test('persistent opt-in refuses stale session precedence if its deletion fails', () => {
  const session = storage({ [TOKEN_KEY]: OLD_TOKEN }, { remove() { return false; } });
  const { store, local } = setup({ session });
  expectSafeResult(store.save(NEW_TOKEN, { persist: true }), { ok: false, mode: 'memory', reason: 'credential_session_clear_failed' });
  assert.equal(local.calls.some(value => value.startsWith('set:')), false);
  assert.equal(store.read().token, NEW_TOKEN);
});

test('clear removes session, persistent token, consent and in-memory credentials', () => {
  const { store, local, session } = setup({ local: storage({ [TOKEN_KEY]: OLD_TOKEN, [CONSENT_KEY]: 'true' }) });
  store.save(SESSION_TOKEN);
  expectSafeResult(store.clear(), { ok: true, mode: 'none', reason: 'credential_cleared', hasToken: false });
  assert.equal(store.read().token, '');
  assert.equal(session.data.has(TOKEN_KEY), false);
  assert.equal(local.data.has(TOKEN_KEY), false);
  assert.equal(local.data.has(CONSENT_KEY), false);
});

test('clear attempts all removals despite exceptions and never reactivates old values', () => {
  const hooks = { remove() { throw new Error(SENSITIVE_ERROR); } };
  const session = storage({ [TOKEN_KEY]: SESSION_TOKEN }, hooks);
  const local = storage({ [TOKEN_KEY]: OLD_TOKEN, [CONSENT_KEY]: 'true' }, hooks);
  const { store } = setup({ session, local });
  expectSafeResult(store.clear(), { ok: false, mode: 'none', reason: 'credential_persistence_clear_failed', legacyPending: true });
  assert.equal(store.read().token, '');
  assert.equal(store.read().mode, 'none');
  assert.ok(session.calls.includes(`remove:${TOKEN_KEY}`));
  assert.ok(local.calls.includes(`remove:${TOKEN_KEY}`));
  assert.ok(local.calls.includes(`remove:${CONSENT_KEY}`));
});

test('clear rejects silent removal no-op and readback mismatch', () => {
  const local = storage({ [TOKEN_KEY]: OLD_TOKEN, [CONSENT_KEY]: 'true' }, { remove() {} });
  const { store } = setup({ local });
  expectSafeResult(store.clear(), { ok: false, mode: 'none', reason: 'credential_persistence_clear_failed' });
  assert.equal(store.read().token, '');
});

test('storage read exceptions produce fixed metadata without console output', () => {
  const local = storage({}, { get() { throw new Error(SENSITIVE_ERROR); } });
  const session = storage({}, { get() { throw new Error(SENSITIVE_ERROR); } });
  const original = { warn: console.warn, error: console.error, log: console.log };
  const logs = [];
  for (const key of Object.keys(original)) console[key] = () => logs.push(key);
  try {
    const { store } = setup({ session, local });
    assert.equal(store.read().storageAvailable, false);
    expectSafeResult(store.save(SESSION_TOKEN), { ok: false, mode: 'memory' });
    expectSafeResult(store.clear(), { ok: false, mode: 'none' });
    assert.deepEqual(logs, []);
  } finally {
    for (const [key, value] of Object.entries(original)) console[key] = value;
  }
});

test('owned session readback changes fall back to its own memory, never other credentials', () => {
  const { store, session, local } = setup();
  store.save(SESSION_TOKEN);
  session.data.set(TOKEN_KEY, OLD_TOKEN);
  local.data.set(TOKEN_KEY, NEW_TOKEN);
  local.data.set(CONSENT_KEY, 'true');
  assert.equal(store.read().token, SESSION_TOKEN);
  assert.equal(store.read().mode, 'memory');
});

test('owned persistent readback changes do not activate substituted credentials', () => {
  const { store, local } = setup();
  store.save(NEW_TOKEN, { persist: true });
  local.data.set(TOKEN_KEY, OLD_TOKEN);
  assert.equal(store.read().token, NEW_TOKEN);
  assert.equal(store.read().mode, 'memory');
});

test('custom storage keys work and colliding keys fail without IO', () => {
  const { store, local } = setup({ tokenKey: 'test_token', consentKey: 'test_consent' });
  assert.equal(store.save(NEW_TOKEN, { persist: true }).ok, true);
  assert.equal(local.data.get('test_token'), NEW_TOKEN);
  assert.equal(local.data.get('test_consent'), 'true');
  const session = storage(), other = storage();
  const invalid = createGistCredentialStore({ sessionStorage: session.api, localStorage: other.api, tokenKey: 'same', consentKey: 'same' });
  expectSafeResult(invalid.save(SESSION_TOKEN), { ok: false, mode: 'none', reason: 'credential_configuration_invalid' });
  assert.deepEqual([...session.calls, ...other.calls], []);
});

test('safe credential metadata is an allowlisted projection with no token or arbitrary reason', () => {
  const { store } = setup();
  store.save(SESSION_TOKEN);
  assert.deepEqual(getGistCredentialMetadata({ ...store.read(), reason: SENSITIVE_ERROR, authorization: NEW_TOKEN }), {
    mode: 'session', hasToken: true, legacyPending: false, storageAvailable: true,
  });
  assert.deepEqual(getGistCredentialMetadata({ token: SESSION_TOKEN, mode: SENSITIVE_ERROR, legacyPending: 'yes', storageAvailable: 1 }), {
    mode: 'none', hasToken: false, legacyPending: false, storageAvailable: false,
  });
});

test('safe metadata reads a stateful mode getter once and cannot echo a second untrusted value', () => {
  let reads = 0;
  const value = { get mode() { reads += 1; return reads === 1 ? 'session' : SENSITIVE_ERROR; }, token: SESSION_TOKEN };
  assert.deepEqual(getGistCredentialMetadata(value), { mode: 'session', hasToken: true, legacyPending: false, storageAvailable: false });
  assert.equal(reads, 1);
});

test('throwing option and metadata getters cannot leak or replace the active credential', () => {
  const { store, session, local } = setup({ session: storage({ [TOKEN_KEY]: SESSION_TOKEN }) });
  expectSafeResult(store.save(NEW_TOKEN, { get persist() { throw new Error(SENSITIVE_ERROR); } }), { ok: false, mode: 'session', reason: 'credential_options_invalid' });
  assert.equal([...session.calls, ...local.calls].some(value => /set:|remove:/.test(value)), false);
  assert.deepEqual(getGistCredentialMetadata({ get mode() { throw new Error(SENSITIVE_ERROR); } }), { mode: 'none', hasToken: false, legacyPending: false, storageAvailable: false });
});
