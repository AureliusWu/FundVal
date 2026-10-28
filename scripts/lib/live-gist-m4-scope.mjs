import { createHash } from 'node:crypto';
import { openSync, writeSync, fsyncSync, fstatSync, lstatSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { normalizeHoldingsDocumentV3, canonicalHoldingsDocument } from '../../js/storage/holdings-schema.js';
import { v3GistFilename } from '../../js/storage/gist-remote.js';

export const LIVE_GIST_API_ORIGIN = 'https://api.github.com';
export const LIVE_GIST_TOKEN_ENV = 'FUNDVAL_GIST_TEST_TOKEN';
export const LIVE_GIST_LEGACY_FILE = 'fuyu-holdings.json';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GIST_ID = /^[a-f0-9]{1,64}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));

export function makeLiveGistFixture({ nonce, nowISO }) {
  const time = typeof nowISO === 'string' ? Date.parse(nowISO) : NaN;
  if (!UUID.test(nonce) || !Number.isFinite(time) || new Date(time).toISOString() !== nowISO) throw new Error('live_fixture_invalid');
  const devices = [`synthetic-m4-a:${nonce}`, `synthetic-m4-b:${nonce}`];
  const holdings = ['000001', '000002'].map((fundCode, index) => ({
    id: `fund:${fundCode}`, fundCode, fundName: `Synthetic M4 ${index + 1}`, shares: 10 + index * 10,
    costNav: 1, createdAt: nowISO, updatedAt: nowISO, deletedAt: null, revision: 1, deviceId: devices[0], note: null,
  }));
  const documents = devices.map(deviceId => normalizeHoldingsDocumentV3({ schema: 3, updatedAt: nowISO, deviceId, holdings }));
  const shards = devices.map(v3GistFilename);
  const legacyContent = JSON.stringify({ schema: 2, updated_at: nowISO, device_id: `synthetic-m4-legacy:${nonce}`, holdings: [] });
  const marker = `FundVal M4 synthetic ${nonce}`;
  const files = { [LIVE_GIST_LEGACY_FILE]: { content: legacyContent }, [shards[0]]: { content: JSON.stringify(documents[0]) } };
  return Object.freeze({ nonce, marker, devices, shards, documents, legacyContent, legacySha256: sha(legacyContent),
    createBody: { description: marker, public: false, files } });
}

export function liveGistTarget(method, target, { ownedId = '', accountVerified = false, createAllowed = false, cleanupAllowed = false } = {}) {
  if (typeof target !== 'string') return 'blocked';
  let url;
  try { url = new URL(target, LIVE_GIST_API_ORIGIN); } catch (_) { return 'blocked'; }
  if (url.origin !== LIVE_GIST_API_ORIGIN || url.username || url.password || url.search || url.hash
    || /[%\\]/.test(target) || ![url.pathname, `${LIVE_GIST_API_ORIGIN}${url.pathname}`].includes(target)) return 'blocked';
  if (method === 'GET' && url.pathname === '/user' && !ownedId) return 'account';
  if (!accountVerified) return 'blocked';
  if (method === 'POST' && url.pathname === '/gists' && createAllowed && !ownedId) return 'create';
  if (!GIST_ID.test(ownedId) || url.pathname !== `/gists/${ownedId}`) return 'blocked';
  if (method === 'GET') return 'read';
  if (method === 'PATCH') return 'patch';
  return method === 'DELETE' && cleanupAllowed ? 'cleanup' : 'blocked';
}

export function validateLiveGistPatch(body, fixture) {
  try {
    if (!exactKeys(body, ['files']) || !record(body.files) || !Object.keys(body.files).length) return false;
    for (const [filename, file] of Object.entries(body.files)) {
      const index = fixture.shards.indexOf(filename);
      if (index < 0 || !exactKeys(file, ['content']) || typeof file.content !== 'string' || Buffer.byteLength(file.content) > 131072) return false;
      const parsed = JSON.parse(file.content);
      if (!exactKeys(parsed, ['schema', 'updatedAt', 'deviceId', 'holdings']) || parsed.schema !== 3 || parsed.deviceId !== fixture.devices[index]) return false;
      const normalized = normalizeHoldingsDocumentV3(parsed);
      if (normalized.holdings.length > 2 || normalized.holdings.some(row => !['000001', '000002'].includes(row.fundCode)
        || row.fundName !== `Synthetic M4 ${Number(row.fundCode)}` || row.note !== null || row.costNav !== 1
        || row.shares > 1000 || !fixture.devices.includes(row.deviceId))) return false;
      for (const row of parsed.holdings) if (!exactKeys(row, ['id', 'fundCode', 'fundName', 'shares', 'costNav', 'createdAt', 'updatedAt', 'deletedAt', 'revision', 'deviceId', 'note'])) return false;
    }
    return true;
  } catch (_) { return false; }
}

export function validateOwnedLiveGist(value, fixture, { approvedLogin, accountId, ownedId = '' }) {
  try {
    if (!record(value) || !GIST_ID.test(value.id) || ownedId && value.id !== ownedId || value.public !== false
      || value.description !== fixture.marker || value.owner?.login !== approvedLogin || value.owner?.id !== accountId || value.truncated === true
      || !record(value.files) || !value.files[LIVE_GIST_LEGACY_FILE] || !value.files[fixture.shards[0]]) return false;
    for (const [filename, file] of Object.entries(value.files)) {
      if (!record(file) || file.truncated === true || typeof file.content !== 'string') return false;
      if (filename === LIVE_GIST_LEGACY_FILE) { if (sha(file.content) !== fixture.legacySha256) return false; }
      else if (!validateLiveGistPatch({ files: { [filename]: { content: file.content } } }, fixture)) return false;
    }
    return true;
  } catch (_) { return false; }
}

function submittedFilesMatch(body, value) {
  try {
    return Object.entries(body.files).every(([name, file]) => name === LIVE_GIST_LEGACY_FILE
      ? file.content === value.files[name].content
      : canonicalHoldingsDocument(JSON.parse(file.content)) === canonicalHoldingsDocument(JSON.parse(value.files[name].content)));
  } catch (_) { return false; }
}

export function validateLiveGistJournalRecord(value) {
  try {
    const fields = ['schema', 'event', 'nonce', 'approvedLogin', 'marker', 'bodySha256', 'method', 'intentionSha256', 'ownedId', 'ownedIdHash'];
    if (!exactKeys(value, fields) || value.schema !== 1 || !UUID.test(value.nonce)
      || !['create_intention', 'mutation_intention', 'created', 'mutation_unknown', 'deleted_verified'].includes(value.event)) return false;
    for (const key of ['bodySha256', 'intentionSha256', 'ownedIdHash']) if (key in value && !/^[a-f0-9]{64}$/.test(value[key])) return false;
    if ('approvedLogin' in value && !LOGIN.test(value.approvedLogin) || 'ownedId' in value && !GIST_ID.test(value.ownedId)
      || 'marker' in value && value.marker !== `FundVal M4 synthetic ${value.nonce}`
      || 'method' in value && !['POST', 'PATCH', 'DELETE'].includes(value.method)) return false;
    return true;
  } catch (_) { return false; }
}

// Instantiation does no IO. A descriptor created with wx remains open so later
// records cannot silently follow a replaced path/symlink. All records are hashes
// and controlled identity/nonce/intention metadata, never token or holdings text.
export function createLiveGistJournal(path) {
  let fd = null, identity;
  function append(value) {
    if (fd === null || !validateLiveGistJournalRecord(value)) return false;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== identity.ino || stat.dev !== identity.dev) return false;
    writeSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); return true;
  }
  return Object.freeze({
    createExclusive(value) {
      if (fd !== null || !isAbsolute(path) || !validateLiveGistJournalRecord(value)) return false;
      fd = openSync(path, 'wx', 0o600); identity = fstatSync(fd);
      return append(value);
    },
    append,
    close() { if (fd !== null) { closeSync(fd); fd = null; } },
  });
}

// No credential/HTTP implementation is embedded here. An eventual reviewed
// browser driver must inject a bounded authenticated transport; tests inject
// only in-memory mocks. Redirects must not escape this exact endpoint policy.
export function createLiveGistScope({ approvedLogin, fixture, journal, transport, cleanupOwned = false,
  now = () => performance.now(), sleep = ms => new Promise(done => setTimeout(done, ms)), timeoutMs = 15000 }) {
  cleanupOwned = cleanupOwned === true;
  let phase = 'unverified', accountId = null, ownedId = '', createAttempted = false;
  let requests = 0, mutations = 0, lastMutation = null, queue = Promise.resolve();
  let fixtureValid = false;
  try {
    const canonical = makeLiveGistFixture({ nonce: fixture.nonce, nowISO: fixture.documents[0].updatedAt });
    fixtureValid = JSON.stringify(fixture) === JSON.stringify(canonical);
    fixture = canonical;
  } catch (_) { fixture = null; }
  const configured = LOGIN.test(approvedLogin) && fixtureValid
    && typeof journal?.createExclusive === 'function' && typeof journal?.append === 'function'
    && typeof transport === 'function' && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30000;
  const failure = reason => ({ ok: false, reason });
  const serial = action => { const result = queue.then(action, action); queue = result.then(() => {}, () => {}); return result; };
  async function log(event, details = {}, exclusive = false) {
    try { return (await journal[exclusive ? 'createExclusive' : 'append']({ schema: 1, event, nonce: fixture.nonce, ...details })) === true; }
    catch (_) { return false; }
  }
  async function request(method, path, body) {
    const type = liveGistTarget(method, path, { ownedId, accountVerified: accountId !== null,
      createAllowed: phase === 'creating', cleanupAllowed: cleanupOwned });
    if (type === 'blocked') return failure('live_scope_blocked');
    if (method === 'PATCH' && !validateLiveGistPatch(body, fixture)) return failure('live_payload_blocked');
    const mutating = ['POST', 'PATCH', 'DELETE'].includes(method);
    if (mutating) {
      try {
        const clock = now();
        if (!Number.isFinite(clock) || lastMutation !== null && clock < lastMutation) throw new Error('live_clock_invalid');
        if (lastMutation !== null) {
          const delay = Math.max(0, Math.ceil(1000 - (clock - lastMutation)));
          if (delay) await sleep(delay);
          if (now() - lastMutation < 1000) throw new Error('live_throttle_incomplete');
        }
      } catch (_) { phase = 'blocked'; return failure('live_throttle_failed'); }
      const intentionSha256 = sha(JSON.stringify({ method, pathHash: sha(path), body: body ?? null }));
      if (!await log('mutation_intention', { method, intentionSha256 })) { phase = 'blocked'; return failure('live_journal_failed'); }
      try {
        const clock = now();
        if (!Number.isFinite(clock) || lastMutation !== null && clock - lastMutation < 1000) throw new Error('live_clock_invalid');
        lastMutation = clock;
      } catch (_) { phase = 'blocked'; return failure('live_throttle_failed'); }
      mutations += 1;
    }
    const controller = new AbortController(); let timer;
    requests += 1;
    try {
      const response = await Promise.race([
        transport({ method, path, body, signal: controller.signal, timeoutMs, redirect: 'error' }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('live_timeout')); }, timeoutMs); }),
      ]);
      if (!record(response) || !Number.isInteger(response.status)) throw new Error('live_response_invalid');
      if (response.status >= 300 && response.status < 400) return failure('live_redirect_blocked');
      return { ok: true, status: response.status, data: response.data };
    } catch (_) {
      if (mutating) { phase = method === 'POST' ? 'create_unknown' : 'write_unknown'; await log('mutation_unknown', { method }); }
      return failure(mutating ? 'live_write_unknown' : 'live_request_failed');
    } finally { clearTimeout(timer); }
  }
  const ownedValid = data => validateOwnedLiveGist(data, fixture, { approvedLogin, accountId, ownedId });
  async function readInternal() {
    if (!ownedId) return failure('live_owned_id_missing');
    const response = await request('GET', `/gists/${ownedId}`);
    if (!response.ok || response.status !== 200 || !ownedValid(response.data)) return failure('live_owned_validation_failed');
    return { ok: true, data: response.data };
  }
  return Object.freeze({
    verifyAccount: () => serial(async () => {
      if (!configured || phase !== 'unverified') return failure('live_configuration_blocked');
      const response = await request('GET', '/user');
      if (!response.ok || response.status !== 200 || response.data?.login !== approvedLogin || !Number.isSafeInteger(response.data?.id) || response.data.id < 1) {
        phase = 'blocked'; return failure('live_account_mismatch');
      }
      accountId = response.data.id; phase = 'ready'; return { ok: true };
    }),
    createSynthetic: () => serial(async () => {
      if (!configured || phase !== 'ready' || createAttempted) return failure('live_create_blocked');
      createAttempted = true;
      if (!await log('create_intention', { approvedLogin, marker: fixture.marker, bodySha256: sha(JSON.stringify(fixture.createBody)) }, true)) {
        phase = 'blocked'; return failure('live_journal_failed');
      }
      phase = 'creating';
      const response = await request('POST', '/gists', fixture.createBody);
      if (!response.ok) return response.reason === 'live_write_unknown' ? failure('live_create_unknown') : response;
      if (response.status !== 201 || !ownedValid(response.data)) { phase = 'create_unknown'; return failure('live_create_unknown'); }
      ownedId = response.data.id;
      if (!await log('created', { approvedLogin, ownedId, marker: fixture.marker })) { phase = 'blocked'; return failure('live_journal_failed'); }
      phase = 'owned'; const readback = await readInternal();
      if (!readback.ok) { phase = 'review_required'; return readback; }
      if (!submittedFilesMatch(fixture.createBody, readback.data)) { phase = 'review_required'; return failure('live_readback_mismatch'); }
      return { ok: true };
    }),
    readOwned: () => serial(readInternal),
    patchOwned: body => serial(async () => {
      if (phase !== 'owned') return failure('live_write_review_required');
      if (!validateLiveGistPatch(body, fixture)) return failure('live_payload_blocked');
      const before = await readInternal(); if (!before.ok) return before;
      const response = await request('PATCH', `/gists/${ownedId}`, body);
      if (!response.ok) return response;
      if (response.status !== 200 || !ownedValid(response.data)) { phase = 'write_unknown'; return failure('live_write_unknown'); }
      const readback = await readInternal();
      if (!readback.ok) { phase = 'review_required'; return readback; }
      if (!submittedFilesMatch(body, readback.data)) { phase = 'review_required'; return failure('live_readback_mismatch'); }
      return readback;
    }),
    cleanupOwned: () => serial(async () => {
      if (!cleanupOwned || phase !== 'owned') return failure('live_cleanup_blocked');
      const before = await readInternal(); if (!before.ok) return before;
      const removed = await request('DELETE', `/gists/${ownedId}`);
      if (!removed.ok) return removed.reason === 'live_write_unknown' ? failure('live_cleanup_unknown') : removed;
      if (removed.status !== 204) { phase = 'write_unknown'; return failure('live_cleanup_unknown'); }
      const absent = await request('GET', `/gists/${ownedId}`);
      if (!absent.ok || absent.status !== 404) { phase = 'review_required'; return failure('live_cleanup_unverified'); }
      phase = 'deleted'; await log('deleted_verified', { ownedIdHash: sha(ownedId) }); return { ok: true };
    }),
    getOwnedId: () => ownedId,
    safeReport: () => Object.freeze({ phase, requests, mutations, accountVerified: accountId !== null,
      ownedIdHash: ownedId ? sha(ownedId) : null, legacySha256: fixture?.legacySha256 ?? null }),
  });
}
