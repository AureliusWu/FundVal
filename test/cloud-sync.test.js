import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalCloudPayload,
  finalizeCreatedArchiveState,
  finalizeCloudSyncMetadata,
  makeCloudWritePayload,
  pullHoldingsCloud,
  reconcileCloudBridgePayload,
  requiresSchema3CloudUpgrade,
  synchronizeHoldingsCloud,
} from '../js/storage/cloud-sync.js';
import {
  canonicalHoldingsDocument,
  normalizeHoldingsDocumentV3,
  stableHoldingId,
} from '../js/storage/holdings-schema.js';

const T0 = '2026-08-20T00:00:00.000Z';
const T1 = '2026-08-21T00:00:00.000Z';
const T2 = '2026-08-22T00:00:00.000Z';

function holding(code, overrides = {}) {
  return {
    id: stableHoldingId(code),
    fundCode: code,
    fundName: '基金' + code,
    shares: 10,
    costNav: null,
    createdAt: T0,
    updatedAt: T1,
    deletedAt: null,
    revision: 1,
    deviceId: 'device:phone',
    note: null,
    ...overrides,
  };
}

function documentOf(holdings = [], overrides = {}) {
  const latest = holdings.reduce((value, item) => item.updatedAt > value ? item.updatedAt : value, T1);
  return normalizeHoldingsDocumentV3({
    schema: 3,
    updatedAt: latest,
    deviceId: 'device:phone',
    holdings,
    ...overrides,
  });
}

function schema2(holdings = []) {
  return {
    schema: 2,
    updated_at: T1,
    device_id: 'legacy-phone',
    holdings: holdings.map(item => ({
      code: item.fundCode,
      name: item.fundName,
      shares: item.shares,
      cost: item.costNav,
      updated_at: item.updatedAt,
      deleted: item.deletedAt != null,
    })),
  };
}

function fakeLocal(initial, options = {}) {
  const state = {
    document: initial,
    backups: [],
    persists: [],
    pending: [],
    loads: [],
  };
  return {
    state,
    async load({ phase } = {}) {
      state.loads.push(phase || 'unknown');
      if (options.loadFailureAt === phase) return { ok: false, reason: 'injected_load_failure' };
      return { ok: true, document: state.document };
    },
    async backup(snapshot) {
      state.backups.push(snapshot);
      if (options.backupFails) return { ok: false, reason: 'backup_failed' };
      return { ok: true, verified: true };
    },
    async persist(next, { phase } = {}) {
      state.persists.push({ phase, document: next });
      if (options.persistFails) return { ok: false, reason: 'local_persist_failed' };
      if (!options.ignorePersists) state.document = next;
      return { ok: true, document: state.document };
    },
    async markPending(pending) {
      state.pending.push(pending);
      return { ok: true };
    },
  };
}

function fakeRemote(initial, options = {}) {
  const state = {
    raw: initial,
    gets: [],
    patches: [],
  };
  return {
    state,
    async get({ phase } = {}) {
      state.gets.push(phase || 'unknown');
      if (options.getFailsAt === phase) return { ok: false, reason: 'remote_get_failed' };
      if (phase === 'readback' && Object.prototype.hasOwnProperty.call(options, 'readback')) {
        return { ok: true, raw: options.readback, version: 'readback-version' };
      }
      return { ok: true, raw: state.raw, version: phase === 'initial' ? 'etag-1' : 'etag-2' };
    },
    async patch(write) {
      state.patches.push(write);
      if (options.patchFails) return { ok: false, reason: 'remote_patch_failed' };
      state.raw = write.payload;
      if (typeof options.afterPatch === 'function') await options.afterPatch(write);
      return { ok: true };
    },
  };
}

test('new archive finalization keeps edits made during upload pending', () => {
  const uploaded = documentOf([holding('000001', { shares: 10 })]);
  const current = documentOf([holding('000001', {
    shares: 20,
    revision: 2,
    updatedAt: T2,
  })], { updatedAt: T2 });
  const changed = finalizeCreatedArchiveState(uploaded, current, {
    retained: 'metadata',
  }, { remoteSchema: 3, syncedAt: T2 });

  assert.equal(changed.pending, true);
  assert.equal(changed.meta.last_push_hash, canonicalHoldingsDocument(uploaded));
  assert.equal(changed.meta.pending_hash, canonicalHoldingsDocument(current));
  assert.equal(changed.meta.last_pull, T2);
  assert.equal(changed.meta.last_remote_schema, 3);
  assert.equal(changed.meta.retained, 'metadata');

  const unchanged = finalizeCreatedArchiveState(current, current, {}, {
    remoteSchema: 3,
    syncedAt: T2,
  });
  assert.equal(unchanged.pending, false);
  assert.equal(unchanged.meta.pending_hash, '');
  assert.equal(unchanged.meta.last_push_hash, canonicalHoldingsDocument(current));
});

test('sync metadata compares the verified snapshot to the document re-read inside the lock', () => {
  const uploaded = documentOf([holding('000001')]);
  const current = documentOf([holding('000001', { shares: 20, revision: 2, updatedAt: T2 })]);
  const final = finalizeCloudSyncMetadata(current, {}, { uploadedDocument: uploaded, pending: false, syncedAt: T2 });
  assert.equal(final.pending, true);
  assert.equal(final.meta.pending, true);
  assert.equal(final.meta.pending_hash, canonicalHoldingsDocument(current));
  assert.equal(final.meta.last_push_hash, canonicalHoldingsDocument(uploaded));

  const settled = finalizeCloudSyncMetadata(current, final.meta, { uploadedDocument: current, pending: false });
  assert.equal(settled.meta.pending, false);
  assert.equal(settled.meta.pending_hash, '');
});

test('a pull snapshot requiring bridge convergence is never labelled uploaded merely because local hashes match', () => {
  const current = documentOf([holding('000001')]);
  const previousMeta = { last_push_hash: canonicalHoldingsDocument(current) };
  const final = finalizeCloudSyncMetadata(current, previousMeta, {
    pulledDocument: current, pending: true, remoteSchema: 3,
  });
  assert.equal(final.meta.pending, true);
  assert.equal(final.meta.pending_hash, canonicalHoldingsDocument(current));
  assert.equal(final.meta.last_push_hash, previousMeta.last_push_hash);
});

for (const operation of ['push', 'pull']) {
  test(`${operation} preserves a concurrent edit made immediately before metadata finalization`, async () => {
    const initial = documentOf([holding('000001')]);
    const late = documentOf([holding('000001', { shares: 30, revision: 2, updatedAt: T2 })]);
    const local = fakeLocal(initial);
    const remote = fakeRemote(makeCloudWritePayload(initial, 3));
    let metadata;
    local.markPending = async (pending, details) => {
      local.state.document = late;
      const final = finalizeCloudSyncMetadata(local.state.document, {}, { ...details, pending });
      metadata = final.meta;
      return { ok: true, pending: final.pending, document: local.state.document };
    };
    const result = await (operation === 'push' ? synchronizeHoldingsCloud : pullHoldingsCloud)({
      local, remote, deviceId: 'device:phone',
    });
    assert.equal(result.ok, true);
    assert.equal(result.pending, true);
    assert.equal(result.document.holdings[0].shares, 30);
    assert.equal(metadata.pending, true);
    assert.equal(metadata.pending_hash, canonicalHoldingsDocument(late));
    if (operation === 'pull') assert.equal(result.changed, true);
    else assert.equal(result.uploadedDocument.holdings[0].shares, 10);
  });
}

test('schema 2 sync backs up both sides but stays pull-only until an explicit V3 upgrade', async () => {
  const local = fakeLocal(documentOf([holding('000001', { costNav: null })]));
  const remotePayload = schema2([holding('000002', { deviceId: 'legacy-phone' })]);
  const remote = fakeRemote(remotePayload);

  const result = await synchronizeHoldingsCloud({ local, remote, now: T2 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'remote_schema_upgrade_required');
  assert.equal(result.writeSchema, 2);
  assert.equal(result.pending, true);
  assert.equal(remote.state.patches.length, 0);
  assert.deepEqual(remote.state.gets, ['initial']);
  assert.equal(local.state.backups.length, 1);
  assert.deepEqual(local.state.backups[0].remoteRaw, remotePayload);
  assert.equal(local.state.persists.length, 0);
  assert.deepEqual(local.state.pending, []);
});

test('legacy arrays and Schema 2 archives both require an explicit isolated V3 upgrade', async () => {
  const local = fakeLocal(documentOf([holding('000003')]));
  const remote = fakeRemote([]);
  const compatible = await synchronizeHoldingsCloud({ local, remote });
  assert.equal(compatible.ok, false);
  assert.equal(compatible.reason, 'remote_schema_upgrade_required');
  assert.equal(compatible.sourceSchema, 1);
  assert.equal(compatible.writeSchema, 2);
  assert.equal(remote.state.patches.length, 0);

  const upgradedLocal = fakeLocal(documentOf([holding('000004')]));
  const upgradedRemote = fakeRemote(schema2([]));
  const upgraded = await synchronizeHoldingsCloud({
    local: upgradedLocal,
    remote: upgradedRemote,
    upgradeSchema: true,
  });
  assert.equal(upgraded.ok, true);
  assert.equal(upgraded.sourceSchema, 2);
  assert.equal(upgraded.writeSchema, 3);
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgradedRemote.state.patches[0].payload.schema, 3);
});

test('a Schema 2 remote cannot silently discard V3-only revisions, tombstones, or notes', async () => {
  const advanced = documentOf([holding('000004', {
    revision: 2,
    updatedAt: T2,
    deletedAt: T2,
    note: '已删除记录',
  })], { updatedAt: T2 });
  const local = fakeLocal(advanced);
  const remote = fakeRemote(schema2([]));

  assert.equal(requiresSchema3CloudUpgrade(documentOf([holding('000004')])), false);
  assert.equal(requiresSchema3CloudUpgrade(advanced), true);
  const result = await synchronizeHoldingsCloud({ local, remote });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'remote_schema_upgrade_required');
  assert.equal(result.writeSchema, 2);
  assert.equal(remote.state.patches.length, 0);
  assert.equal(local.state.persists.length, 0);
  assert.equal(local.state.backups.length, 1);
});

test('an explicit Schema 3 upgrade preserves V3-only records instead of projecting them to Schema 2', async () => {
  const advanced = documentOf([holding('000004', {
    revision: 2,
    updatedAt: T2,
    deletedAt: T2,
    note: '已删除记录',
  })], { updatedAt: T2 });
  const local = fakeLocal(advanced);
  const remote = fakeRemote(schema2([]));

  const result = await synchronizeHoldingsCloud({ local, remote, upgradeSchema: true });

  assert.equal(result.ok, true);
  assert.equal(result.writeSchema, 3);
  assert.equal(remote.state.patches[0].payload.schema, 3);
  assert.equal(remote.state.patches[0].payload.holdings[0].deletedAt, T2);
  assert.equal(remote.state.patches[0].payload.holdings[0].revision, 2);
  assert.equal(remote.state.patches[0].payload.holdings[0].note, '已删除记录');
});

test('schema 3 remains schema 3 and preserves the complete record contract', async () => {
  const remoteDocument = documentOf([holding('000005', {
    revision: 7,
    note: '长期持有',
    deviceId: 'device:tablet',
  })], { deviceId: 'device:tablet' });
  const local = fakeLocal(documentOf([]));
  const remote = fakeRemote(JSON.parse(canonicalHoldingsDocument(remoteDocument)));

  const result = await synchronizeHoldingsCloud({ local, remote });

  assert.equal(result.ok, true);
  assert.equal(result.writeSchema, 3);
  assert.equal(remote.state.patches[0].payload.holdings[0].revision, 7);
  assert.equal(remote.state.patches[0].payload.holdings[0].note, '长期持有');
  assert.equal(
    canonicalHoldingsDocument(result.uploadedDocument),
    canonicalHoldingsDocument(result.document)
  );
});

test('a corrupt remote payload fails closed before backup, local persistence, or PATCH', async () => {
  const local = fakeLocal(documentOf([holding('000006')]));
  const remote = fakeRemote('{broken');

  const result = await synchronizeHoldingsCloud({ local, remote });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'remote_payload_invalid');
  assert.equal(remote.state.patches.length, 0);
  assert.equal(local.state.backups.length, 0);
  assert.equal(local.state.persists.length, 0);
});

test('a future remote schema is read-only and can never be merged or overwritten', async () => {
  const future = {
    ...JSON.parse(canonicalHoldingsDocument(documentOf([holding('000007')]))),
    schema: 4,
  };
  const local = fakeLocal(documentOf([]));
  const remote = fakeRemote(future);

  const result = await synchronizeHoldingsCloud({ local, remote });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'remote_schema_future');
  assert.equal(remote.state.patches.length, 0);
  assert.equal(local.state.backups.length, 0);
  assert.equal(local.state.persists.length, 0);
});

test('a backup failure performs zero local writes and zero remote PATCH', async () => {
  const local = fakeLocal(documentOf([holding('000008')]), { backupFails: true });
  const remote = fakeRemote(schema2([]));

  const result = await synchronizeHoldingsCloud({ local, remote });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'backup_failed');
  assert.equal(local.state.persists.length, 0);
  assert.equal(remote.state.patches.length, 0);
});

test('a local write that cannot be read back stays fail-closed and never PATCHes remote', async () => {
  const local = fakeLocal(documentOf([]), { ignorePersists: true });
  const remote = fakeRemote(schema2([holding('000009', { deviceId: 'legacy-phone' })]));

  const result = await synchronizeHoldingsCloud({
    local, remote, maxStabilityAttempts: 2, upgradeSchema: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'local_persist_unstable');
  assert.equal(remote.state.patches.length, 0);
  assert.equal(local.state.persists.length, 2);
});

test('an acknowledged PATCH is not successful until a second GET matches canonically', async () => {
  const local = fakeLocal(documentOf([holding('000010')]));
  const remote = fakeRemote(schema2([]), {
    readback: documentOf([holding('999999', { fundName: '不一致' })]),
  });

  const result = await synchronizeHoldingsCloud({ local, remote, upgradeSchema: true });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'remote_readback_mismatch');
  assert.equal(result.patched, true);
  assert.equal(result.patchAcknowledged, true);
  assert.equal(result.remoteVerified, false);
  assert.equal(remote.state.patches.length, 1);
  assert.deepEqual(remote.state.gets, ['initial', 'readback']);
});

test('a V3 PATCH is not verified until the current device shard matches the aggregate readback', async () => {
  const original = documentOf([holding('000024')]);
  const local = fakeLocal(original);
  const remote = fakeRemote(original);
  const originalGet = remote.get;
  remote.get = async options => ({
    ...(await originalGet(options)),
    requiresPatch: options?.phase === 'readback',
  });

  const result = await synchronizeHoldingsCloud({ local, remote });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'remote_target_readback_mismatch');
  assert.equal(result.patched, true);
  assert.equal(result.patchAcknowledged, true);
  assert.equal(result.remoteVerified, false);
  assert.equal(remote.state.patches.length, 1);
});

test('a newer local edit made during PATCH is retained locally and remains pending for the next sync', async () => {
  const original = documentOf([holding('000011')]);
  const local = fakeLocal(original);
  const remote = fakeRemote(JSON.parse(canonicalHoldingsDocument(original)), {
    afterPatch() {
      local.state.document = documentOf([holding('000011', {
        shares: 15,
        updatedAt: T2,
        revision: 2,
        deviceId: 'device:phone',
      })], { updatedAt: T2 });
    },
  });

  const result = await synchronizeHoldingsCloud({ local, remote });

  assert.equal(result.ok, true);
  assert.equal(result.reason, 'synced_with_pending_changes');
  assert.equal(result.pending, true);
  assert.equal(result.uploadedDocument.holdings[0].shares, 10);
  assert.equal(result.document.holdings[0].shares, 15);
  assert.equal(local.state.document.holdings[0].shares, 15);
  assert.deepEqual(local.state.pending, [true]);
});

test('payload helpers keep null cost distinct from zero in schema 2', () => {
  const value = documentOf([
    holding('000012', { costNav: null }),
    holding('000013', { costNav: 0 }),
  ]);
  const payload = makeCloudWritePayload(value, 2);
  assert.equal(payload.holdings[0].cost, null);
  assert.equal(payload.holdings[1].cost, 0);
  assert.equal(canonicalCloudPayload(payload, 2), canonicalCloudPayload(JSON.stringify(payload), 2));
});

test('isolated V3 cloud bridge lifts a genuinely newer legacy edit without losing V3 metadata', () => {
  const v3 = documentOf([holding('000020', {
    shares: 10,
    note: '保留',
    revision: 4,
    updatedAt: T1,
  })], { updatedAt: T1 });
  const legacy = schema2([holding('000020', {
    shares: 12,
    updatedAt: T2,
    deviceId: 'legacy-phone',
  })]);

  const result = reconcileCloudBridgePayload(v3, legacy, { deviceId: 'device:new' });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.payload.schema, 3);
  assert.equal(result.payload.holdings[0].shares, 12);
  assert.equal(result.payload.holdings[0].note, '保留');
  assert.equal(result.payload.holdings[0].revision, 5);
});

test('isolated V3 cloud bridge never lets a legacy active row resurrect a tombstone', () => {
  const v3 = documentOf([holding('000021', {
    deletedAt: T1,
    revision: 5,
    updatedAt: T1,
  })], { updatedAt: T1 });
  const legacy = schema2([holding('000021', {
    updatedAt: T2,
    deviceId: 'offline-v14',
  })]);

  const result = reconcileCloudBridgePayload(v3, legacy, { deviceId: 'device:new' });

  assert.equal(result.ok, true);
  // The bridge may advance document-level metadata from the legacy sidecar,
  // but the protected record itself must remain deleted.
  assert.equal(result.changed, true);
  assert.equal(result.payload.holdings[0].deletedAt, T1);
  assert.equal(result.payload.holdings[0].revision, 5);
});

test('isolated V3 cloud bridge ignores a corrupt legacy sidecar but fails closed on corrupt V3', () => {
  const v3 = documentOf([holding('000022')]);
  const ignoredLegacy = reconcileCloudBridgePayload(v3, '{broken');
  assert.equal(ignoredLegacy.ok, true);
  assert.equal(ignoredLegacy.reason, 'bridge_legacy_ignored');
  assert.equal(ignoredLegacy.changed, false);

  const invalidV3 = reconcileCloudBridgePayload('{broken', schema2([holding('000022')]));
  assert.equal(invalidV3.ok, false);
  assert.equal(invalidV3.reason, 'bridge_v3_invalid');
});

test('pull-only preserves a bridge convergence marker until V3 receives merged legacy changes', async () => {
  const local = fakeLocal(documentOf([holding('000023')]));
  const remote = fakeRemote(documentOf([holding('000023')]));
  const originalGet = remote.get;
  remote.get = async options => ({ ...(await originalGet(options)), requiresPatch: true });

  const result = await pullHoldingsCloud({ local, remote });

  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.deepEqual(local.state.pending, [true]);
});

test('pull-only merges and persists locally without requiring or calling PATCH', async () => {
  const local = fakeLocal(documentOf([holding('000014')]));
  const remote = fakeRemote(schema2([holding('000015', { deviceId: 'legacy-phone' })]));
  delete remote.patch;

  const result = await pullHoldingsCloud({ local, remote });

  assert.equal(result.ok, true);
  assert.equal(result.patched, false);
  assert.equal(result.changed, true);
  assert.deepEqual(result.document.holdings.map(item => item.fundCode), ['000014', '000015']);
  assert.equal(local.state.persists.length, 1);
  assert.deepEqual(remote.state.gets, ['pull']);
});

test('pull-only treats a corrupt or future remote as read-only and performs zero local writes', async () => {
  const local = fakeLocal(documentOf([holding('000016')]));
  const corrupt = await pullHoldingsCloud({ local, remote: { get: async () => ({ ok: true, raw: '{broken' }) } });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.reason, 'remote_payload_invalid');
  assert.equal(local.state.backups.length, 0);
  assert.equal(local.state.persists.length, 0);

  const futurePayload = { ...JSON.parse(canonicalHoldingsDocument(documentOf([]))), schema: 4 };
  const future = await pullHoldingsCloud({ local, remote: { get: async () => ({ ok: true, raw: futurePayload }) } });
  assert.equal(future.ok, false);
  assert.equal(future.reason, 'remote_schema_future');
  assert.equal(local.state.backups.length, 0);
  assert.equal(local.state.persists.length, 0);
});
