import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeHoldingsDocumentV3 } from '../../js/storage/holdings-schema.js';
import { makeLiveGistFixture, LIVE_GIST_API_ORIGIN, LIVE_GIST_LEGACY_FILE } from './live-gist-m4-scope.mjs';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const ID = /^[a-f0-9]{1,64}$/;
const HEADERS = new Set(['content-type', 'etag', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset']);
const REJECTIONS = new Set([400, 401, 403, 404, 409, 422, 429]);
const DOC_KEYS = ['schema', 'updatedAt', 'deviceId', 'holdings'];
const ROW_KEYS = ['id', 'fundCode', 'fundName', 'shares', 'costNav', 'createdAt', 'updatedAt', 'deletedAt', 'revision', 'deviceId', 'note'];
const sha = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length
  && Object.keys(value).every(key => expected.includes(key));
const fail = reason => ({ ok: false, reason });
const TYPED_ARRAY = Object.getPrototypeOf(Uint8Array.prototype);
const ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'buffer').get;
const ARRAY_OFFSET = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'byteOffset').get;
const ARRAY_BYTES = Object.getOwnPropertyDescriptor(TYPED_ARRAY, 'byteLength').get;
const copyBytes = (value, maximum) => {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maximum) throw new Error('live_bytes_invalid');
    return Buffer.from(value);
  }
  if (!(value instanceof Uint8Array)) throw new Error('live_bytes_invalid');
  // Caller-owned views may shadow length/byteLength/buffer/byteOffset and even
  // iterator methods. Obtain internal slots before allocation, then copy only a
  // fresh ordinary view. Never pass the original object to Buffer.from.
  const length = Reflect.apply(ARRAY_BYTES, value, []);
  if (length > maximum) throw new Error('live_bytes_invalid');
  const buffer = Reflect.apply(ARRAY_BUFFER, value, []), offset = Reflect.apply(ARRAY_OFFSET, value, []);
  return Buffer.from(new Uint8Array(buffer, offset, length));
};

// JSON.parse validates syntax; this bounded scan additionally rejects duplicate
// object keys that JSON.parse would otherwise silently collapse. No recursion.
function parseJson(bytes) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(source), stack = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index], top = stack.at(-1);
    if (char === '"') {
      const start = index;
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === '\\') index += 1;
        else if (source[index] === '"') break;
      }
      if (top?.type === 'object' && top.key) {
        const name = JSON.parse(source.slice(start, index + 1));
        if (top.names.has(name)) throw new Error('live_duplicate_json_key');
        top.names.add(name); top.key = false;
      }
    } else if (char === '{' || char === '[') {
      if (stack.length >= 24) throw new Error('live_json_depth');
      stack.push({ type: char === '{' ? 'object' : 'array', key: true, names: new Set() });
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && top?.type === 'object') top.key = true;
  }
  return value;
}

function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

// This is deliberately a controlled two-fund corpus, not a general holdings
// allowlist. In particular note=null/costNav=1 must not be called null/0 coverage.
function validDocument(content, fixture, index) {
  try {
    const value = parseJson(copyBytes(content, 131072));
    if (!keys(value, DOC_KEYS) || value.schema !== 3 || value.deviceId !== fixture.devices[index]
      || !Array.isArray(value.holdings) || value.holdings.length > 2 || !iso(value.updatedAt)) return false;
    if (!value.holdings.every(row => keys(row, ROW_KEYS) && ['000001', '000002'].includes(row.fundCode)
      && row.id === `fund:${row.fundCode}` && row.fundName === `Synthetic M4 ${Number(row.fundCode)}`
      && row.note === null && row.costNav === 1 && typeof row.shares === 'number' && Number.isFinite(row.shares)
      && row.shares >= 0 && row.shares <= 1000 && fixture.devices.includes(row.deviceId)
      && iso(row.createdAt) && iso(row.updatedAt) && (row.deletedAt === null || iso(row.deletedAt)))) return false;
    return isDeepStrictEqual(value, normalizeHoldingsDocumentV3(value));
  } catch (_) { return false; }
}

function description(value, fixture) {
  return value === fixture.marker || typeof value === 'string'
    && value.startsWith('FundVal 持仓数据 | ') && iso(value.slice('FundVal 持仓数据 | '.length));
}

function validOwned(value, fixture, binding) {
  try {
    if (!object(value) || value.id !== binding.ownedId || value.public !== false
      || value.owner?.login !== binding.approvedLogin || value.owner?.id !== binding.accountId
      || !description(value.description, fixture) || ![undefined, false].includes(value.truncated)
      || !object(value.files) || !Object.hasOwn(value.files, LIVE_GIST_LEGACY_FILE)
      || !Object.hasOwn(value.files, fixture.shards[0])) return false;
    return Object.entries(value.files).every(([name, file]) => {
      if (!object(file) || ![undefined, false].includes(file.truncated) || typeof file.content !== 'string'
        || 'filename' in file && file.filename !== name) return false;
      if (name === LIVE_GIST_LEGACY_FILE) return sha(copyBytes(file.content, 131072)) === binding.legacySha256;
      const index = fixture.shards.indexOf(name);
      return index >= 0 && validDocument(file.content, fixture, index);
    });
  } catch (_) { return false; }
}

function responseBytes(response) {
  if (!object(response) || Object.keys(response).length !== 3) throw new Error('live_response_invalid');
  response = Object.fromEntries(Object.entries(response));
  if (!keys(response, ['status', 'headers', 'bodyBytes']) || !Number.isInteger(response.status)
    || response.status < 200 || response.status > 599 || response.status >= 300 && response.status < 400
    || !object(response.headers)) throw new Error('live_response_invalid');
  const safeHeaders = {};
  for (const name of Object.keys(response.headers)) {
    const lower = name.toLowerCase();
    if (!HEADERS.has(lower)) continue;
    const value = response.headers[name];
    if (Object.hasOwn(safeHeaders, lower) || typeof value !== 'string' || value.length > 2048 || /[\r\n\u0000]/.test(value)) {
      throw new Error('live_response_invalid');
    }
    safeHeaders[lower] = value;
  }
  return { status: response.status, safeHeaders: Object.freeze(safeHeaders), bodyBytes: copyBytes(response.bodyBytes, 1048576) };
}

// Pure, injected IO only. A future driver MUST retire the creation scope before
// handing this relay its binding/journal and original monotonic POST dispatch
// time. Never run both queues, create another relay after an unknown write, or
// treat this in-memory phase as durable journal recovery/account authorization.
export function createLiveGistRelay({ fixture: inputFixture, binding: inputBinding, journal, transport,
  now = () => performance.now(), wallNow = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms)), timeoutMs = 15000 } = {}) {
  let fixture, binding, configured = false, journalAppend;
  const journalReceiver = journal;
  try {
    fixture = makeLiveGistFixture({ nonce: inputFixture.nonce, nowISO: inputFixture.documents[0].updatedAt });
    binding = Object.freeze({ ...inputBinding });
    configured = JSON.stringify(inputFixture) === JSON.stringify(fixture)
      && keys(binding, ['approvedLogin', 'accountId', 'ownedId', 'nonce', 'legacySha256', 'lastMutationAt'])
      && typeof binding.approvedLogin === 'string' && LOGIN.test(binding.approvedLogin)
      && typeof binding.accountId === 'number' && Number.isSafeInteger(binding.accountId) && binding.accountId > 0
      && typeof binding.ownedId === 'string' && ID.test(binding.ownedId)
      && typeof binding.nonce === 'string' && binding.nonce === fixture.nonce
      && typeof binding.legacySha256 === 'string' && binding.legacySha256 === fixture.legacySha256
      && typeof binding.lastMutationAt === 'number' && Number.isFinite(binding.lastMutationAt) && binding.lastMutationAt >= 0
      && typeof (journalAppend = Object.getOwnPropertyDescriptor(journalReceiver, 'append')?.value) === 'function'
      && typeof transport === 'function' && typeof now === 'function'
      && typeof wallNow === 'function' && typeof sleep === 'function' && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000;
  } catch (_) { configured = false; }
  const ownedPath = configured ? `/gists/${binding.ownedId}` : '';
  let phase = configured ? 'unverified' : 'blocked', ownershipVerified = false;
  let requests = 0, mutations = 0, lastMutation = binding?.lastMutationAt ?? 0, lastClock = lastMutation;
  let cooldownUntil = 0, queue = Promise.resolve(), activeWait = null, transportPending = false, journalBusy = false, unknownLogged = false;
  const actors = { A: { offline: false, epoch: 0 }, B: { offline: false, epoch: 0 } };
  const reasonFor = context => context?.signal?.aborted ? 'live_aborted'
    : context?.actor && (actors[context.actor].offline || actors[context.actor].epoch !== context.epoch) ? 'live_actor_context_changed' : '';
  function clock() {
    const value = now();
    if (!Number.isFinite(value) || value < lastClock) throw new Error('live_clock_invalid');
    lastClock = value; return value;
  }
  function serial(action) {
    if (journalBusy) {
      phase = 'blocked'; activeWait?.cancel('live_journal_reentry');
      return Promise.resolve(fail('live_journal_reentry'));
    }
    const result = queue.then(action, action).catch(() => { phase = 'blocked'; return fail('live_relay_failed'); });
    queue = result.then(() => {}, () => {}); return result;
  }
  function gate(context, method, verify = false) {
    if (!configured || phase === 'blocked') return 'live_configuration_blocked';
    if (reasonFor(context)) return reasonFor(context);
    if (transportPending) return 'live_transport_draining';
    if (verify ? phase !== 'unverified' : phase === 'unverified') return 'live_ownership_not_ready';
    if (method === 'PATCH' && phase !== 'owned') return 'live_write_review_required';
    return '';
  }
  async function waitStage(operation, context, cancelUnderlying = () => {}) {
    const early = reasonFor(context); if (early) return fail(early);
    let cancel, timer;
    const cancellation = new Promise(done => { cancel = reason => { cancelUnderlying(); done(fail(reason)); }; });
    const current = { actor: context?.actor, cancel }; activeWait = current;
    const aborted = () => cancel('live_aborted'); context?.signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => cancel('live_timeout'), timeoutMs);
    try {
      const value = operation();
      if (reasonFor(context)) cancel(reasonFor(context));
      const result = await Promise.race([Promise.resolve(value).then(value => ({ ok: true, value }), () => fail('live_callback_failed')), cancellation]);
      return reasonFor(context) ? fail(reasonFor(context)) : result;
    } catch (_) { return fail('live_callback_failed'); }
    finally {
      clearTimeout(timer); context?.signal?.removeEventListener('abort', aborted);
      if (activeWait === current) activeWait = null;
    }
  }
  async function append(event, details, context) {
    journalBusy = true;
    try {
      const stable = () => Object.getOwnPropertyDescriptor(journalReceiver, 'append')?.value === journalAppend;
      if (!stable() || reasonFor(context)) { phase = 'blocked'; return false; }
      const result = await waitStage(() => {
        if (!stable() || reasonFor(context)) throw new Error('live_journal_changed');
        return Reflect.apply(journalAppend, journalReceiver, [{ schema: 1, event, nonce: fixture.nonce, ...details }]);
      }, context);
      if (!result.ok || result.value !== true || !stable() || reasonFor(context) || phase === 'blocked') { phase = 'blocked'; return false; }
      return true;
    } catch (_) { phase = 'blocked'; return false; }
    finally { journalBusy = false; }
  }
  async function unknown() {
    if (phase !== 'blocked') phase = 'review_required';
    if (unknownLogged) return;
    unknownLogged = true;
    await append('mutation_unknown', { method: 'PATCH' }, null);
  }
  function remoteCooldown(response) {
    const headers = response.safeHeaders;
    if (response.status !== 429 && headers['x-ratelimit-remaining'] !== '0' && !Object.hasOwn(headers, 'retry-after')) return;
    const wall = wallNow(); if (!Number.isFinite(wall)) throw new Error('live_clock_invalid');
    let delay = 60000;
    if (/^\d{1,6}$/.test(headers['retry-after'] || '')) delay = Number(headers['retry-after']) * 1000;
    else if (headers['retry-after']) {
      const time = Date.parse(headers['retry-after']);
      if (Number.isFinite(time)) delay = Math.max(0, time - wall);
    }
    if (/^\d{1,12}$/.test(headers['x-ratelimit-reset'] || '')) delay = Math.max(delay, Number(headers['x-ratelimit-reset']) * 1000 - wall);
    if (!Number.isFinite(delay) || delay > 86400000) { phase = 'review_required'; return; }
    cooldownUntil = Math.max(cooldownUntil, clock() + Math.max(1000, delay));
  }
  async function request({ context, method, bodyBytes, verify = false }) {
    let blocked = gate(context, method, verify); if (blocked) return fail(blocked);
    if (method === 'PATCH') {
      try {
        const current = clock(); blocked = gate(context, method); if (blocked) return fail(blocked);
        if (current < cooldownUntil) return fail('live_rate_limited');
        const delay = Math.max(0, Math.ceil(1000 - (current - lastMutation)));
        if (delay) {
          const waited = await waitStage(() => sleep(delay), context);
          blocked = gate(context, method); if (blocked) return fail(blocked);
          if (!waited.ok || clock() - lastMutation < 1000) { phase = 'blocked'; return fail('live_throttle_failed'); }
        }
      } catch (_) { phase = 'blocked'; return fail('live_throttle_failed'); }
      const intentionSha256 = sha(JSON.stringify({ method, pathHash: sha(ownedPath), bodySha256: sha(bodyBytes) }));
      if (!await append('mutation_intention', { method, intentionSha256 }, context)) return fail('live_journal_failed');
      blocked = gate(context, method); if (blocked) return fail(blocked);
      try { if (clock() - lastMutation < 1000) throw new Error('live_throttle_failed'); }
      catch (_) { phase = 'blocked'; return fail('live_throttle_failed'); }
    }
    blocked = gate(context, method, verify); if (blocked) return fail(blocked);
    const controller = new AbortController();
    let dispatched = false;
    const cancelTransport = () => { if (method === 'PATCH' && dispatched && phase !== 'blocked') phase = 'review_required'; controller.abort(); };
    const result = await waitStage(() => {
      const dispatchTime = method === 'PATCH' ? clock() : null;
      blocked = gate(context, method, verify);
      if (blocked || controller.signal.aborted) throw new Error('live_predispatch_blocked');
      if (method === 'PATCH') { lastMutation = dispatchTime; mutations += 1; }
      requests += 1; dispatched = true; transportPending = true;
      let value;
      try { value = transport({ actor: context?.actor ?? 'witness', method, path: ownedPath,
        bodyBytes: bodyBytes && Buffer.from(bodyBytes), signal: controller.signal, timeoutMs, redirect: 'error' }); }
      catch (error) { transportPending = false; throw error; }
      // A timeout/abort does not prove a transport honoring AbortSignal. Until
      // this settles the next operation is refused, including read-only GET.
      return Promise.resolve(value).finally(() => { transportPending = false; });
    }, context, cancelTransport);
    if (!result.ok) {
      if (method === 'PATCH' && dispatched) await unknown();
      return fail(method === 'PATCH' && dispatched ? 'live_write_unknown' : 'live_request_failed');
    }
    if (phase === 'blocked' || reasonFor(context)) {
      if (method === 'PATCH' && dispatched) await unknown();
      return fail('live_request_context_changed');
    }
    let response;
    try {
      response = responseBytes(result.value);
      if (response.status === 200 && !validOwned(parseJson(response.bodyBytes), fixture, binding)) throw new Error('live_owned_invalid');
      remoteCooldown(response);
    } catch (_) {
      ownershipVerified = false;
      if (method === 'PATCH') await unknown(); else phase = 'review_required';
      return fail('live_owned_response_invalid');
    }
    if (method === 'PATCH' && response.status !== 200 && !REJECTIONS.has(response.status)) await unknown();
    if (phase === 'blocked' || reasonFor(context)) {
      if (method === 'PATCH' && dispatched) await unknown();
      return fail('live_request_context_changed');
    }
    if (verify) {
      if (response.status !== 200 || phase !== 'unverified') { phase = 'review_required'; return fail('live_owned_verification_failed'); }
      phase = 'owned'; ownershipVerified = true; return { ok: true };
    }
    return { ok: true, ...response };
  }
  function admission(input) {
    if (!object(input) || Object.keys(input).length > 5) throw new Error('live_request_blocked');
    // Read each caller-owned field once, before validation. Getters must not
    // turn a checked GET into DELETE (or change actor/path) at dispatch time.
    input = Object.fromEntries(Object.entries(input));
    if (Object.keys(input).some(key => !['actor', 'method', 'exactPath', 'bodyBytes', 'signal'].includes(key))
      || typeof input.actor !== 'string' || !Object.hasOwn(actors, input.actor) || !['GET', 'PATCH'].includes(input.method)
      || !configured || ![ownedPath, `${LIVE_GIST_API_ORIGIN}${ownedPath}`].includes(input.exactPath)
      || input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw new Error('live_request_blocked');
    const context = { actor: input.actor, epoch: actors[input.actor].epoch, signal: input.signal };
    if (reasonFor(context)) throw new Error('live_request_blocked');
    if (input.method === 'GET') {
      if (input.bodyBytes !== undefined) throw new Error('live_request_blocked');
      return { context, method: input.method };
    }
    const bodyBytes = copyBytes(input.bodyBytes, 262144), body = parseJson(bodyBytes), index = input.actor === 'A' ? 0 : 1;
    if (!keys(body, ['description', 'files']) || body.description === fixture.marker || !description(body.description, fixture)
      || !keys(body.files, [fixture.shards[index]]) || !keys(body.files[fixture.shards[index]], ['content'])
      || !validDocument(body.files[fixture.shards[index]].content, fixture, index)) throw new Error('live_payload_blocked');
    return { context, method: input.method, bodyBytes };
  }
  return Object.freeze({
    verifyOwned(options = {}) {
      let signal;
      try {
        if (!object(options) || !keys(options, Object.hasOwn(options, 'signal') ? ['signal'] : [])) throw new Error('live_request_blocked');
        signal = options.signal;
        if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('live_request_blocked');
      } catch (_) { return Promise.resolve(fail('live_request_blocked')); }
      return serial(() => request({ context: { signal }, method: 'GET', verify: true }));
    },
    relayOwned(input) {
      let snapshot;
      try { snapshot = admission(input); } catch (_) { return Promise.resolve(fail('live_request_blocked')); }
      return serial(() => request(snapshot));
    },
    setActorOffline(actor, offline) {
      if (typeof actor !== 'string' || !Object.hasOwn(actors, actor) || typeof offline !== 'boolean') return fail('live_actor_control_blocked');
      const state = actors[actor];
      if (state.offline !== offline) {
        state.offline = offline; state.epoch += 1;
        if (activeWait?.actor === actor) activeWait.cancel('live_actor_context_changed');
      }
      return { ok: true };
    },
    safeReport: () => Object.freeze({ phase, requests, mutations, ownershipVerified,
      ownedIdHash: configured ? sha(binding.ownedId) : null, legacySha256: configured ? fixture.legacySha256 : null }),
  });
}
