import test from 'node:test';
import assert from 'node:assert/strict';
import * as gist from '../js/storage/gist-remote.js';

const NOW = Date.parse('2026-10-25T08:00:00.000Z');
const ID = '0000000000000000000000000000000a';
const SECRET = 'synthetic-token-not-for-network';
function response(status, values = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: key => values[key.toLowerCase()] ?? null },
    async json() { throw new Error(`${SECRET}:private-body`); },
  };
}
function classify(value, options = {}) {
  assert.equal(typeof gist.classifyGistHttpFailure, 'function');
  return gist.classifyGistHttpFailure(value, { phase: 'get', now: NOW, ...options });
}
function safe(dto) {
  assert.deepEqual(Object.keys(dto).sort(), ['code', 'phase', 'reason', 'retryAfterMs', 'retryable', 'status']);
  assert.equal(dto.reason, `gist_${dto.code}`);
  assert.equal(typeof dto.retryable, 'boolean');
  assert.ok(Number.isFinite(dto.retryAfterMs) && dto.retryAfterMs >= 0 && dto.retryAfterMs <= 86400000);
  assert.doesNotMatch(JSON.stringify(dto), /synthetic-token|private-body|https:|Authorization/);
  return dto;
}
for (const [status, code, retryable] of [
  [401, 'auth', false], [403, 'permission', false], [404, 'missing', false],
  [409, 'conflict', false], [429, 'rate_limit', true], [500, 'unavailable', true],
  [502, 'unavailable', true], [503, 'unavailable', true], [422, 'invalid_request', false],
]) {
  test(`HTTP ${status} has a fixed safe ${code} classification`, () => {
    const dto = safe(classify(response(status)));
    assert.equal(dto.status, status);
    assert.equal(dto.code, code);
    assert.equal(dto.retryable, retryable);
    assert.equal(dto.retryAfterMs, status === 429 ? 60000 : 0);
  });
}
test('403 primary and secondary rate limits are not permission failures', () => {
  assert.equal(classify(response(403, { 'x-ratelimit-remaining': '0' })).code, 'rate_limit');
  assert.equal(classify(response(403, { 'retry-after': '120' })).retryAfterMs, 120000);
  assert.equal(classify(response(403, { 'retry-after': 'malformed' })).code, 'rate_limit');
});
test('Retry-After supports seconds and strict HTTP dates with a one-minute rate floor', () => {
  assert.equal(classify(response(429, { 'retry-after': '0' })).retryAfterMs, 60000);
  assert.equal(classify(response(429, { 'retry-after': 'Sun, 25 Oct 2026 08:02:00 GMT' })).retryAfterMs, 120000);
  assert.equal(classify(response(503, { 'retry-after': '15' })).retryAfterMs, 15000);
  assert.equal(classify(response(429, { 'retry-after': 'Sat, 24 Oct 2026 08:02:00 GMT' })).retryAfterMs, 60000);
});
test('UTC reset, Retry-After, huge and malformed values remain finite and bounded', () => {
  assert.equal(classify(response(403, {
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 180), 'retry-after': '90',
  })).retryAfterMs, 180000);
  for (const value of ['9'.repeat(80), '86401']) {
    assert.equal(safe(classify(response(429, { 'retry-after': value }))).retryAfterMs, 86400000);
  }
  for (const value of ['-1', '1.5', 'Infinity', 'NaN', SECRET, '2026-10-25', '1\r\nsecret']) {
    assert.equal(safe(classify(response(429, { 'retry-after': value }))).retryAfterMs, 60000);
  }
  assert.equal(classify(response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9'.repeat(80) })).retryAfterMs, 86400000);
});
test('invalid statuses, throwing header access and hostile options expose no original error', () => {
  for (const value of [null, {}, { status: '401' }, { status: NaN }, { status: 1000 }]) {
    assert.equal(safe(classify(value)).code, 'invalid_response');
  }
  const dto = safe(classify({ status: 429, headers: { get() { throw new Error(SECRET); } } }, {
    phase: SECRET, now: () => { throw new Error(SECRET); },
  }));
  assert.equal(dto.phase, 'get');
  assert.equal(dto.retryAfterMs, 60000);
});
test('throwing status access also becomes a fixed invalid-response failure', async () => {
  const hostile = { get status() { throw new Error(SECRET); } };
  assert.equal(safe(classify(hostile)).code, 'invalid_response');
  assert.equal((await adapter(async () => hostile).get()).failure.code, 'invalid_response');
  const write = await adapter(async () => hostile).patch({ schema: 3, content: '{}' });
  assert.equal(write.writeUnknown, true);
  assert.doesNotMatch(JSON.stringify(write), /synthetic-token/);
});
function adapter(request, overrides = {}) {
  return gist.createGistRemoteAdapter({ token: SECRET, gistId: ID, deviceId: 'synthetic:phone', request, now: () => new Date(NOW).toISOString(), ...overrides });
}
test('GET HTTP failure keeps legacy reason, adds safe failure, and never reads the body', async () => {
  const result = await adapter(async () => response(401)).get();
  assert.equal(result.reason, 'remote_http_401');
  assert.equal(safe(result.failure).code, 'auth');
});
test('PATCH explicit HTTP failure keeps legacy reason and is not an unknown write', async () => {
  let calls = 0;
  const result = await adapter(async () => { calls += 1; return response(429); }).patch({ schema: 3, content: '{}' });
  assert.equal(calls, 1);
  assert.equal(result.reason, 'remote_patch_http_429');
  assert.equal(result.writeUnknown, false);
  assert.equal(safe(result.failure).phase, 'patch');
});
test('PATCH server errors are unknown writes even when HTTP failure is explicit', async () => {
  for (const status of [500, 502, 503, 599]) {
    let calls = 0;
    const result = await adapter(async () => { calls += 1; return response(status); }).patch({ schema: 3, content: '{}' });
    assert.equal(calls, 1);
    assert.equal(result.reason, `remote_patch_http_${status}`);
    assert.equal(result.writeUnknown, true);
    assert.equal(result.failure.code, 'unavailable');
  }
});
test('transport failures are fixed safe codes and PATCH is unknown without replay', async () => {
  let calls = 0;
  const remote = adapter(async () => { calls += 1; throw new Error(`https://private.invalid/${SECRET}`); });
  const read = await remote.get();
  const write = await remote.patch({ schema: 3, content: '{}' });
  assert.equal(calls, 2);
  assert.equal(read.reason, 'remote_network');
  assert.equal(write.reason, 'remote_patch_network');
  assert.equal(write.writeUnknown, true);
  for (const item of [read, write]) assert.equal(safe(item.failure).code, 'network');
  assert.doesNotMatch(JSON.stringify([read, write]), /private\.invalid|synthetic-token/);
});
test('malformed response or JSON does not leak thrown body or headers', async () => {
  const read = await adapter(async () => response(200)).get();
  assert.equal(read.reason, 'remote_invalid_response');
  assert.equal(safe(read.failure).code, 'invalid_response');
  const write = await adapter(async () => null).patch({ schema: 3, content: '{}' });
  assert.equal(write.writeUnknown, true);
  assert.equal(safe(write.failure).code, 'invalid_response');
});
test('URL-like or non-hex identities and unsafe tokens never reach a request', async () => {
  let calls = 0;
  for (const gistId of ['https://evil.invalid/x', `${ID}?secret=x`, '../gists/x', 'test-gist', '', 'a'.repeat(65)]) {
    const remote = adapter(async () => { calls += 1; return response(200); }, { gistId });
    assert.equal((await remote.get()).failure.code, 'invalid_request');
    assert.equal((await remote.patch({ schema: 3, content: '{}' })).writeUnknown, false);
  }
  for (const token of ['', 'bad\r\nvalue', null]) {
    assert.equal((await adapter(async () => { calls += 1; return response(200); }, { token }).get()).failure.code, 'invalid_request');
  }
  assert.equal(calls, 0);
});
test('request target is the fixed GitHub path and credentials only occur in Authorization', async () => {
  let calls = 0;
  const remote = adapter(async (url, options) => {
    calls += 1;
    assert.equal(url, `https://api.github.com/gists/${ID}`);
    assert.equal(options.headers.Authorization, `token ${SECRET}`);
    assert.equal(options.redirect, 'error');
    assert.ok(!url.includes(SECRET));
    assert.ok(!String(options.body || '').includes(SECRET));
    return { ...response(200), async json() { return { files: { 'fuyu-holdings.json': { content: '{"schema":2,"holdings":[]}' } } }; } };
  });
  assert.equal((await remote.get()).ok, true);
  assert.equal((await remote.patch({ schema: 3, content: '{}' })).ok, true);
  assert.equal(calls, 2);
});
test('PATCH body validation fails before sending without claiming an unknown write', async () => {
  let calls = 0;
  const remote = adapter(async () => { calls += 1; return response(200); });
  for (const content of ['', ' ', null, {}, undefined]) {
    const result = await remote.patch({ schema: 3, content });
    assert.equal(result.failure.code, 'invalid_request');
    assert.equal(result.writeUnknown, false);
  }
  assert.equal(calls, 0);
});
