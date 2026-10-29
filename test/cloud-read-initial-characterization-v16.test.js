import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pullHoldingsCloud, synchronizeHoldingsCloud } from '../js/storage/cloud-sync.js';
import { parseAndMigrateHoldings } from '../js/storage/holdings-migration.js';

// Frozen pre-convergence prefix helpers and the two public initial-read paths.
// They do not call the new helper or read its implementation. The seam stops
// at first local.load, before untouched merge/write/readback paths. The normal
// cloud suite separately exercises those complete flows. No real remote IO.
const OLD = String.raw`
const HOLDINGS_SCHEMA_VERSION = 3;
function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
function cloneJsonValue(value) {
  if (typeof value === 'string') return value;
  return JSON.parse(JSON.stringify(value));
}
function cloudReadValue(result) {
  if (!isObject(result) || !Object.prototype.hasOwnProperty.call(result, 'ok')) {
    return { ok: true, value: result, version: null };
  }
  if (result.ok !== true) return { ok: false, reason: result.reason || 'remote_read_failed', ...remoteFailureDetails(result) };
  const hasRaw = Object.prototype.hasOwnProperty.call(result, 'raw');
  const hasPayload = Object.prototype.hasOwnProperty.call(result, 'payload');
  const hasContent = Object.prototype.hasOwnProperty.call(result, 'content');
  if (!hasRaw && !hasPayload && !hasContent) return { ok: false, reason: 'remote_payload_missing' };
  return {
    ok: true,
    value: hasRaw ? result.raw : (hasPayload ? result.payload : result.content),
    backupValue: Object.prototype.hasOwnProperty.call(result, 'backupRaw')
      ? cloneJsonValue(result.backupRaw)
      : cloneJsonValue(hasRaw ? result.raw : (hasPayload ? result.payload : result.content)),
    version: result.version ?? result.etag ?? null,
    requiresPatch: result.requiresPatch === true,
  };
}
function remoteFailureDetails(result) {
  const value = result?.failure;
  const codes = ['auth', 'permission', 'missing', 'conflict', 'rate_limit', 'unavailable', 'network', 'invalid_response', 'invalid_request'];
  const safe = value && codes.includes(value.code)
    && (value.status === null || (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599))
    && typeof value.retryable === 'boolean'
    && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0 && value.retryAfterMs <= 86400000;
  return {
    ...(safe ? { failure: Object.freeze({ code: value.code, status: value.status,
      retryable: value.retryable, retryAfterMs: value.retryAfterMs }) } : {}),
    ...(result?.writeUnknown === true ? { writeUnknown: true } : {}),
  };
}
function failure(reason, details = {}) {
  return Object.freeze({
    ok: false,
    reason,
    patched: false,
    patchAcknowledged: false,
    remoteVerified: false,
    pending: true,
    ...details,
  });
}
async function push(options = {}) {
  const remote = options.remote;
  const local = options.local;
  if (typeof remote?.get !== 'function' || typeof remote?.patch !== 'function'
    || typeof local?.load !== 'function' || typeof local?.backup !== 'function'
    || typeof local?.persist !== 'function') {
    return failure('invalid_adapter');
  }
  const mergeOptions = { deviceId: options.deviceId, now: options.now };
  const number = Number(options.maxStabilityAttempts);
  const maxAttempts = Number.isSafeInteger(number) && number >= 1 ? number : 3;
  void mergeOptions; void maxAttempts;
  let initialRemote;
  try {
    initialRemote = cloudReadValue(await remote.get({ phase: 'initial' }));
  } catch (error) {
    return failure(error?.code || 'remote_read_failed', { error });
  }
  if (!initialRemote.ok) return failure(initialRemote.reason, remoteFailureDetails(initialRemote));
  const remoteParsed = parseAndMigrateHoldings(initialRemote.value);
  if (!remoteParsed.ok) return failure('remote_payload_invalid', { error: remoteParsed.error });
  if (remoteParsed.readonly || remoteParsed.sourceSchema > HOLDINGS_SCHEMA_VERSION || !remoteParsed.document) {
    return failure('remote_schema_future', { remoteSchema: remoteParsed.sourceSchema });
  }
  // Independent first-local-IO sentinel; later algorithms are out of scope.
  try { await local.load({ phase: 'initial' }); }
  catch (error) { return failure(error?.code || 'local_read_failed', { error }); }
  throw new Error('Expected first-local-IO sentinel');
}
async function pull(options = {}) {
  const remote = options.remote;
  const local = options.local;
  if (typeof remote?.get !== 'function' || typeof local?.load !== 'function'
    || typeof local?.backup !== 'function' || typeof local?.persist !== 'function') {
    return failure('invalid_adapter');
  }
  let remoteRead;
  try {
    remoteRead = cloudReadValue(await remote.get({ phase: 'pull' }));
  } catch (error) {
    return failure(error?.code || 'remote_read_failed', { error });
  }
  if (!remoteRead.ok) return failure(remoteRead.reason, remoteFailureDetails(remoteRead));
  const remoteParsed = parseAndMigrateHoldings(remoteRead.value);
  if (!remoteParsed.ok) return failure('remote_payload_invalid', { error: remoteParsed.error });
  if (remoteParsed.readonly || !remoteParsed.document) {
    return failure('remote_schema_future', { remoteSchema: remoteParsed.sourceSchema });
  }
  try { await local.load({ phase: 'pull-initial' }); }
  catch (error) { return failure(error?.code || 'local_read_failed', { error }); }
  throw new Error('Expected first-local-IO sentinel');
}
return { push, pull };
`;
const old = new Function('parseAndMigrateHoldings', OLD)(parseAndMigrateHoldings);
const TIME = '2026-10-26T00:00:00.000Z';
const document = { schema: 3, updatedAt: TIME, deviceId: 'synthetic:read-prefix', holdings: [] };
const snapshot = () => structuredClone(document);
const limited = { code: 'rate_limit', status: 429, retryable: true, retryAfterMs: 65000 };
function normalize(value) {
  if (value instanceof Error) return { name: value.name, message: value.message,
    ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'stack').map(([key, item]) => [key, normalize(item)])) };
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  return value;
}
function scenario(makeRemote, configure = () => {}) {
  const calls = [];
  let scopeCurrent = true;
  const abort = new AbortController();
  const options = {
    deviceId: 'synthetic:read-prefix', now: TIME,
    remote: { get(input) { calls.push(['get', input]); return makeRemote({ calls, abort, scopeCurrent: () => scopeCurrent, invalidate: () => { scopeCurrent = false; } }); },
      patch() { calls.push('patch'); throw new Error('Unexpected PATCH'); } },
    local: { load(input) { calls.push(['load', input, scopeCurrent]);
      const error = new Error(scopeCurrent ? 'synthetic-prefix-stop' : 'synthetic-scope-changed');
      error.code = scopeCurrent ? 'synthetic_prefix_stop' : 'cloud_configuration_changed'; throw error; },
      backup() { calls.push('backup'); throw new Error('Unexpected backup'); },
      persist() { calls.push('persist'); throw new Error('Unexpected persist'); } },
  };
  configure(options, calls);
  return { options, calls };
}
async function observe(run, makeRemote, configure) {
  const h = scenario(makeRemote, configure);
  let result;
  try { const value = await run(h.options); result = { fulfilled: normalize(value), frozen: Object.isFrozen(value) }; }
  catch (error) { result = { rejected: normalize(error) }; }
  return { result, calls: h.calls };
}
const cases = [
  ['raw document', () => snapshot()],
  ['raw JSON document', () => JSON.stringify(snapshot())],
  ['raw wrapper', () => ({ ok: true, raw: snapshot(), version: 'synthetic-etag' })],
  ['payload wrapper', () => ({ ok: true, payload: snapshot(), etag: 'synthetic-etag' })],
  ['content wrapper', () => ({ ok: true, content: JSON.stringify(snapshot()), backupRaw: { files: {} } })],
  ['raw precedes payload/content', () => ({ ok: true, raw: snapshot(), payload: null, content: '{invalid' })],
  ['envelope getters retain access order', ({ calls }) => Object.defineProperties({}, Object.fromEntries(
    Object.entries({ ok: true, raw: snapshot(), payload: null, content: null, backupRaw: { files: {} }, version: null,
      etag: 'synthetic-etag', requiresPatch: false }).map(([key, value]) => [key, { enumerable: true, get() { calls.push(['property', key]); return value; } }])))],
  ['legacy array', () => ({ ok: true, raw: [] })],
  ['legacy schema2', () => ({ ok: true, raw: { schema: 2, updated_at: TIME, device_id: 'synthetic:legacy', holdings: [] } })],
  ['null', () => null], ['undefined', () => undefined], ['empty raw', () => ({ ok: true, raw: '' })],
  ['undefined backup payload', () => ({ ok: true, raw: snapshot(), backupRaw: undefined })],
  ['bad JSON', () => ({ ok: true, raw: '{invalid' })],
  ['missing payload', () => ({ ok: true })], ['false ack', () => ({ ok: false })],
  ['false with reason', () => ({ ok: false, reason: 'remote_http_503' })],
  ['rate policy allowlist', () => ({ ok: false, reason: 'remote_http_429', failure: { ...limited, token: 'synthetic-private' } })],
  ['invalid failure policy', () => ({ ok: false, failure: { ...limited, retryAfterMs: Infinity }, writeUnknown: true })],
  ['future schema', () => ({ ok: true, raw: { ...snapshot(), schema: 4 } })],
  ['invalid current document', () => ({ ok: true, raw: { ...snapshot(), holdings: 'invalid' } })],
  ['transport throw', () => { throw new Error('synthetic-transport'); }],
  ['transport rejects with code', () => Promise.reject(Object.assign(new Error('synthetic-code'), { code: 'synthetic_transport_code' }))],
  ['transport rejects null', () => Promise.reject(null)],
  ['throwing raw getter', () => ({ ok: true, get raw() { throw new Error('synthetic-raw-getter'); } })],
  ['circular backup', () => { const backup = {}; backup.self = backup; return { ok: true, raw: snapshot(), backupRaw: backup }; }],
  ['aborted transport', ({ abort }) => { abort.abort(); return Promise.reject(Object.assign(new Error('synthetic-abort'), { name: 'AbortError' })); }],
  ['transport scope changes before returning', ({ invalidate }) => { invalidate(); return { ok: false, reason: 'cloud_configuration_changed' }; }],
  ['scope cancellation preserves the original microtask boundary', ({ invalidate }) => {
    queueMicrotask(() => queueMicrotask(invalidate)); return { ok: true, raw: snapshot() };
  }],
  ['missing remote get', () => snapshot(), options => { delete options.remote.get; }],
  ['missing remote patch', () => snapshot(), options => { delete options.remote.patch; }],
  ['missing local backup', () => snapshot(), options => { delete options.local.backup; }],
  ['missing local load', () => snapshot(), options => { delete options.local.load; }],
  ['missing local persist', () => snapshot(), options => { delete options.local.persist; }],
  ['option getter ordering', () => snapshot(), (options, calls) => {
    for (const key of ['remote', 'local', 'deviceId', 'now', 'maxStabilityAttempts']) {
      const value = options[key]; Object.defineProperty(options, key, { get() { calls.push(['option', key]); return value; } });
    }
  }],
];

test('frozen old prefix oracle identity and a negative control are independent', async () => {
  // Filled once before production refactoring; not calculated from candidate.
  assert.equal(createHash('sha256').update(OLD).digest('hex'), 'a44ac855ca982f3aa0ae4b6f0d206c4a4656718857e7961540216049f9e682bc');
  const baseline = await observe(old.push, () => ({ ok: true, raw: snapshot() }));
  const broken = async options => ({ ok: true, document: await options.remote.get({ phase: 'wrong-phase' }) });
  assert.notDeepEqual(await observe(broken, () => ({ ok: true, raw: snapshot() })), baseline);
});
for (const [direction, candidate] of [['push', synchronizeHoldingsCloud], ['pull', pullHoldingsCloud]]) {
  for (const [name, remote, configure] of cases) test(`${direction} initial prefix preserves frozen IO and envelope: ${name}`, async () => {
    assert.deepEqual(await observe(candidate, remote, configure), await observe(old[direction], remote, configure));
  });
  test(`${direction} held remote performs no local IO before settlement`, async () => {
    const run = async implementation => {
      let settle;
      const held = new Promise(resolve => { settle = resolve; });
      const h = scenario(() => held), running = implementation(h.options);
      await Promise.resolve();
      const before = h.calls.slice();
      settle({ ok: true, raw: snapshot() });
      return { before, after: await running.then(normalize), calls: h.calls };
    };
    assert.deepEqual(await run(candidate), await run(old[direction]));
  });
}
