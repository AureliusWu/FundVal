import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  makeLiveGistFixture, liveGistTarget, validateLiveGistPatch, validateOwnedLiveGist,
  createLiveGistJournal, createLiveGistScope, validateLiveGistJournalRecord, LIVE_GIST_LEGACY_FILE,
} from '../scripts/lib/live-gist-m4-scope.mjs';
import { planLiveGistM4, runLiveGistM4Preparation } from '../scripts/verify-live-gist-m4.mjs';

const NONCE = '12345678-1234-4123-8123-123456789abc';
const TIME = '2026-10-25T00:00:00.000Z';
const LOGIN = 'synthetic-test-account';
const ID = 'a'.repeat(32);
const PRIVATE = 'synthetic-private-error-must-not-escape';
const fixture = () => makeLiveGistFixture({ nonce: NONCE, nowISO: TIME });
function gist(f) {
  return { id: ID, description: f.marker, public: false, owner: { login: LOGIN, id: 123 }, truncated: false,
    files: Object.fromEntries(Object.entries(f.createBody.files).map(([name, value]) => [name, { ...value, truncated: false }])) };
}
function patch(f, shares = 12) {
  const document = structuredClone(f.documents[0]); document.holdings[0].shares = shares; document.holdings[0].revision += 1;
  return { files: { [f.shards[0]]: { content: JSON.stringify(document) } } };
}
function harness(options = {}) {
  const f = options.fixture || fixture(), state = { gist: gist(f), clock: 0, deleted: false, active: 0, maximumActive: 0 };
  const calls = [], events = [];
  let exclusive = false;
  const journal = {
    createExclusive(event) { events.push(event); if (options.journalRefuses || exclusive) return false; exclusive = true; return true; },
    append(event) { events.push(event); return !options.appendRefuses; },
  };
  const transport = async request => {
    calls.push({ method: request.method, path: request.path, clock: state.clock, redirect: request.redirect });
    state.active += 1; state.maximumActive = Math.max(state.maximumActive, state.active);
    try {
      if (options.request) { const value = await options.request(request, state); if (value !== undefined) return value; }
      if (request.method === 'GET' && request.path === '/user') return { status: 200, data: { login: options.login || LOGIN, id: 123 } };
      if (request.method === 'POST') return { status: 201, data: structuredClone(state.gist) };
      if (request.method === 'PATCH') {
        for (const [name, value] of Object.entries(request.body.files)) state.gist.files[name] = { ...value, truncated: false };
        return { status: 200, data: structuredClone(state.gist) };
      }
      if (request.method === 'DELETE') { state.deleted = true; return { status: 204 }; }
      return state.deleted ? { status: 404 } : { status: 200, data: structuredClone(state.gist) };
    } finally { state.active -= 1; }
  };
  const scope = createLiveGistScope({ approvedLogin: LOGIN, fixture: f, journal, transport, cleanupOwned: options.cleanup,
    now: () => state.clock, sleep: options.sleep || (async ms => { state.clock += ms; }), timeoutMs: options.timeoutMs || 100 });
  return { f, state, calls, events, scope };
}
async function owned(h) { assert.equal((await h.scope.verifyAccount()).ok, true); assert.equal((await h.scope.createSynthetic()).ok, true); }

test('M4 live tool defaults to a safe zero-request plan and explicit execute remains not-run', () => {
  const dry = runLiveGistM4Preparation();
  assert.equal(dry.exitCode, 0); assert.equal(dry.report.status, 'PREPARED_NOT_RUN'); assert.equal(dry.report.tokenRead, false);
  const execute = runLiveGistM4Preparation(['--execute', '--approved-login', LOGIN, '--new-synthetic-only', '--site', 'synthetic-site', '--journal', 'synthetic-journal']);
  assert.equal(execute.exitCode, 2); assert.equal(execute.report.reason, 'live_browser_driver_incomplete'); assert.equal(execute.report.realRequests, 0);
  assert.equal(execute.report.browserContextsStarted, 0); assert.equal(execute.report.executionReady, false);
  const source = readFileSync(new URL('../scripts/verify-live-gist-m4.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env\s*(?:\.|\[)|gh\s+auth\s+token|\.launch\s*\(|\bfetch\s*\(/);
});

test('M4 live argument gates reject missing, duplicated and token-bearing options without echo', () => {
  for (const args of [['--execute'], ['--cleanup-owned'], ['--token', PRIVATE], ['--execute', '--execute'], ['--approved-login']]) {
    const result = runLiveGistM4Preparation(args); assert.equal(result.exitCode, 2); assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  }
  assert.equal(planLiveGistM4(['--execute', '--approved-login', LOGIN, '--new-synthetic-only']).ok, false);
});

test('M4 target gate admits only user verification, one create and the owned exact id', () => {
  const scope = { accountVerified: true, ownedId: ID };
  assert.equal(liveGistTarget('GET', '/user'), 'account');
  assert.equal(liveGistTarget('POST', '/gists', { accountVerified: true, createAllowed: true }), 'create');
  assert.equal(liveGistTarget('GET', `/gists/${ID}`, scope), 'read');
  assert.equal(liveGistTarget('PATCH', `https://api.github.com/gists/${ID}`, scope), 'patch');
  for (const path of ['/gists', '/gists/public', `/gists/${'b'.repeat(32)}`, `/gists/${ID}/comments`, `/gists/${ID}?token=secret`,
    `https://api.github.com.evil.invalid/gists/${ID}`, `https://synthetic:password@api.github.com/gists/${ID}`, `/gists/%61${ID.slice(1)}`]) {
    assert.equal(liveGistTarget('GET', path, scope), 'blocked');
  }
  assert.equal(liveGistTarget('DELETE', `/gists/${ID}`, scope), 'blocked');
  assert.equal(liveGistTarget('DELETE', `/gists/${ID}`, { ...scope, cleanupAllowed: true }), 'cleanup');
});

test('M4 scope rejects normalized aliases and protocol-relative request targets', () => {
  for (const target of ['//api.github.com/user', '/something/../user', 'https://api.github.com/something/../user']) assert.equal(liveGistTarget('GET', target), 'blocked');
});

test('M4 fixture is synthetic Schema3 shards plus an immutable legacy file', () => {
  const f = fixture(); assert.equal(f.createBody.public, false); assert.equal(f.marker.includes(NONCE), true);
  assert.equal(f.shards.length, 2); assert.equal(f.documents[0].schema, 3); assert.equal(f.documents[1].deviceId === f.devices[1], true);
  assert.equal(validateLiveGistPatch(patch(f), f), true);
  assert.equal(validateLiveGistPatch({ files: { [LIVE_GIST_LEGACY_FILE]: { content: '{}' } } }, f), false);
  assert.throws(() => makeLiveGistFixture({ nonce: 'wrong', nowISO: TIME }));
});

test('M4 patch gate forbids real/uncontrolled files, metadata, deletion, rename and user content', () => {
  const f = fixture();
  const bad = [
    { files: { 'user-private.json': { content: '{}' } } }, { ...patch(f), description: PRIVATE },
    { files: { [f.shards[0]]: null } }, { files: { [f.shards[0]]: { filename: 'elsewhere.json', content: '{}' } } },
  ];
  for (const body of bad) assert.equal(validateLiveGistPatch(body, f), false);
  const body = patch(f), document = JSON.parse(body.files[f.shards[0]].content);
  document.holdings[0].note = PRIVATE; body.files[f.shards[0]].content = JSON.stringify(document);
  assert.equal(validateLiveGistPatch(body, f), false);
});

test('M4 ownership requires exact account, id, marker, secret flag and original controlled legacy bytes', () => {
  const f = fixture(), value = gist(f), expected = { approvedLogin: LOGIN, accountId: 123, ownedId: ID };
  assert.equal(validateOwnedLiveGist(value, f, expected), true);
  for (const delta of [{ public: true }, { description: 'different' }, { id: 'b'.repeat(32) }, { owner: { login: LOGIN.toUpperCase(), id: 123 } }, { truncated: true }]) assert.equal(validateOwnedLiveGist({ ...value, ...delta }, f, expected), false);
  value.files[LIVE_GIST_LEGACY_FILE].content = '{}'; assert.equal(validateOwnedLiveGist(value, f, expected), false);
});

test('M4 exact login mismatch prevents journal creation and every mutation', async () => {
  const h = harness({ login: LOGIN.toUpperCase() });
  assert.deepEqual(await h.scope.verifyAccount(), { ok: false, reason: 'live_account_mismatch' });
  assert.equal((await h.scope.createSynthetic()).ok, false); assert.equal(h.calls.length, 1); assert.equal(h.events.length, 0);
});

test('M4 journal exclusive intention precedes the sole POST; concurrent create cannot duplicate it', async () => {
  const h = harness(); await h.scope.verifyAccount();
  const results = await Promise.all([h.scope.createSynthetic(), h.scope.createSynthetic()]);
  assert.equal(results[0].ok, true); assert.equal(results[1].ok, false);
  assert.equal(h.calls.filter(row => row.method === 'POST').length, 1);
  assert.equal(h.events[0].event, 'create_intention'); assert.equal(h.events[1].event, 'mutation_intention');
  assert.equal(h.events[2].event, 'created');
});

test('M4 an existing/refused journal prevents POST and cannot be blindly reused', async () => {
  const h = harness({ journalRefuses: true }); await h.scope.verifyAccount();
  assert.equal((await h.scope.createSynthetic()).reason, 'live_journal_failed');
  assert.equal((await h.scope.createSynthetic()).ok, false); assert.equal(h.calls.some(row => row.method === 'POST'), false);
  assert.equal(createLiveGistJournal('not-an-absolute-journal').createExclusive({ event: 'test' }), false);
});

test('M4 concurrent mutations use one queue, original ownership reads and >=1 second spacing', async () => {
  const h = harness(); await owned(h);
  await Promise.all([h.scope.patchOwned(patch(h.f, 12)), h.scope.patchOwned(patch(h.f, 14))]);
  const mutations = h.calls.filter(row => ['POST', 'PATCH', 'DELETE'].includes(row.method));
  assert.equal(mutations.length, 3); assert.equal(h.state.maximumActive, 1);
  for (let index = 1; index < mutations.length; index += 1) assert.ok(mutations[index].clock - mutations[index - 1].clock >= 1000);
  assert.equal(h.calls.every(row => row.redirect === 'error'), true);
});

test('M4 unknown POST never retries or creates another Gist and does not invent an owned id', async () => {
  const h = harness({ request(request) { if (request.method === 'POST') throw new Error(PRIVATE); } });
  await h.scope.verifyAccount(); assert.equal((await h.scope.createSynthetic()).reason, 'live_create_unknown');
  assert.equal((await h.scope.createSynthetic()).ok, false); assert.equal((await h.scope.readOwned()).ok, false);
  assert.equal(h.calls.filter(row => row.method === 'POST').length, 1); assert.equal(h.scope.getOwnedId(), '');
  assert.equal(JSON.stringify(h.scope.safeReport()).includes(PRIVATE), false);
});

test('M4 unknown PATCH allows owned readback only, never a replay or cleanup', async () => {
  const h = harness({ cleanup: true, request(request) { if (request.method === 'PATCH') throw new Error(PRIVATE); } });
  await owned(h); assert.equal((await h.scope.patchOwned(patch(h.f))).reason, 'live_write_unknown');
  assert.equal((await h.scope.readOwned()).ok, true);
  assert.equal((await h.scope.patchOwned(patch(h.f))).ok, false); assert.equal((await h.scope.cleanupOwned()).ok, false);
  assert.equal(h.calls.filter(row => row.method === 'PATCH').length, 1);
});

test('M4 timeout is bounded, marks an unknown mutation and does not leak transport errors', async () => {
  let signal;
  const h = harness({ timeoutMs: 10, request(request) { if (request.method === 'PATCH') { signal = request.signal; return new Promise(() => {}); } } });
  await owned(h); const result = await h.scope.patchOwned(patch(h.f));
  assert.equal(result.ok, false); assert.equal(signal.aborted, true); assert.equal(h.scope.safeReport().phase, 'write_unknown');
});

test('M4 real readback must canonically equal the requested shard, not merely remain well shaped', async () => {
  const h = harness({ request(request, state) { if (request.method === 'PATCH') return { status: 200, data: structuredClone(state.gist) }; } });
  await owned(h); const result = await h.scope.patchOwned(patch(h.f));
  assert.equal(result.ok, false); assert.equal(result.reason, 'live_readback_mismatch');
});

test('M4 blocked payload cannot produce an actual PATCH or a false unknown-write claim', async () => {
  const h = harness(); await owned(h);
  assert.deepEqual(await h.scope.patchOwned({ files: { 'private-user-file': { content: PRIVATE } } }), { ok: false, reason: 'live_payload_blocked' });
  assert.equal(h.calls.some(row => row.method === 'PATCH'), false);
});

test('M4 rejected throttle remains a fixed safe result rather than a leaked exception', async () => {
  const h = harness({ sleep: async () => { throw new Error(PRIVATE); } }); await owned(h);
  const result = await h.scope.patchOwned(patch(h.f)); assert.equal(result.ok, false); assert.equal(result.reason, 'live_throttle_failed');
  assert.equal(h.calls.some(row => row.method === 'PATCH'), false);
});

test('M4 mutated fixture configuration cannot create a public or uncontrolled Gist', async () => {
  const f = fixture(); f.createBody.public = true;
  const h = harness({ fixture: f }); assert.equal((await h.scope.verifyAccount()).ok, false);
  assert.equal((await h.scope.createSynthetic()).ok, false); assert.equal(h.calls.length, 0);
});

test('M4 explicit cleanup rechecks ownership then requires DELETE204 followed by GET404', async () => {
  const denied = harness(); await owned(denied); assert.equal((await denied.scope.cleanupOwned()).ok, false);
  const h = harness({ cleanup: true }); await owned(h); assert.equal((await h.scope.cleanupOwned()).ok, true);
  assert.deepEqual(h.calls.slice(-3).map(row => row.method), ['GET', 'DELETE', 'GET']);
  assert.equal(h.scope.safeReport().phase, 'deleted');
});

test('M4 changed ownership or legacy bytes refuse cleanup without deleting anything', async () => {
  const h = harness({ cleanup: true }); await owned(h); h.state.gist.files[LIVE_GIST_LEGACY_FILE].content = '{}';
  assert.equal((await h.scope.cleanupOwned()).ok, false); assert.equal(h.calls.some(row => row.method === 'DELETE'), false);
});

test('M4 redirects are not followed and safe reports contain only counters, enums and hashes', async () => {
  const h = harness({ request(request) { if (request.method === 'POST') return { status: 307, data: { private: PRIVATE } }; } });
  await h.scope.verifyAccount(); assert.equal((await h.scope.createSynthetic()).ok, false);
  const report = h.scope.safeReport(); assert.deepEqual(Object.keys(report).sort(), ['accountVerified', 'legacySha256', 'mutations', 'ownedIdHash', 'phase', 'requests']);
  assert.doesNotMatch(JSON.stringify(report), /https:|Authorization|synthetic-private-error|holdings|content|token/i);
});

test('M4 journal rejects arbitrary body, credential and URL fields before any file creation', () => {
  const value = { schema: 1, event: 'create_intention', nonce: NONCE, approvedLogin: LOGIN, marker: `FundVal M4 synthetic ${NONCE}`, bodySha256: 'a'.repeat(64) };
  assert.equal(validateLiveGistJournalRecord(value), true);
  for (const extra of [{ token: PRIVATE }, { headers: { Authorization: PRIVATE } }, { content: PRIVATE }, { url: `https://example.invalid/?token=${PRIVATE}` }]) assert.equal(validateLiveGistJournalRecord({ ...value, ...extra }), false);
});

test('M4 journal append failure before POST is not mislabeled as an attempted unknown write', async () => {
  const h = harness({ appendRefuses: true }); await h.scope.verifyAccount();
  assert.equal((await h.scope.createSynthetic()).reason, 'live_journal_failed');
  assert.equal(h.calls.some(row => row.method === 'POST'), false); assert.equal(h.scope.safeReport().mutations, 0);
});

test('M4 truthy nonboolean cleanup option is not explicit deletion approval', async () => {
  const h = harness({ cleanup: 'true' }); await owned(h);
  assert.equal((await h.scope.cleanupOwned()).ok, false); assert.equal(h.calls.some(row => row.method === 'DELETE'), false);
});
