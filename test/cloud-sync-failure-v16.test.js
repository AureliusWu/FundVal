import test from 'node:test';
import assert from 'node:assert/strict';
import { pullHoldingsCloud, synchronizeHoldingsCloud } from '../js/storage/cloud-sync.js';
import { normalizeHoldingsDocumentV3 } from '../js/storage/holdings-schema.js';

const snapshot = normalizeHoldingsDocumentV3({
  schema: 3, deviceId: 'device:synthetic-m4', updatedAt: '2026-10-25T00:00:00.000Z', holdings: [],
});
function adapters(remoteOverrides = {}) {
  return {
    deviceId: snapshot.deviceId,
    remote: { get: async () => ({ ok: true, raw: snapshot }), patch: async () => ({ ok: true }), ...remoteOverrides },
    local: {
      load: async () => ({ ok: true, document: snapshot }),
      backup: async () => ({ ok: true }), persist: async () => ({ ok: true }),
      markPending: async pending => ({ ok: true, pending }),
    },
  };
}
const limited = Object.freeze({ code: 'rate_limit', status: 429, retryable: true, retryAfterMs: 65000 });

for (const [label, run] of [['push', synchronizeHoldingsCloud], ['pull', pullHoldingsCloud]]) {
  test(`M4 ${label} preserves only safe HTTP policy from initial read`, async () => {
    const result = await run(adapters({ get: async () => ({
      ok: false, reason: 'remote_http_429', failure: { ...limited, token: 'synthetic-private-marker', raw: 'private user content' },
    }) }));
    assert.equal(result.reason, 'remote_http_429');
    assert.deepEqual(result.failure, limited);
    assert.equal(JSON.stringify(result).includes('synthetic-private-marker'), false);
    assert.equal(JSON.stringify(result).includes('private user content'), false);
    assert.equal(result.pending, true);
  });
}

test('M4 failed PATCH preserves unknown-write status without acknowledging or replaying it', async () => {
  let writes = 0;
  const result = await synchronizeHoldingsCloud(adapters({ patch: async () => {
    writes++;
    return { ok: false, reason: 'remote_patch_failed', writeUnknown: true,
      failure: { code: 'network', status: null, retryable: true, retryAfterMs: 0 } };
  } }));
  assert.equal(writes, 1);
  assert.equal(result.writeUnknown, true);
  assert.equal(result.patchAcknowledged, false);
  assert.equal(result.remoteVerified, false);
  assert.equal(result.failure.code, 'network');
});

test('M4 readback failure retains rate policy and acknowledged-but-unverified boundary', async () => {
  let reads = 0;
  const result = await synchronizeHoldingsCloud(adapters({ get: async () => ++reads === 1
    ? { ok: true, raw: snapshot }
    : { ok: false, reason: 'remote_http_429', failure: limited } }));
  assert.equal(result.patched, true);
  assert.equal(result.patchAcknowledged, true);
  assert.equal(result.remoteVerified, false);
  assert.deepEqual(result.failure, limited);
});

test('M4 unknown remote policy fields cannot become diagnostics or retry deadlines', async () => {
  for (const bad of [
    { code: 'synthetic-private-marker', status: 429, retryable: true, retryAfterMs: 1 },
    { ...limited, retryAfterMs: Infinity }, { ...limited, retryAfterMs: -1 },
    { ...limited, retryAfterMs: 86400001 }, { ...limited, status: '429' },
  ]) {
    const result = await pullHoldingsCloud(adapters({ get: async () => ({ ok: false, reason: 'remote_read_failed', failure: bad }) }));
    assert.equal(result.failure, undefined);
  }
});
