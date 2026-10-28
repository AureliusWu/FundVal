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
    if (storage && typeof storage.getItem === 'function') {
      const value = storage.getItem(key);
      if (value === null || typeof value === 'string') return { ok: true, value };
    }
  } catch (_) { /* Rejected reads have the same fixed result as invalid values. */ }
  return { ok: false, value: null };
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

function mutateItem(storage, key, value = null) {
  const removal = value === null;
  if (!storage) return removal;
  const method = removal ? 'removeItem' : 'setItem';
  try {
    if (typeof storage[method] !== 'function') return false;
    const accepted = (removal ? storage[method](key) : storage[method](key, value)) !== false;
    const result = readItem(storage, key);
    return accepted && result.ok && result.value === value;
  } catch (_) { return false; }
}

export function getGistCredentialMetadata(value) {
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

export function createGistCredentialStore(options = {}) {
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

  function choose(token, mode = 'memory') {
    ownsChoice = true; memoryToken = token; intendedMode = mode;
  }

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
    const consentCleared = mutateItem(localStorage, consentKey);
    const tokenCleared = mutateItem(localStorage, tokenKey);
    return consentCleared && tokenCleared;
  }

  function save(token, saveOptions = {}) {
    if (!configured) return result(false, 'credential_configuration_invalid');
    if (!validToken(token)) return result(false, 'credential_token_invalid');
    let persist;
    try { persist = saveOptions?.persist === true; }
    catch (_) { return result(false, 'credential_options_invalid'); }
    choose(token);
    const persistentCleared = clearPersistent();
    if (!persist) {
      const sessionWritten = mutateItem(sessionStorage, tokenKey, token);
      if (sessionWritten) intendedMode = 'session';
      else mutateItem(sessionStorage, tokenKey);
      if (!persistentCleared) return result(false, 'credential_persistence_clear_failed');
      const state = read();
      const verified = sessionWritten && state.mode === 'session';
      return result(verified, verified ? 'credential_saved_session' : 'credential_session_write_failed', state);
    }

    const sessionCleared = mutateItem(sessionStorage, tokenKey);
    if (!persistentCleared) return result(false, 'credential_persistence_clear_failed');
    if (!sessionCleared) return result(false, 'credential_session_clear_failed');
    // Never make the opt-in marker visible before a verified token exists.
    const tokenWritten = mutateItem(localStorage, tokenKey, token);
    const consentWritten = tokenWritten && mutateItem(localStorage, consentKey, 'true');
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
    choose('', 'none');
    const sessionCleared = mutateItem(sessionStorage, tokenKey);
    const persistentCleared = clearPersistent();
    return result(sessionCleared && persistentCleared, !persistentCleared ? 'credential_persistence_clear_failed'
      : !sessionCleared ? 'credential_session_clear_failed' : 'credential_cleared');
  }

  return Object.freeze({ read, save, clear });
}
