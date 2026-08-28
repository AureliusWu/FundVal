import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_GIST_FILENAME,
  MAX_V3_GIST_FILES,
  createGistRemoteAdapter,
  findExistingHoldingsGist,
  isV3GistFilename,
  v3GistFilename,
} from '../js/storage/gist-remote.js';
import { stableHoldingId } from '../js/storage/holdings-schema.js';

const T1 = '2026-08-20T00:00:00.000Z';
const T2 = '2026-08-21T00:00:00.000Z';

function holding(code, overrides = {}) {
  return {
    id: stableHoldingId(code),
    fundCode: code,
    fundName: `基金${code}`,
    shares: 10,
    costNav: 1,
    createdAt: T1,
    updatedAt: T1,
    deletedAt: null,
    revision: 1,
    deviceId: 'device:source',
    note: null,
    ...overrides,
  };
}

function v3(holdings, overrides = {}) {
  return {
    schema: 3,
    updatedAt: T1,
    deviceId: 'device:source',
    holdings,
    ...overrides,
  };
}

function schema2(holdings, overrides = {}) {
  return {
    schema: 2,
    updated_at: T1,
    device_id: 'legacy-device',
    holdings: holdings.map(item => ({
      code: item.fundCode,
      name: item.fundName,
      shares: item.shares,
      cost: item.costNav,
      updated_at: item.updatedAt,
      deleted: item.deletedAt != null,
    })),
    ...overrides,
  };
}

function response(body, { ok = true, status = 200, etag = '"revision-a"' } = {}) {
  return {
    ok,
    status,
    headers: { get: name => name.toLowerCase() === 'etag' ? etag : null },
    async json() { return body; },
  };
}

test('V3 filenames are stable per device without exposing the raw device id', () => {
  const first = v3GistFilename('device:phone-private-id');
  assert.equal(first, v3GistFilename('device:phone-private-id'));
  assert.notEqual(first, v3GistFilename('device:desktop-private-id'));
  assert.match(first, /^fuyu-holdings-v3-[a-f0-9]{16}\.json$/);
  assert.doesNotMatch(first, /phone|private|device/i);
  assert.equal(isV3GistFilename('fuyu-holdings-v3-backup.json'), false);
  assert.equal(isV3GistFilename('fuyu-holdings-v3-0123456789abcdef.json.bak'), false);
});

test('adapter reconciles all V3 files with newer legacy edits and preserves both raw files in backup', async () => {
  const deviceId = 'device:new';
  const existingFilename = v3GistFilename('device:old');
  const legacy = schema2([holding('000001', { shares: 12, updatedAt: T2 })], { updated_at: T2 });
  const files = {
    [existingFilename]: { content: JSON.stringify(v3([holding('000001')])) },
    [LEGACY_GIST_FILENAME]: { content: JSON.stringify(legacy) },
  };
  const adapter = createGistRemoteAdapter({
    token: 'test-token', gistId: 'test-gist', deviceId,
    request: async () => response({ files, updated_at: T2 }),
  });

  const result = await adapter.get();

  assert.equal(result.ok, true);
  assert.equal(result.requiresPatch, true);
  assert.equal(JSON.parse(result.raw).holdings[0].shares, 12);
  assert.deepEqual(Object.keys(result.backupRaw.files).sort(), [LEGACY_GIST_FILENAME, existingFilename].sort());
});

test('Schema 3 PATCH writes only the current device sidecar and never deletes or rewrites legacy', async () => {
  const deviceId = 'device:new';
  const requests = [];
  const adapter = createGistRemoteAdapter({
    token: 'test-token', gistId: 'test-gist', deviceId,
    now: () => T2,
    request: async (url, options) => {
      requests.push({ url, options });
      return response({});
    },
  });

  const result = await adapter.patch({
    schema: 3,
    content: JSON.stringify(v3([holding('000002')])),
    expectedVersion: '"revision-a"',
  });

  assert.equal(result.ok, true);
  assert.equal(result.filename, v3GistFilename(deviceId));
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(Object.keys(body.files), [v3GistFilename(deviceId)]);
  assert.equal(body.files[LEGACY_GIST_FILENAME], undefined);
  assert.equal(body.files[v3GistFilename(deviceId)].content.includes('000002'), true);
  assert.equal(requests[0].options.headers['If-Match'], undefined);
});

test('adapter refuses every Schema 2 PATCH without sending a request', async () => {
  let requests = 0;
  const adapter = createGistRemoteAdapter({
    token: 'test-token', gistId: 'test-gist', deviceId: 'device:new',
    request: async () => { requests += 1; return response({}); },
  });

  const result = await adapter.patch({ schema: 2, content: '{}' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'remote_schema_downgrade_blocked');
  assert.equal(requests, 0);
});

test('adapter fails closed on a truncated Gist or an excessive V3 shard set', async () => {
  const truncated = createGistRemoteAdapter({
    token: 'test-token', gistId: 'test-gist', deviceId: 'device:new',
    request: async () => response({ truncated: true, files: {} }),
  });
  assert.deepEqual(await truncated.get(), { ok: false, reason: 'remote_gist_truncated' });

  const files = Object.fromEntries(Array.from({ length: MAX_V3_GIST_FILES + 1 }, (_, index) => [
    `fuyu-holdings-v3-${index.toString(16).padStart(16, '0')}.json`,
    { content: JSON.stringify(v3([])) },
  ]));
  const excessive = createGistRemoteAdapter({
    token: 'test-token', gistId: 'test-gist', deviceId: 'device:new',
    request: async () => response({ truncated: false, files }),
  });
  assert.deepEqual(await excessive.get(), { ok: false, reason: 'remote_v3_file_limit_exceeded' });
});

test('Gist discovery prefers any V3 archive across pages before falling back to legacy', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index === 0 ? 'legacy-gist' : `other-${index}`,
    files: index === 0 ? { [LEGACY_GIST_FILENAME]: {} } : {},
  }));
  const request = async url => response(url.includes('page=2')
    ? [{ id: 'v3-gist', files: { [v3GistFilename('device:other')]: {} } }]
    : firstPage);

  const found = await findExistingHoldingsGist({ token: 'test-token', request });

  assert.equal(found, 'v3-gist');
});
