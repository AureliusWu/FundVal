import test from 'node:test';
import assert from 'node:assert/strict';
import * as gist from '../js/storage/gist-remote.js';

const A = '0000000000000000000000000000000a';
const B = '0000000000000000000000000000000b';
const TOKEN = 'synthetic-private-token';
const TIME = '2026-10-25T08:00:00Z';
const EMPTY_FAILURE = { ok: false, candidates: [], complete: false, reason: 'remote_discovery_incomplete', failure: {
  reason: 'gist_invalid_response', code: 'invalid_response', phase: 'discovery', status: null, retryable: false, retryAfterMs: 0,
} };
function item(id = A, filename = gist.V3_GIST_CANONICAL_FILENAME, extra = {}) {
  return { id, updated_at: TIME, description: TOKEN, html_url: `https://private.invalid/${TOKEN}`,
    owner: { login: TOKEN }, files: { [filename]: { raw_url: `https://private.invalid/${TOKEN}`, content: TOKEN } }, ...extra };
}
function mock(pages, links = []) {
  const calls = [];
  const request = async (url, options) => {
    const page = calls.length;
    calls.push(url);
    assert.equal(url, `https://api.github.com/gists?per_page=100&page=${page + 1}`);
    assert.equal(options.headers.Authorization, `token ${TOKEN}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    return { ok: true, status: 200, headers: { get: key => key.toLowerCase() === 'link' ? links[page] ?? null : null }, async json() { return pages[page]; } };
  };
  return { request, calls };
}
async function list(request, options = {}) {
  assert.equal(typeof gist.listHoldingsGists, 'function');
  return gist.listHoldingsGists({ token: TOKEN, request, ...options });
}
test('discovery exposes only stable id/schema/updatedAt for all compatible archives', async () => {
  const result = await list(mock([[item(A), item(B, gist.LEGACY_GIST_FILENAME)]]).request);
  assert.deepEqual(result, { ok: true, complete: true, candidates: [
    { id: A, schema: 3, updatedAt: '2026-10-25T08:00:00.000Z' },
    { id: B, schema: 2, updatedAt: '2026-10-25T08:00:00.000Z' },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|private\.invalid|description|content|owner|url/);
});
test('compatibility helper selects only one complete candidate and never implicitly chooses among two', async () => {
  for (const filename of [gist.LEGACY_GIST_FILENAME, gist.V3_GIST_CANONICAL_FILENAME]) {
    assert.equal(await gist.findExistingHoldingsGist({ token: TOKEN, request: mock([[item(A, filename)]]).request }), A);
  }
  assert.equal(await gist.findExistingHoldingsGist({ token: TOKEN, request: mock([[item(A), item(B)]]).request }), '');
});
test('pagination finishes before exposing a candidate; a full capped page is incomplete', async () => {
  const full = [item(A), ...Array.from({ length: 99 }, (_, index) => item((index + 100).toString(16), 'unrelated.json'))];
  const complete = mock([full, [item(B)]]);
  assert.equal((await list(complete.request)).candidates.length, 2);
  assert.equal(complete.calls.length, 2);
  assert.deepEqual(await list(mock([full]).request, { maxPages: 1 }), EMPTY_FAILURE);
  assert.equal(await gist.findExistingHoldingsGist({ token: TOKEN, request: mock([full]).request, maxPages: 1 }), '');
});
test('Link pagination never follows an arbitrary host, query, path or skipped page', async () => {
  for (const target of ['https://evil.invalid/gists?per_page=100&page=2', 'https://api.github.com/user?per_page=100&page=2', 'https://api.github.com/gists?per_page=100&page=3', 'https://api.github.com/gists?per_page=100&page=2&token=secret']) {
    assert.deepEqual(await list(mock([[item(A)]], [`<${target}>; rel="next"`]).request), EMPTY_FAILURE);
  }
  const valid = mock([[item(A)], [item(B)]], ['<https://api.github.com/gists?per_page=100&page=2>; rel="next"']);
  assert.equal((await list(valid.request)).candidates.length, 2);
  assert.equal(valid.calls.length, 2);
});
test('malformed response arrays/counts, identities, dates and duplicate IDs fail closed', async () => {
  for (const body of [{}, null, 'secret', Array.from({ length: 101 }, () => item(A)), [item('https://evil.invalid/x')], [item('not-hex')], [item(A), item(A)], [item(A, undefined, { updated_at: '2026-02-30T00:00:00Z' })], [item(A, undefined, { files: [] })]]) {
    assert.deepEqual(await list(mock([body]).request), EMPTY_FAILURE);
  }
});
test('truncated Gists/relevant files and >64 V3 files cannot enter candidate selection', async () => {
  const excessive = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [gist.v3GistFilename(`synthetic:${index}`), {}]));
  for (const archive of [item(A, undefined, { truncated: true }), item(A, undefined, { files: { [gist.V3_GIST_CANONICAL_FILENAME]: { truncated: true } } }), item(A, undefined, { files: excessive })]) {
    assert.deepEqual(await list(mock([[archive]]).request), EMPTY_FAILURE);
  }
});
test('exactly 64 V3 files is valid and never requires downloading file content', async () => {
  const files = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [gist.v3GistFilename(`synthetic:${index}`), {}]));
  assert.deepEqual((await list(mock([[item(A, undefined, { files })]]).request)).candidates, [
    { id: A, schema: 3, updatedAt: '2026-10-25T08:00:00.000Z' },
  ]);
});
test('a trustworthy terminal Link can complete a full page, but repeated IDs across pages fail', async () => {
  const full = [item(A), ...Array.from({ length: 99 }, (_, index) => item((index + 100).toString(16), 'unrelated.json'))];
  const terminal = mock([full], ['<https://api.github.com/gists?per_page=100&page=1>; rel="last"']);
  assert.equal((await list(terminal.request, { maxPages: 1 })).complete, true);
  assert.deepEqual(await list(mock([full, [item(A)]]).request), EMPTY_FAILURE);
});
test('inconsistent first/prev/last pagination relations cannot falsely prove completeness', async () => {
  for (const link of [
    '<https://api.github.com/gists?per_page=100&page=2>; rel="last"',
    '<https://api.github.com/gists?per_page=100&page=2>; rel="first"',
    '<https://api.github.com/gists?per_page=100&page=1>; rel="prev"',
    '<https://api.github.com/gists?per_page=100&page=2>; rel="next", <https://api.github.com/gists?per_page=100&page=1>; rel="last"',
  ]) assert.deepEqual(await list(mock([[item(A)]], [link]).request), EMPTY_FAILURE);
});
test('unknown dates remain null; unrelated files do not become candidates', async () => {
  const result = await list(mock([[item(A, undefined, { updated_at: undefined }), item(B, 'other.json')]]).request);
  assert.deepEqual(result.candidates, [{ id: A, schema: 3, updatedAt: null }]);
});
test('HTTP, JSON, transport and invalid arguments return only the fixed failure DTO', async () => {
  assert.deepEqual(await list(async () => ({ ok: true, status: 200, async json() { throw new Error(TOKEN); } })), EMPTY_FAILURE);
  const network = await list(async () => { throw new Error(TOKEN); });
  assert.equal(network.reason, 'remote_network');
  assert.equal(network.failure.code, 'network');
  assert.equal(network.failure.phase, 'discovery');
  assert.equal(network.failure.retryable, true);
  const unauthorized = await list(async () => ({ ok: false, status: 401 }));
  assert.equal(unauthorized.reason, 'remote_http_401');
  assert.equal(unauthorized.failure.code, 'auth');
  assert.equal(unauthorized.failure.phase, 'discovery');
  assert.doesNotMatch(JSON.stringify([network, unauthorized]), /synthetic-private|private\.invalid|Authorization/);
  let calls = 0;
  const request = async () => { calls += 1; return null; };
  for (const maxPages of [0, -1, NaN, Infinity, 1.5, 6, '5']) assert.deepEqual(await list(request, { maxPages }), EMPTY_FAILURE);
  assert.deepEqual(await list(request, { token: '' }), EMPTY_FAILURE);
  assert.deepEqual(await list(request, { token: 'bad\r\nvalue' }), EMPTY_FAILURE);
  assert.deepEqual(await list(null), EMPTY_FAILURE);
  assert.equal(calls, 0);
});
test('discovery preserves rate limit classification and bounded Retry-After without exposing headers', async () => {
  const result = await list(async () => ({ ok: false, status: 429, headers: { get: key => key === 'retry-after' ? '120' : null } }));
  assert.deepEqual(result, { ok: false, candidates: [], complete: false, reason: 'remote_http_429', failure: {
    reason: 'gist_rate_limit', code: 'rate_limit', phase: 'discovery', status: 429, retryable: true, retryAfterMs: 120000,
  } });
});
