import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeLiveGistFixture, validateLiveGistJournalRecord } from '../scripts/lib/live-gist-m4-scope.mjs';
import { createLiveGistRelay } from '../scripts/lib/live-gist-m4-relay.mjs';

const NONCE = '12345678-1234-4123-8123-123456789abc';
const TIME = '2026-10-28T00:00:00.000Z';
const ID = 'a'.repeat(32);
const PRIVATE = 'private-token-url-body-sentinel';
const path = `/gists/${ID}`;
const bytes = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(done => setImmediate(done));

function harness(options = {}) {
  const fixture = makeLiveGistFixture({ nonce: NONCE, nowISO: TIME });
  const binding = { approvedLogin: 'summersin77', accountId: 301138048, ownedId: ID,
    nonce: NONCE, legacySha256: fixture.legacySha256, lastMutationAt: 0 };
  const state = { clock: 1000, active: 0, maxActive: 0, gist: {
    id: ID, public: false, description: fixture.marker, owner: { login: binding.approvedLogin, id: binding.accountId },
    files: Object.fromEntries(Object.entries(fixture.createBody.files).map(([name, file]) => [name, { ...file, truncated: false }])),
  } };
  const calls = [], events = [];
  const journal = { append(event) { events.push(structuredClone(event));
    assert.equal(validateLiveGistJournalRecord(event), true);
    return options.append ? options.append(event, state) : true;
  } };
  const transport = async request => {
    calls.push({ ...request, bodyBytes: request.bodyBytes && Buffer.from(request.bodyBytes), clock: state.clock });
    state.active += 1; state.maxActive = Math.max(state.maxActive, state.active);
    try {
      const custom = options.transport && await options.transport(request, state);
      if (custom !== undefined) return custom;
      if (request.method === 'PATCH') {
        const body = JSON.parse(Buffer.from(request.bodyBytes).toString('utf8'));
        state.gist.description = body.description;
        for (const [name, file] of Object.entries(body.files)) state.gist.files[name] = { ...file, truncated: false };
      }
      return { status: 200, headers: { 'content-type': 'application/json', etag: '"unchanged raw etag"' }, bodyBytes: bytes(state.gist) };
    } finally { state.active -= 1; }
  };
  const relay = createLiveGistRelay({ fixture: options.fixture || fixture, binding: options.binding || binding, journal,
    transport, now: options.now || (() => state.clock), wallNow: () => Date.parse(TIME),
    sleep: options.sleep || (async ms => { state.clock += ms; }), timeoutMs: options.timeoutMs || 50 });
  return { fixture, binding, state, calls, events, relay, journal };
}
async function verified(h) { assert.deepEqual(await h.relay.verifyOwned(), { ok: true }); }
function patch(h, actor = 'A', shares = 12) {
  const index = actor === 'A' ? 0 : 1;
  const document = structuredClone(h.fixture.documents[index]);
  document.holdings[0].shares = shares; document.holdings[0].revision += 1;
  return { description: `FundVal 持仓数据 | ${TIME}`, files: { [h.fixture.shards[index]]: { content: JSON.stringify(document) } } };
}
const send = (h, body = patch(h), actor = 'A', extra = {}) => h.relay.relayOwned({ actor, method: 'PATCH', exactPath: path, bodyBytes: bytes(body), ...extra });
const read = (h, actor = 'A', extra = {}) => h.relay.relayOwned({ actor, method: 'GET', exactPath: path, ...extra });

test('pure relay construction does no IO and has no credential/network/create/cleanup API', () => {
  const h = harness(); assert.equal(h.calls.length, 0); assert.equal(h.events.length, 0);
  assert.deepEqual(Object.keys(h.relay).sort(), ['relayOwned', 'safeReport', 'setActorOffline', 'verifyOwned']);
  const source = readFileSync(new URL('../scripts/lib/live-gist-m4-relay.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|\bfetch\s*\(|gh\s+auth|node:fs|\.launch\s*\(/);
});

test('real App PATCH shape is relayed once with original bytes/status/limited headers/body', async () => {
  const h = harness(); await verified(h);
  const body = patch(h), raw = bytes(body);
  const result = await h.relay.relayOwned({ actor: 'A', method: 'PATCH', exactPath: path, bodyBytes: raw });
  assert.equal(result.ok, true); assert.equal(result.status, 200);
  assert.deepEqual(h.calls.map(value => value.method), ['GET', 'PATCH']);
  assert.deepEqual(h.calls[1].bodyBytes, raw); assert.deepEqual(result.bodyBytes, bytes(h.state.gist));
  assert.deepEqual(result.safeHeaders, { 'content-type': 'application/json', etag: '"unchanged raw etag"' });
  assert.equal(h.calls[1].redirect, 'error'); assert.equal(h.calls[1].path, path);
  assert.equal(h.events[0].event, 'mutation_intention');
  assert.equal(h.state.gist.description, body.description);
  assert.equal((await read(h, 'B')).ok, true); assert.equal((await send(h, patch(h, 'B'), 'B')).ok, true);
  assert.equal(h.relay.safeReport().phase, 'owned');
});

test('request and response buffers are snapshots, not writable aliases into the queue', async () => {
  const held = deferred(), h = harness({ transport: async request => { if (request.method === 'GET' && request.actor === 'A') await held.promise; } });
  await verified(h); const waiting = read(h), raw = bytes(patch(h)), original = Buffer.from(raw);
  const pending = h.relay.relayOwned({ actor: 'A', method: 'PATCH', exactPath: path, bodyBytes: raw });
  raw.fill(0); held.resolve(); await waiting;
  const result = await pending; assert.equal(result.ok, true); assert.deepEqual(h.calls.at(-1).bodyBytes, original);
});

for (const [label, change] of [
  ['wrong login', value => { value.owner.login = 'AureliusWu'; }],
  ['wrong numeric id', value => { value.owner.id += 1; }],
  ['wrong id', value => { value.id = 'b'.repeat(32); }],
  ['public', value => { value.public = true; }],
  ['legacy byte', (value, h) => { value.files['fuyu-holdings.json'].content = `${h.fixture.legacyContent} `; }],
  ['missing legacy', value => { delete value.files['fuyu-holdings.json']; }],
  ['extra file', value => { value.files['private.json'] = { content: PRIVATE }; }],
  ['truncated gist', value => { value.truncated = true; }],
  ['truncated file', value => { value.files['fuyu-holdings.json'].truncated = true; }],
  ['arbitrary description', value => { value.description = PRIVATE; }],
]) test(`owner verification blocks ${label} with zero mutation`, async () => {
  const h = harness(); change(h.state.gist, h);
  assert.equal((await h.relay.verifyOwned()).ok, false); assert.equal((await send(h)).ok, false);
  assert.equal(h.calls.filter(value => value.method === 'PATCH').length, 0);
  assert.equal(JSON.stringify(h.relay.safeReport()).includes(PRIVATE), false);
});

test('an App description does not destroy the immutable legacy/owner binding', async () => {
  const h = harness(); h.state.gist.description = `FundVal 持仓数据 | ${TIME}`;
  await verified(h); assert.equal((await send(h)).ok, true);
  const legacy = h.state.gist.files['fuyu-holdings.json'].content;
  assert.equal(legacy, h.fixture.legacyContent);
  h.state.gist.files['fuyu-holdings.json'].content += ' ';
  assert.equal((await read(h)).ok, false);
  h.state.gist.files['fuyu-holdings.json'].content = legacy;
  assert.equal((await read(h)).ok, true); assert.equal((await send(h)).ok, false);
});

test('invalid binding/fixture never invokes transport or journal', async () => {
  const h0 = harness();
  for (const binding of [ { ...h0.binding, accountId: 0 }, { ...h0.binding, ownedId: '../evil' },
    { ...h0.binding, legacySha256: '0'.repeat(64) }, { ...h0.binding, nonce: 'bad' },
    { ...h0.binding, lastMutationAt: -1 }, { ...h0.binding, extra: PRIVATE } ]) {
    const h = harness({ binding }); assert.equal((await h.relay.verifyOwned()).ok, false);
    assert.equal(h.calls.length, 0); assert.equal(h.events.length, 0);
  }
  const fixture = structuredClone(h0.fixture); fixture.createBody.public = true;
  const h = harness({ fixture }); assert.equal((await h.relay.verifyOwned()).ok, false); assert.equal(h.calls.length, 0);
});

test('relay requires its explicit ownership witness before accepting App requests', async () => {
  const h = harness(); assert.equal((await send(h)).ok, false); assert.equal((await read(h)).ok, false);
  assert.equal(h.calls.length, 0); await verified(h);
  assert.equal((await h.relay.verifyOwned()).ok, false); assert.equal(h.calls.length, 1);
});

test('each actor can write only its one exact shard and exact controlled metadata', async () => {
  const h = harness(); await verified(h); const bad = [];
  bad.push({ ...patch(h), description: PRIVATE });
  bad.push({ ...patch(h), extra: PRIVATE });
  bad.push({ ...patch(h), description: `FundVal 持仓数据 | 2026-02-30T00:00:00.000Z` });
  bad.push({ files: patch(h).files });
  bad.push(patch(h, 'B'));
  bad.push({ ...patch(h), files: { ...patch(h).files, ...patch(h, 'B').files } });
  bad.push({ ...patch(h), files: { 'fuyu-holdings.json': { content: h.fixture.legacyContent } } });
  bad.push({ ...patch(h), files: { [h.fixture.shards[0]]: null } });
  bad.push({ ...patch(h), files: { [h.fixture.shards[0]]: { ...Object.values(patch(h).files)[0], filename: 'elsewhere' } } });
  for (const body of bad) assert.equal((await send(h, body)).ok, false);
  assert.equal(h.calls.length, 1); assert.equal(h.events.length, 0);
});

for (const [label, change] of [
  ['extra field', doc => { doc.extra = PRIVATE; }],
  ['schema coercion', doc => { doc.schema = '3'; }],
  ['wrong document device', (doc, h) => { doc.deviceId = h.fixture.devices[1]; }],
  ['unknown record device', doc => { doc.holdings[0].deviceId = PRIVATE; }],
  ['private note', doc => { doc.holdings[0].note = PRIVATE; }],
  ['null cost outside fixture', doc => { doc.holdings[0].costNav = null; }],
  ['zero cost outside fixture', doc => { doc.holdings[0].costNav = 0; }],
  ['other fund', doc => { doc.holdings[0].fundCode = '999999'; doc.holdings[0].id = 'fund:999999'; }],
  ['unbounded shares', doc => { doc.holdings[0].shares = 1001; }],
  ['negative shares', doc => { doc.holdings[0].shares = -1; }],
  ['duplicate rows', doc => { doc.holdings.push(doc.holdings[0]); }],
  ['normalization drift', doc => { doc.holdings[0].fundName += ' '; }],
  ['missing field', doc => { delete doc.holdings[0].note; }],
]) test(`strict synthetic payload blocks ${label} before dispatch`, async () => {
  const h = harness(); await verified(h); const body = patch(h), file = body.files[h.fixture.shards[0]], doc = JSON.parse(file.content);
  change(doc, h); file.content = JSON.stringify(doc);
  assert.equal((await send(h, body)).ok, false); assert.equal(h.calls.length, 1); assert.equal(h.events.length, 0);
});

test('tombstones and deterministic merged records from either controlled device remain permitted', async () => {
  const h = harness(); await verified(h); const body = patch(h), file = body.files[h.fixture.shards[0]], doc = JSON.parse(file.content);
  doc.holdings[0].shares = 0; doc.holdings[0].deletedAt = doc.holdings[0].updatedAt; doc.holdings[0].deviceId = h.fixture.devices[1];
  file.content = JSON.stringify(doc); assert.equal((await send(h, body)).ok, true);
});

test('duplicate JSON keys and malformed/oversize byte payloads cannot bypass validation', async () => {
  const h = harness(); await verified(h); const raw = JSON.stringify(patch(h));
  for (const bodyBytes of [Buffer.from('{'), Buffer.from([0xc0, 0xaf]), Buffer.alloc(300000, 32),
    bytes(raw.replace('{"description":', '{"files":{},"description":')), bytes(raw.replace('"files":{', '"files":{},"files":{'))]) {
    assert.equal((await send(h, patch(h), 'A', { bodyBytes })).ok, false);
  }
  const body = patch(h), file = body.files[h.fixture.shards[0]];
  file.content = file.content.replace('{"schema":', '{"schema":1,"schema":');
  assert.equal((await send(h, body)).ok, false); assert.equal(h.calls.length, 1);
});

test('GET/PATCH reject unknown actors, methods, other ids, query, encoding, aliases and extra body', async () => {
  const h = harness(); await verified(h);
  const requests = [ { actor: 'C' }, { actor: 'a' }, { method: 'POST' }, { method: 'DELETE' },
    { exactPath: '/gists' }, { exactPath: `/gists/${'b'.repeat(32)}` }, { exactPath: `${path}?x=1` },
    { exactPath: `https://api.github.com.evil.invalid${path}` }, { exactPath: `//api.github.com${path}` },
    { exactPath: `/x/..${path}` }, { exactPath: `/gists/%61${ID.slice(1)}` }, { exactPath: `${path}/comments` },
    { bodyBytes: bytes({}) }, { unexpected: PRIVATE } ];
  for (const extra of requests) assert.equal((await read(h, 'A', extra)).ok, false);
  assert.equal(h.calls.length, 1);
  assert.equal((await read(h, 'B', { exactPath: `https://api.github.com${path}` })).ok, true);
});

test('two actors share one queue and >=1000ms spacing including creation handoff time', async () => {
  const h = harness(); h.state.clock = 10; await verified(h);
  await Promise.all([send(h), read(h, 'B'), send(h, patch(h, 'B'), 'B'), send(h)]);
  const mutations = h.calls.filter(value => value.method === 'PATCH');
  assert.equal(mutations.length, 3); assert.equal(h.state.maxActive, 1);
  assert.ok(mutations[0].clock - h.binding.lastMutationAt >= 1000);
  assert.ok(mutations[1].clock - mutations[0].clock >= 1000); assert.ok(mutations[2].clock - mutations[1].clock >= 1000);
});

test('pre-offline and invalid offline controls cause no transport and no queued replay', async () => {
  const h = harness(); await verified(h);
  assert.equal(h.relay.setActorOffline('A', true).ok, true);
  assert.equal((await send(h)).ok, false); assert.equal((await read(h)).ok, false);
  assert.equal(h.calls.length, 1); assert.equal(h.relay.setActorOffline('X', true).ok, false);
  assert.equal(h.relay.setActorOffline('A', 'false').ok, false);
  h.relay.setActorOffline('A', false); assert.equal(h.calls.length, 1); assert.equal((await send(h)).ok, true);
});

test('queued offline/online epoch changes invalidate old work but leave the other actor usable', async () => {
  const held = deferred(), entered = deferred();
  const h = harness({ transport: async request => { if (request.actor === 'B') { entered.resolve(); await held.promise; } } });
  // Wait for this transport, not an unrelated setImmediate turn that can run
  // after the fixture's unchanged 50 ms timeout under parallel suite load.
  await verified(h); const waiting = read(h, 'B'); await entered.promise;
  const old = send(h); h.relay.setActorOffline('A', true); h.relay.setActorOffline('A', false); held.resolve();
  assert.equal((await waiting).ok, true); assert.equal((await old).ok, false); assert.equal(h.calls.length, 2);
  assert.equal((await send(h, patch(h, 'B'), 'B')).ok, true);
});

test('offline while throttling prevents the first transport mutation', async () => {
  const held = deferred(); let relay;
  const h = harness({ sleep: async () => { relay.setActorOffline('A', true); await held.promise; } }); relay = h.relay;
  h.state.clock = 1; await verified(h); const result = await send(h); held.resolve();
  assert.equal(result.ok, false); assert.equal(h.calls.length, 1); assert.equal(h.relay.safeReport().mutations, 0);
});

test('offline during journal await prevents dispatch even if the journal later succeeds', async () => {
  const held = deferred(); let relay;
  const h = harness({ append: () => { relay.setActorOffline('A', true); return held.promise; } }); relay = h.relay;
  await verified(h); assert.equal((await send(h)).ok, false); held.resolve(true); await turn();
  assert.equal(h.calls.length, 1); assert.equal(h.relay.safeReport().mutations, 0);
});

test('pre-abort and queued abort cause no mutation; fresh signals can still proceed', async () => {
  const h = harness(); await verified(h); const controller = new AbortController(); controller.abort();
  assert.equal((await send(h, patch(h), 'A', { signal: controller.signal })).ok, false); assert.equal(h.calls.length, 1);
  const a = new AbortController(), pending = send(h, patch(h), 'A', { signal: a.signal }); a.abort();
  assert.equal((await pending).ok, false); assert.equal(h.calls.length, 1); assert.equal((await send(h)).ok, true);
});

test('abort during journal await is pre-dispatch rather than an unknown write', async () => {
  const controller = new AbortController();
  const h = harness({ append: () => { controller.abort(); return true; } }); await verified(h);
  assert.equal((await send(h, patch(h), 'A', { signal: controller.signal })).ok, false);
  assert.equal(h.calls.length, 1); assert.equal(h.relay.safeReport().mutations, 0);
  assert.equal(h.events.some(value => value.event === 'mutation_unknown'), false);
});

test('journal refuse/throw/timeout are fixed fail-closed results before transport', async () => {
  for (const append of [() => false, () => { throw new Error(PRIVATE); }, () => new Promise(() => {})]) {
    const h = harness({ append, timeoutMs: 10 }); await verified(h);
    const result = await send(h); assert.equal(result.ok, false); assert.equal(h.calls.length, 1);
    assert.equal(JSON.stringify(result).includes(PRIVATE), false); assert.equal(h.relay.safeReport().mutations, 0);
    assert.equal((await send(h)).ok, false);
  }
});

test('journal reentry cannot deadlock or allow either outer/inner mutation', async () => {
  let h, nested;
  h = harness({ append: async event => { if (event.event === 'mutation_intention') nested = await send(h); return true; } });
  await verified(h); assert.equal((await send(h)).ok, false); assert.equal(nested.ok, false);
  assert.equal(h.calls.length, 1); assert.equal(h.relay.safeReport().mutations, 0);
});

test('nonmonotonic clocks, failed sleep and incomplete throttles block without writing', async () => {
  for (const options of [ { now: () => NaN }, { sleep: () => { throw new Error(PRIVATE); } }, { sleep: async () => {} } ]) {
    const h = harness(options); h.state.clock = 1; await verified(h);
    assert.equal((await send(h)).ok, false); assert.equal(h.calls.length, 1);
  }
  const h = harness(); await verified(h); assert.equal((await send(h)).ok, true); h.state.clock = 0;
  assert.equal((await send(h)).ok, false); assert.equal(h.calls.filter(value => value.method === 'PATCH').length, 1);
});

for (const [label, response] of [
  ['network exception', () => { throw new Error(PRIVATE); }],
  ['bad status', () => ({ status: 0, headers: {}, bodyBytes: bytes(PRIVATE) })],
  ['redirect', () => ({ status: 307, headers: { location: PRIVATE }, bodyBytes: bytes(PRIVATE) })],
  ['oversize response', () => ({ status: 200, headers: {}, bodyBytes: Buffer.alloc(1100000) })],
  ['invalid owned JSON', () => ({ status: 200, headers: {}, bodyBytes: bytes({ private: PRIVATE }) })],
]) test(`dispatched PATCH ${label} permanently denies mutation but permits owned reads`, async () => {
  const h = harness({ transport: request => request.method === 'PATCH' ? response() : undefined }); await verified(h);
  const result = await send(h); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(h.relay.safeReport().phase, 'review_required'); assert.equal((await read(h)).ok, true);
  assert.equal((await send(h)).ok, false); assert.equal(h.calls.filter(value => value.method === 'PATCH').length, 1);
  assert.equal(h.events.at(-1).event, 'mutation_unknown');
});

test('PATCH 5xx forwards exact response and safe rate headers, then stays read-only', async () => {
  const body = bytes({ message: 'fixed synthetic service failure' });
  const h = harness({ transport: request => request.method === 'PATCH' ? { status: 503,
    headers: { 'content-type': 'application/json', 'retry-after': '17', 'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1793145630', authorization: PRIVATE, 'set-cookie': PRIVATE, location: PRIVATE }, bodyBytes: body } : undefined });
  await verified(h); const result = await send(h);
  assert.equal(result.ok, true); assert.equal(result.status, 503); assert.deepEqual(result.bodyBytes, body);
  assert.deepEqual(result.safeHeaders, { 'content-type': 'application/json', 'retry-after': '17',
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793145630' });
  assert.equal(h.relay.safeReport().phase, 'review_required'); assert.equal((await read(h)).ok, true);
  assert.equal((await send(h)).ok, false);
});

test('known rejection 429 is not unknown, preserves protocol, and cannot bypass remote cooldown', async () => {
  let reject = true;
  const h = harness({ transport: request => request.method === 'PATCH' && reject ? { status: 429,
    headers: { 'retry-after': '2', etag: '"raw"' }, bodyBytes: bytes({ message: 'rate limited' }) } : undefined });
  await verified(h); const result = await send(h); assert.equal(result.status, 429); assert.equal(result.safeHeaders['retry-after'], '2');
  assert.equal(h.relay.safeReport().phase, 'owned'); assert.equal(h.events.length, 1);
  reject = false; assert.equal((await send(h)).ok, false); assert.equal(h.calls.length, 2);
  h.state.clock += 2000; assert.equal((await send(h)).ok, true);
});

test('duplicate header aliases, header injection and invalid response bytes fail closed', async () => {
  for (const response of [ { status: 409, headers: { ETag: 'a', etag: 'b' }, bodyBytes: bytes({}) },
    { status: 409, headers: { etag: 'a\r\nb' }, bodyBytes: bytes({}) },
    { status: 200, headers: {}, bodyBytes: Buffer.from([0xc0, 0xaf]) } ]) {
    const h = harness({ transport: request => request.method === 'PATCH' ? response : undefined }); await verified(h);
    assert.equal((await send(h)).ok, false); assert.equal(h.relay.safeReport().phase, 'review_required');
  }
});

test('abort after dispatch is unknown and an ignored abort cannot overlap the next transport', async () => {
  const held = deferred(), controller = new AbortController(); let observed;
  const h = harness({ transport: request => { if (request.method === 'PATCH') { observed = request.signal; return held.promise; } } });
  await verified(h); const pending = send(h, patch(h), 'A', { signal: controller.signal }); await turn(); controller.abort();
  assert.equal((await pending).ok, false); assert.equal(observed.aborted, true); assert.equal(h.relay.safeReport().phase, 'review_required');
  assert.equal((await read(h)).ok, false); assert.equal(h.calls.length, 2); assert.equal(h.state.maxActive, 1);
  held.resolve({ status: 200, headers: {}, bodyBytes: bytes(h.state.gist) }); await turn();
  assert.equal((await read(h)).ok, true); assert.equal((await send(h)).ok, false);
  assert.equal(h.state.maxActive, 1); assert.equal(h.relay.safeReport().phase, 'review_required');
});

test('offline after PATCH dispatch aborts it, stays read-only and never replays on reconnect', async () => {
  const held = deferred(); let signal;
  const h = harness({ transport: request => { if (request.method === 'PATCH') { signal = request.signal; return held.promise; } } });
  await verified(h); const pending = send(h); await turn(); h.relay.setActorOffline('A', true);
  assert.equal((await pending).ok, false); assert.equal(signal.aborted, true);
  h.relay.setActorOffline('A', false); held.resolve({ status: 200, headers: {}, bodyBytes: bytes(h.state.gist) }); await turn();
  assert.equal((await read(h)).ok, true); assert.equal((await send(h)).ok, false); assert.equal(h.calls.filter(value => value.method === 'PATCH').length, 1);
});

test('timeout is bounded; a late successful transport cannot clear unknown write state', async () => {
  const held = deferred(); let signal;
  const h = harness({ timeoutMs: 10, transport: request => { if (request.method === 'PATCH') { signal = request.signal; return held.promise; } } });
  await verified(h); assert.equal((await send(h)).ok, false); assert.equal(signal.aborted, true);
  assert.equal(h.relay.safeReport().phase, 'review_required'); assert.equal((await read(h)).ok, false);
  held.resolve({ status: 200, headers: {}, bodyBytes: bytes(h.state.gist) }); await turn();
  assert.equal((await read(h)).ok, true); assert.equal((await send(h)).ok, false); assert.equal(h.relay.safeReport().phase, 'review_required');
});

test('unknown-write journal failure cannot reopen mutation or leak callback exceptions', async () => {
  const h = harness({ append: event => { if (event.event === 'mutation_unknown') throw new Error(PRIVATE); return true; },
    transport: request => { if (request.method === 'PATCH') throw new Error(PRIVATE); } });
  await verified(h); const result = await send(h); assert.equal(result.ok, false);
  assert.equal((await send(h)).ok, false); assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test('safe reports and journals expose only fixed metadata/counters/hashes, never content or headers', async () => {
  const h = harness(); await verified(h); await send(h); const report = h.relay.safeReport();
  assert.deepEqual(Object.keys(report).sort(), ['legacySha256', 'mutations', 'ownedIdHash', 'ownershipVerified', 'phase', 'requests']);
  assert.doesNotMatch(JSON.stringify(report), /summersin77|Synthetic|https:|Authorization|description|files|content|token/i);
  assert.doesNotMatch(JSON.stringify(h.events), /shares|fundName|description|headers|summersin77/);
  assert.equal(Object.isFrozen(report), true);
});

test('malformed public controls fail with fixed results rather than throwing coercion/getter errors', async () => {
  const h = harness(), evil = { [Symbol.toPrimitive]() { throw new Error(PRIVATE); } };
  for (const value of [null, 1, PRIVATE, { get signal() { throw new Error(PRIVATE); } }]) {
    const result = await h.relay.verifyOwned(value); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  }
  for (const actor of [null, evil, Symbol('actor')]) {
    assert.equal(h.relay.setActorOffline(actor, true).ok, false);
    assert.equal((await read(h, actor)).ok, false);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.events.length, 0);
});

test('context is rechecked after the unknown-write journal await before returning a response', async () => {
  let h;
  h = harness({ append: event => { if (event.event === 'mutation_unknown') h.relay.setActorOffline('A', true); return true; },
    transport: request => request.method === 'PATCH' ? { status: 503, headers: {}, bodyBytes: bytes({ message: 'synthetic' }) } : undefined });
  await verified(h); const result = await send(h); assert.equal(result.ok, false);
  assert.equal(h.relay.safeReport().phase, 'review_required');
  h.relay.setActorOffline('A', false); assert.equal((await read(h)).ok, true); assert.equal((await send(h)).ok, false);
});

test('a response byte buffer cannot be changed through its transport alias after return', async () => {
  let original;
  const h = harness({ transport: (request, state) => {
    if (request.actor === 'A') { original = bytes(state.gist); return { status: 200, headers: {}, bodyBytes: original }; }
  } });
  await verified(h); const result = await read(h), expected = Buffer.from(original);
  original.fill(0); assert.deepEqual(result.bodyBytes, expected);
});

test('abort of a read is not a write-unknown event and drains before fresh use', async () => {
  const held = deferred(), controller = new AbortController(); let hold = true;
  const h = harness({ transport: request => request.actor === 'A' && hold ? held.promise : undefined });
  await verified(h); const pending = read(h, 'A', { signal: controller.signal }); await turn(); controller.abort();
  assert.equal((await pending).ok, false); assert.equal(h.relay.safeReport().phase, 'owned'); assert.equal(h.events.length, 0);
  assert.equal((await send(h)).ok, false); assert.equal(h.calls.length, 2);
  hold = false; held.resolve({ status: 200, headers: {}, bodyBytes: bytes(h.state.gist) }); await turn();
  assert.equal((await send(h)).ok, true); assert.equal(h.state.maxActive, 1);
});

test('method getters cannot change an admitted GET into a DELETE without the journal gate', async () => {
  const h = harness(); await verified(h); let count = 0;
  const result = await h.relay.relayOwned({ actor: 'A', exactPath: path,
    get method() { count += 1; return count < 3 ? 'GET' : 'DELETE'; } });
  assert.equal(result.ok, true); assert.deepEqual(h.calls.map(value => value.method), ['GET', 'GET']);
  assert.equal(h.events.length, 0);
});

test('secondary 403 Retry-After is enforced even without remaining=0', async () => {
  let reject = true;
  const h = harness({ transport: request => request.method === 'PATCH' && reject ? { status: 403,
    headers: { 'retry-after': '3' }, bodyBytes: bytes({ message: 'secondary rate limit' }) } : undefined });
  await verified(h); assert.equal((await send(h)).status, 403); reject = false;
  h.state.clock += 1000; assert.equal((await send(h)).ok, false); assert.equal(h.calls.length, 2);
  h.state.clock += 2000; assert.equal((await send(h)).ok, true);
});

test('transport response fields are snapshotted once before validation', async () => {
  const h = harness({ transport: (request, state) => {
    if (request.method !== 'PATCH') return undefined;
    let count = 0;
    return { get status() { count += 1; return count < 5 ? 200 : 503; }, headers: {}, bodyBytes: bytes(state.gist) };
  } });
  await verified(h); const result = await send(h);
  assert.equal(result.status, 200); assert.equal(h.relay.safeReport().phase, 'owned');
});

for (const field of ['etag', 'status']) test(`independent RED: ${field} response getter epoch loss after dispatch permanently locks writes`, async () => {
  let h, first = true;
  h = harness({ transport: (request, state) => {
    if (request.method !== 'PATCH' || !first) return undefined;
    first = false;
    const response = { status: 200, headers: {}, bodyBytes: bytes(state.gist) };
    const target = field === 'etag' ? response.headers : response;
    Object.defineProperty(target, field, { enumerable: true, get() {
      h.relay.setActorOffline('A', true); return field === 'etag' ? '"synthetic"' : 200;
    } });
    return response;
  } });
  await verified(h); assert.equal((await send(h)).ok, false);
  assert.equal(h.relay.safeReport().phase, 'review_required');
  assert.equal(h.events.at(-1).event, 'mutation_unknown');
  h.relay.setActorOffline('A', false); assert.equal((await send(h)).ok, false);
  assert.equal(h.calls.filter(value => value.method === 'PATCH').length, 1);
});

test('independent RED: a nonprimitive binding id never reaches coercion or transport', async () => {
  const base = harness(); let conversions = 0;
  const ownedId = { toString() { conversions += 1; return conversions === 1 ? ID : '../../user'; } };
  const h = harness({ binding: { ...base.binding, ownedId } });
  assert.equal((await h.relay.verifyOwned()).ok, false);
  assert.equal(h.calls.length, 0); assert.equal(conversions, 0);
});

test('independent RED: final clock callback going offline prevents dispatch and unknown-write accounting', async () => {
  let h, clocks = 0;
  h = harness({ now() { clocks += 1; if (clocks === 3) h.relay.setActorOffline('A', true); return 1000; } });
  await verified(h); assert.equal((await send(h)).ok, false);
  assert.equal(h.calls.filter(value => value.method === 'PATCH').length, 0);
  assert.equal(h.relay.safeReport().mutations, 0);
  assert.equal(h.events.some(value => value.event === 'mutation_unknown'), false);
});

test('independent RED: journal method replacement cannot replace the original durable acknowledgement', async () => {
  const h = harness(); await verified(h); h.journal.append = () => true;
  assert.equal((await send(h)).ok, false); assert.equal(h.calls.length, 1);
  assert.equal(h.relay.safeReport().mutations, 0); assert.equal(h.events.length, 0);
});

test('independent RED: Buffer byteLength shadow cannot bypass the actual request byte cap', async () => {
  const h = harness(); await verified(h);
  const raw = Buffer.concat([Buffer.alloc(270000, 32), bytes(patch(h))]);
  Object.defineProperty(raw, 'byteLength', { value: 1 });
  assert.equal((await send(h, patch(h), 'A', { bodyBytes: raw })).ok, false);
  assert.equal(h.relay.safeReport().mutations, 0); assert.equal(h.calls.length, 1);
});
