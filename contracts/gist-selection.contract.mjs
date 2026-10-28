import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_GIST_FILENAME,
  V3_GIST_CANONICAL_FILENAME,
  findExistingHoldingsGist,
  listHoldingsGists,
} from '../js/storage/gist-remote.js';
import { createSyncStatus } from '../js/runtime/sync-status.js';

// M1's seven safety scenarios, now included by the automatic M4 test wrapper.
// M4 exposes a result DTO (no description/user content) and the controller owns
// explicit selection; it does not attach private candidates to thrown errors.
// The original RED contract remains in Git history. No live Gist access.
const SYNTHETIC_TOKEN = 'synthetic-no-auth';
const ARCHIVE_A = '0000000000000000000000000000000a';
const ARCHIVE_B = '0000000000000000000000000000000b';
const PRIVATE_CONTENT_SENTINEL = 'synthetic-content-must-not-enter-selection';
const SYNTHETIC_RAW_URL = 'https://invalid.example/synthetic-private-raw';

function archive(id, description, filename = V3_GIST_CANONICAL_FILENAME) {
  return {
    id,
    description,
    public: false,
    owner: { login: 'synthetic-only-owner' },
    files: {
      [filename]: {
        filename,
        content: PRIVATE_CONTENT_SENTINEL,
        raw_url: SYNTHETIC_RAW_URL,
      },
    },
  };
}

function mockDiscovery(pages) {
  const calls = [];
  const request = async (value, options = {}) => {
    const url = new URL(value);
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname, '/gists');
    assert.equal(url.searchParams.get('per_page'), '100');
    assert.equal(options.method || 'GET', 'GET', 'discovery must not write');
    assert.equal(options.body, undefined);
    const page = Number(url.searchParams.get('page'));
    assert.ok(Number.isInteger(page) && page >= 1 && page <= pages.length);
    calls.push({ page, method: 'GET' });
    return { ok: true, status: 200, async json() { return structuredClone(pages[page - 1]); } };
  };
  return { request, calls };
}

function assertSafeCandidates(result, expected) {
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.ok(Array.isArray(result.candidates));
  assert.equal(result.candidates.length, expected.length);
  for (const candidate of result.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['id', 'schema', 'updatedAt']);
    assert.equal(typeof candidate.id, 'string');
    assert.equal(candidate.schema, 3);
    assert.equal(candidate.updatedAt, null);
  }
  assert.deepEqual(
    result.candidates.map(item => item.id).sort(), [...expected].sort(),
  );
  const selectionJson = JSON.stringify(result.candidates);
  assert.ok(!selectionJson.includes(PRIVATE_CONTENT_SENTINEL));
  assert.ok(!selectionJson.includes(SYNTHETIC_RAW_URL));
  assert.ok(!selectionJson.includes('synthetic-only-owner'));
  assert.ok(!selectionJson.includes(SYNTHETIC_TOKEN));
  return true;
}

test('a single compatible V3 archive remains selectable without extra confirmation', async () => {
  const mock = mockDiscovery([[archive(ARCHIVE_A, '合成档案甲')]]);
  assert.equal(await findExistingHoldingsGist({ token: SYNTHETIC_TOKEN, request: mock.request }), ARCHIVE_A);
  assert.deepEqual(mock.calls, [{ page: 1, method: 'GET' }]);
});

test('a single legacy archive retains the existing fallback', async () => {
  const mock = mockDiscovery([[archive(ARCHIVE_A, '合成旧档案', LEGACY_GIST_FILENAME)]]);
  assert.equal(await findExistingHoldingsGist({ token: SYNTHETIC_TOKEN, request: mock.request }), ARCHIVE_A);
});

test('no compatible archive still returns an empty identity without writing', async () => {
  const mock = mockDiscovery([[{ id: ARCHIVE_A, description: '无关合成档案', files: { 'unrelated.json': {} } }]]);
  assert.equal(await findExistingHoldingsGist({ token: SYNTHETIC_TOKEN, request: mock.request }), '');
});

test('multiple compatible V3 archives require a choice instead of silently selecting the first', async () => {
  const mock = mockDiscovery([[
    archive(ARCHIVE_A, '合成档案甲'),
    archive(ARCHIVE_B, '合成档案乙'),
  ]]);
  const result = await listHoldingsGists({ token: SYNTHETIC_TOKEN, request: mock.request });
  assertSafeCandidates(result, [ARCHIVE_A, ARCHIVE_B]);
  const refused = await findExistingHoldingsGist({ token: SYNTHETIC_TOKEN, request: mock.request });
  assert.equal(refused, '');
});

test('archive discovery must finish pagination before deciding that a V3 archive is unique', async () => {
  const firstPage = [archive(ARCHIVE_A, '合成档案甲'), ...Array.from({ length: 99 }, (_, index) => ({
    id: (1000 + index).toString(16).padStart(32, '0'), description: '无关合成档案', files: {},
  }))];
  const mock = mockDiscovery([firstPage, [archive(ARCHIVE_B, '合成档案乙')]]);
  assertSafeCandidates(await listHoldingsGists({ token: SYNTHETIC_TOKEN, request: mock.request }), [ARCHIVE_A, ARCHIVE_B]);
  assert.deepEqual(mock.calls, [{ page: 1, method: 'GET' }, { page: 2, method: 'GET' }]);
});

test('an explicit choice of the second compatible archive overrides list ordering', async () => {
  const mock = mockDiscovery([[archive(ARCHIVE_A, '合成档案甲'), archive(ARCHIVE_B, '合成档案乙')]]);
  const controller = createSyncStatus({ getGistToken: () => SYNTHETIC_TOKEN,
    getGistId: () => ARCHIVE_B, listGists: () => { throw new Error('explicit selection must not rediscover'); } });
  assert.equal(await controller.resolveGistId(SYNTHETIC_TOKEN), ARCHIVE_B);
  assert.equal(mock.calls.length, 0);
});

test('an explicit choice of the first compatible archive stays backwards compatible', async () => {
  const mock = mockDiscovery([[archive(ARCHIVE_A, '合成档案甲'), archive(ARCHIVE_B, '合成档案乙')]]);
  const controller = createSyncStatus({ getGistToken: () => SYNTHETIC_TOKEN,
    getGistId: () => ARCHIVE_A, listGists: () => { throw new Error('explicit selection must not rediscover'); } });
  assert.equal(await controller.resolveGistId(SYNTHETIC_TOKEN), ARCHIVE_A);
  assert.equal(mock.calls.length, 0);
});
