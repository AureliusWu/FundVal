import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_GIST_FILENAME,
  V3_GIST_CANONICAL_FILENAME,
  findExistingHoldingsGist,
} from '../js/storage/gist-remote.js';

// M1 explicit red contract. Run directly until M4 implements archive selection;
// then move these cases into the automatic Node test suite. No live Gist access.
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

function assertSafeSelectionError(error, expected) {
  assert.equal(error.code, 'gist_selection_required');
  assert.ok(Array.isArray(error.candidates));
  assert.equal(error.candidates.length, expected.length);
  for (const candidate of error.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['description', 'id']);
    assert.equal(typeof candidate.id, 'string');
    assert.equal(typeof candidate.description, 'string');
    assert.ok(candidate.description.length <= 160);
    assert.doesNotMatch(candidate.description, /[\u0000-\u001f\u007f]/);
  }
  assert.deepEqual(
    [...error.candidates].sort((left, right) => left.id.localeCompare(right.id)),
    [...expected].sort((left, right) => left.id.localeCompare(right.id)),
  );
  const selectionJson = JSON.stringify(error.candidates);
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
  await assert.rejects(
    findExistingHoldingsGist({ token: SYNTHETIC_TOKEN, request: mock.request }),
    error => assertSafeSelectionError(error, [
      { id: ARCHIVE_A, description: '合成档案甲' },
      { id: ARCHIVE_B, description: '合成档案乙' },
    ]),
  );
});

test('archive discovery must finish pagination before deciding that a V3 archive is unique', async () => {
  const firstPage = [archive(ARCHIVE_A, '合成档案甲'), ...Array.from({ length: 99 }, (_, index) => ({
    id: `unrelated-${index}`, description: '无关合成档案', files: {},
  }))];
  const mock = mockDiscovery([firstPage, [archive(ARCHIVE_B, '合成档案乙')]]);
  await assert.rejects(
    findExistingHoldingsGist({ token: SYNTHETIC_TOKEN, request: mock.request }),
    error => assertSafeSelectionError(error, [
      { id: ARCHIVE_A, description: '合成档案甲' },
      { id: ARCHIVE_B, description: '合成档案乙' },
    ]),
  );
  assert.deepEqual(mock.calls, [{ page: 1, method: 'GET' }, { page: 2, method: 'GET' }]);
});

test('an explicit choice of the second compatible archive overrides list ordering', async () => {
  const mock = mockDiscovery([[archive(ARCHIVE_A, '合成档案甲'), archive(ARCHIVE_B, '合成档案乙')]]);
  assert.equal(await findExistingHoldingsGist({
    token: SYNTHETIC_TOKEN,
    request: mock.request,
    selectedGistId: ARCHIVE_B,
  }), ARCHIVE_B);
});

test('an explicit choice of the first compatible archive stays backwards compatible', async () => {
  const mock = mockDiscovery([[archive(ARCHIVE_A, '合成档案甲'), archive(ARCHIVE_B, '合成档案乙')]]);
  assert.equal(await findExistingHoldingsGist({
    token: SYNTHETIC_TOKEN,
    request: mock.request,
    selectedGistId: ARCHIVE_A,
  }), ARCHIVE_A);
});
