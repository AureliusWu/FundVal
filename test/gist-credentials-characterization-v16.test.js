import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGistCredentialStore, getGistCredentialMetadata } from '../js/storage/gist-credentials.js';

// Independent pre-convergence module literal, not an import of the candidate.
// Restore the two export keywords to verify its exact original source SHA.
const oldOracle = (() => {
// FROZEN_CREDENTIAL_ORACLE_BEGIN
const DEFAULT_TOKEN_KEY = 'fuyu_gist_token';
const DEFAULT_CONSENT_KEY = 'fuyu_gist_token_persist';
const MAX_TOKEN_LENGTH = 255;
const MAX_STORAGE_KEYS = 2048;
const MODES = new Set(['session', 'persistent', 'memory', 'none']);

function validToken(value) {
  // Lexical safety only, not proof that GitHub accepts a credential. Short
  // synthetic values remain usable by the existing isolated test adapters.
  return typeof value === 'string'
    && value.length > 0 && value.length <= MAX_TOKEN_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
    && !/^(?:gh[pousr]_|github_pat_)$/.test(value);
}

function readItem(storage, key) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return { ok: false, value: null };
    const value = storage.getItem(key);
    return value === null || typeof value === 'string'
      ? { ok: true, value } : { ok: false, value: null };
  } catch (_) { return { ok: false, value: null }; }
}

function hasStoredKey(storage, key) {
  if (!storage) return false;
  try {
    const length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STORAGE_KEYS || typeof storage.key !== 'function') return true;
    for (let index = 0; index < length; index += 1) {
      const candidate = storage.key(index);
      if (candidate === key) return true;
      if (candidate !== null && typeof candidate !== 'string') return true;
    }
    return false;
  } catch (_) { return true; }
}

function removeItem(storage, key) {
  if (!storage) return true;
  try {
    if (typeof storage.removeItem !== 'function') return false;
    const accepted = storage.removeItem(key) !== false;
    const result = readItem(storage, key);
    return accepted && result.ok && result.value === null;
  } catch (_) { return false; }
}

function writeItem(storage, key, value) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    const accepted = storage.setItem(key, value) !== false;
    const result = readItem(storage, key);
    return accepted && result.ok && result.value === value;
  } catch (_) { return false; }
}

function getGistCredentialMetadata(value) {
  try {
    const candidateMode = value?.mode;
    const mode = MODES.has(candidateMode) ? candidateMode : 'none';
    return Object.freeze({
      mode,
      hasToken: mode !== 'none' && validToken(value?.token),
      legacyPending: value?.legacyPending === true,
      storageAvailable: value?.storageAvailable === true,
    });
  } catch (_) {
    return Object.freeze({ mode: 'none', hasToken: false, legacyPending: false, storageAvailable: false });
  }
}

function createGistCredentialStore(options = {}) {
  let sessionStorage, localStorage, tokenKey, consentKey, configured = false;
  try {
    ({ sessionStorage, localStorage, tokenKey = DEFAULT_TOKEN_KEY, consentKey = DEFAULT_CONSENT_KEY } = options);
    configured = typeof tokenKey === 'string' && typeof consentKey === 'string'
      && /^[A-Za-z0-9_:-]{1,128}$/.test(tokenKey)
      && /^[A-Za-z0-9_:-]{1,128}$/.test(consentKey) && tokenKey !== consentKey;
  } catch (_) { /* No option getter message is allowed to escape. */ }

  // Construction is inert. No global storage, credentials, network or logs.
  let ownsChoice = false;
  let memoryToken = '';
  let intendedMode = 'none';

  function read() {
    if (!configured) return Object.freeze({ token: '', mode: 'none', legacyPending: false, storageAvailable: false });
    const session = readItem(sessionStorage, tokenKey);
    const consent = readItem(localStorage, consentKey);
    // Without explicit consent, do not even getItem the legacy token value.
    // Enumeration failure conservatively asks for a new user choice.
    const mayReadPersistent = consent.ok && consent.value === 'true'
      && (!ownsChoice || intendedMode === 'persistent');
    const persistent = mayReadPersistent ? readItem(localStorage, tokenKey) : { ok: false, value: null };
    const legacyPending = mayReadPersistent
      ? (!persistent.ok || (persistent.value !== null && !validToken(persistent.value)))
      : hasStoredKey(localStorage, tokenKey);
    let token = '', mode = 'none';
    if (ownsChoice) {
      // A failed deletion/write must never reactivate any old stored token in
      // this instance. Memory is also the safe fallback for changed readback.
      token = memoryToken;
      if (token) {
        mode = intendedMode === 'session' && session.ok && session.value === token ? 'session'
          : intendedMode === 'persistent' && persistent.ok && persistent.value === token ? 'persistent'
            : 'memory';
      }
    } else if (session.ok && validToken(session.value)) {
      token = session.value; mode = 'session';
    } else if (persistent.ok && validToken(persistent.value)) {
      token = persistent.value; mode = 'persistent';
    }
    return Object.freeze({ token, mode, legacyPending, storageAvailable: session.ok || consent.ok });
  }

  function result(ok, reason, state = read()) {
    return Object.freeze({ ok, reason, ...getGistCredentialMetadata(state) });
  }

  function clearPersistent() {
    // Consent is revoked first; attempt both removals even when one fails.
    const consentCleared = removeItem(localStorage, consentKey);
    const tokenCleared = removeItem(localStorage, tokenKey);
    return consentCleared && tokenCleared;
  }

  function save(token, saveOptions = {}) {
    if (!configured) return result(false, 'credential_configuration_invalid');
    if (!validToken(token)) return result(false, 'credential_token_invalid');
    let persist;
    try { persist = saveOptions?.persist === true; }
    catch (_) { return result(false, 'credential_options_invalid'); }
    ownsChoice = true; memoryToken = token; intendedMode = 'memory';
    const persistentCleared = clearPersistent();
    if (!persist) {
      const sessionWritten = writeItem(sessionStorage, tokenKey, token);
      if (sessionWritten) intendedMode = 'session';
      else removeItem(sessionStorage, tokenKey);
      if (!persistentCleared) return result(false, 'credential_persistence_clear_failed');
      const state = read();
      return sessionWritten && state.mode === 'session'
        ? result(true, 'credential_saved_session', state)
        : result(false, 'credential_session_write_failed', state);
    }

    const sessionCleared = removeItem(sessionStorage, tokenKey);
    if (!persistentCleared) return result(false, 'credential_persistence_clear_failed');
    if (!sessionCleared) return result(false, 'credential_session_clear_failed');
    // Never make the opt-in marker visible before a verified token exists.
    const tokenWritten = writeItem(localStorage, tokenKey, token);
    const consentWritten = tokenWritten && writeItem(localStorage, consentKey, 'true');
    if (tokenWritten && consentWritten) {
      intendedMode = 'persistent';
      const state = read();
      if (state.mode === 'persistent') return result(true, 'credential_saved_persistent', state);
      intendedMode = 'memory';
    }
    const rolledBack = clearPersistent();
    return result(false, rolledBack ? 'credential_persistent_write_failed' : 'credential_persistence_clear_failed');
  }

  function clear() {
    if (!configured) return result(false, 'credential_configuration_invalid');
    ownsChoice = true; memoryToken = ''; intendedMode = 'none';
    const sessionCleared = removeItem(sessionStorage, tokenKey);
    const persistentCleared = clearPersistent();
    return result(sessionCleared && persistentCleared, !persistentCleared ? 'credential_persistence_clear_failed'
      : !sessionCleared ? 'credential_session_clear_failed' : 'credential_cleared');
  }

  return Object.freeze({ read, save, clear });
}
// FROZEN_CREDENTIAL_ORACLE_END
  return { createGistCredentialStore, getGistCredentialMetadata };
})();

const OLD_SHA256 = 'add48bc1a7760dc73050d94aea4ab581868f7a62ea9172aa899e46e97e76f031';
const TOKENS = { old: 'synthetic-old-token', session: 'synthetic-session-token', next: 'synthetic-next-token' };
const DEFAULT_KEYS = { tokenKey: 'fuyu_gist_token', consentKey: 'fuyu_gist_token_persist' };

test('credential characterization oracle is byte-bound to the original module', () => {
  const self = readFileSync(new URL(import.meta.url), 'utf8');
  const begin = '\n// FROZEN_CREDENTIAL_ORACLE_BEGIN\n';
  const end = '\n// FROZEN_CREDENTIAL_ORACLE_END\n';
  const start = self.indexOf(begin) + begin.length;
  assert.ok(start >= begin.length);
  const finish = self.indexOf(end, start);
  assert.ok(finish > start);
  const original = self.slice(start, finish) + '\n';
  const restored = original.replace(/^function (getGistCredentialMetadata|createGistCredentialStore)\(/gm, 'export function $1(');
  assert.equal(createHash('sha256').update(restored).digest('hex'), OLD_SHA256);
});

function mockStorage(name, entries, mode, trace) {
  const data = new Map(Object.entries(entries));
  const getterCounts = new Map();
  let api;
  const methods = {
    getItem(...args) {
      trace.push({ name, operation: 'getItem', args, receiver: this === api });
      if (mode === 'get-throws') throw new Error('synthetic-private-error');
      if (mode === 'get-nonstring') return 42;
      return data.get(args[0]) ?? null;
    },
    setItem(...args) {
      trace.push({ name, operation: 'setItem', args, receiver: this === api });
      if (mode === 'set-throws') throw new Error('synthetic-private-error');
      if (mode === 'set-rejects') return false;
      if (mode === 'set-noop') return;
      data.set(args[0], mode === 'set-mismatch' ? TOKENS.old : args[1]);
    },
    removeItem(...args) {
      trace.push({ name, operation: 'removeItem', args, receiver: this === api });
      if (mode === 'remove-throws') throw new Error('synthetic-private-error');
      if (mode === 'remove-rejects') return false;
      if (mode === 'remove-noop') return;
      data.delete(args[0]);
    },
    key(index) {
      trace.push({ name, operation: 'key', args: [index], receiver: this === api });
      if (mode === 'key-throws') throw new Error('synthetic-private-error');
      return [...data.keys()][index] ?? null;
    },
  };
  api = { get length() {
    trace.push({ name, operation: 'length' });
    if (mode === 'length-throws') throw new Error('synthetic-private-error');
    return mode === 'length-oversized' ? 2049 : data.size;
  } };
  for (const [method, implementation] of Object.entries(methods)) {
    Object.defineProperty(api, method, { get() {
      trace.push({ name, operation: 'method-getter', method });
      const count = (getterCounts.get(method) || 0) + 1;
      getterCounts.set(method, count);
      if (mode === `${method}-getter-throws`) throw new Error('synthetic-private-error');
      if (mode === `${method}-getter-changes` && count % 2 === 0) return null;
      if (mode === `${method}-missing`) return undefined;
      return implementation;
    } });
  }
  return { api, data };
}

function transcript(factory, specification) {
  const trace = [], keys = { ...DEFAULT_KEYS, ...specification.keys };
  const localValues = specification.initial === 'legacy' ? { [keys.tokenKey]: TOKENS.old }
    : specification.initial === 'persistent' || specification.initial === 'both'
      ? { [keys.tokenKey]: TOKENS.old, [keys.consentKey]: 'true' } : {};
  const sessionValues = specification.initial === 'session' || specification.initial === 'both' ? { [keys.tokenKey]: TOKENS.session } : {};
  const local = mockStorage('local', localValues, specification.localMode, trace);
  const session = mockStorage('session', sessionValues, specification.sessionMode, trace);
  const configuration = { ...keys, sessionStorage: specification.missingSession ? null : session.api, localStorage: specification.missingLocal ? null : local.api };
  const store = factory(configuration);
  assert.deepEqual(trace, [], 'Construction must remain inert');
  const outputs = [];
  const observe = (operation, callback) => {
    const result = callback();
    outputs.push({ operation, result, frozen: Object.isFrozen(result), traceLength: trace.length });
  };
  observe('initial-read', () => store.read());
  observe('session-save', () => store.save(TOKENS.session));
  observe('session-read', () => store.read());
  observe('persistent-save', () => store.save(TOKENS.next, { persist: true }));
  observe('persistent-read', () => store.read());
  local.data.set(keys.tokenKey, TOKENS.old);
  local.data.set(keys.consentKey, 'true');
  session.data.set(keys.tokenKey, TOKENS.old);
  observe('substitution-read', () => store.read());
  observe('clear', () => store.clear());
  observe('cleared-read', () => store.read());
  observe('invalid-save', () => store.save('synthetic invalid token'));
  observe('invalid-options', () => store.save(TOKENS.session, { get persist() { throw new Error('synthetic-private-error'); } }));
  observe('final-clear', () => store.clear());
  return { outputs, trace, local: [...local.data], session: [...session.data], publicKeys: Object.keys(store), frozen: Object.isFrozen(store) };
}

const scenarios = [
  { name: 'empty stores' }, { name: 'legacy only', initial: 'legacy' },
  { name: 'consented persistence', initial: 'persistent' }, { name: 'session only', initial: 'session' },
  { name: 'session precedence', initial: 'both' }, { name: 'both storage absent', missingSession: true, missingLocal: true },
  { name: 'session absent', missingSession: true }, { name: 'local absent', missingLocal: true },
  { name: 'custom keys', initial: 'both', keys: { tokenKey: 'test_token', consentKey: 'test_consent' } },
  { name: 'invalid colliding keys', keys: { tokenKey: 'same', consentKey: 'same' } },
];
for (const storageName of ['local', 'session']) {
  for (const mode of ['get-throws', 'get-nonstring', 'set-throws', 'set-rejects', 'set-noop', 'set-mismatch', 'remove-throws', 'remove-rejects', 'remove-noop',
    'length-throws', 'length-oversized', 'key-throws', 'getItem-getter-throws', 'setItem-getter-throws', 'removeItem-getter-throws',
    'getItem-getter-changes', 'setItem-getter-changes', 'removeItem-getter-changes', 'getItem-missing', 'setItem-missing', 'removeItem-missing']) {
    scenarios.push({ name: `${storageName}: ${mode}`, initial: 'both', [`${storageName}Mode`]: mode });
  }
}
for (const scenario of scenarios) test(`old/candidate credentials full transcript: ${scenario.name}`, () => {
  assert.deepEqual(transcript(createGistCredentialStore, scenario), transcript(oldOracle.createGistCredentialStore, scenario));
});

test('old/candidate safe metadata projections match including stateful and throwing getters', () => {
  const values = [
    () => null, () => ({ mode: 'session', token: TOKENS.session, legacyPending: true, storageAvailable: true }),
    () => ({ mode: 'memory', token: TOKENS.next, legacyPending: false, storageAvailable: false }),
    () => ({ mode: 'untrusted', token: TOKENS.old, reason: 'synthetic-private-error' }),
    () => { let reads = 0; return { get mode() { return ++reads === 1 ? 'persistent' : 'untrusted'; }, token: TOKENS.old }; },
    () => ({ get mode() { throw new Error('synthetic-private-error'); } }),
  ];
  for (const value of values) assert.deepEqual(getGistCredentialMetadata(value()), oldOracle.getGistCredentialMetadata(value()));
});
