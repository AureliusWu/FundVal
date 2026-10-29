// Origin-wide safety barrier, not an account identifier or holdings schema.
// Call prepare/clear only while holding the repository's origin-wide lock.
export const CLOUD_CREATE_INTENT_KEY = 'fuyu_cloud_create_intent_v1';
const validNonce = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const failed = reason => ({ ok: false, reason });

export function createCloudCreateIntentStore({ storage = () => globalThis.localStorage,
  nonce = () => globalThis.crypto.randomUUID(), now = () => Date.now() } = {}) {
  function readFrom(target) {
    let raw;
    try { raw = target.getItem(CLOUD_CREATE_INTENT_KEY); }
    catch (_) { return failed('cloud_create_intent_read_failed'); }
    if (raw === null) return { ok: true, intent: null };
    try {
      if (typeof raw !== 'string' || raw.length > 1024) throw new Error();
      const value = JSON.parse(raw);
      if (!value || Array.isArray(value) || Object.keys(value).length !== 3 || value.version !== 1
        || !validNonce(value.nonce) || !validTime(value.createdAt)) throw new Error();
      return { ok: true, intent: value };
    } catch (_) { return failed('cloud_create_intent_invalid'); }
  }
  function read() {
    try { return readFrom(storage()); }
    catch (_) { return failed('cloud_create_intent_read_failed'); }
  }
  function prepare() {
    let target;
    try { target = storage(); }
    catch (_) { return failed('cloud_create_intent_read_failed'); }
    const current = readFrom(target);
    if (!current.ok) return current;
    if (current.intent) return failed('cloud_create_intent_pending');
    try {
      const intent = { version: 1, nonce: nonce(), createdAt: now() };
      if (!validNonce(intent.nonce) || !validTime(intent.createdAt)) throw new Error();
      const raw = JSON.stringify(intent);
      target.setItem(CLOUD_CREATE_INTENT_KEY, raw);
      if (target.getItem(CLOUD_CREATE_INTENT_KEY) !== raw) throw new Error();
      return { ok: true, intent };
    } catch (_) { return failed('cloud_create_intent_write_failed'); }
  }
  function clear(expectedNonce) {
    try {
      const target = storage(), current = readFrom(target);
      if (!current.ok || !current.intent || current.intent.nonce !== expectedNonce) throw new Error();
      target.removeItem(CLOUD_CREATE_INTENT_KEY);
      if (target.getItem(CLOUD_CREATE_INTENT_KEY) !== null) throw new Error();
      return { ok: true };
    } catch (_) { return failed('cloud_create_intent_clear_failed'); }
  }
  return { read, prepare, clear };
}
