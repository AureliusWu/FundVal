import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncStatus } from '../js/runtime/sync-status.js';

const ID = 'a'.repeat(32), OTHER = 'b'.repeat(32);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness(initial = {}) {
  const controls = { token: 'synthetic-session-token', id: ID, time: '', meta: {}, clock: 100000,
    updating: false, document: { deviceId: 'synthetic-device' }, ...initial };
  const calls = [], timers = new Map(), intervals = new Map(), gates = {};
  const results = { pull: { ok: true, remoteVerified: true }, push: { ok: true, remoteVerified: true },
    reload: { ok: true }, list: { ok: true, complete: true, candidates: [] } };
  const element = { textContent: '', style: {} };
  let api, nextTimer = 1;
  async function boundary(name) {
    calls.push(name);
    if (gates[name]) await gates[name].promise;
    if (controls.throwAt === name) throw new Error('SECRET_TOKEN https://private.invalid/?token=secret');
  }
  const context = {
    TIMING: { AUTO_PUSH_DELAY: 100, AUTO_PULL_INTERVAL: 1000 },
    document: { getElementById() { return controls.noElement ? null : element; } },
    isUpdateApplying: () => controls.updating,
    getHoldingsDocument: () => controls.document,
    getGistToken: () => controls.token, getGistId: () => controls.id,
    setGistId(id) { calls.push(['select', id]); if (controls.idWrite === false) return false;
      if (controls.idWrite === 'throw') throw new Error('secret-id-write'); controls.id = id; return true; },
    getSyncTime: () => controls.time, setSyncTime(time) { calls.push('time'); controls.time = time; },
    loadSyncMeta() { if (controls.metaThrow) throw new Error('secret-meta'); return controls.meta; },
    markSyncPending() { calls.push('pending'); api.setSyncPending(true); controls.meta.pending = true;
      if (controls.pendingThrow) throw new Error('secret-pending'); },
    async loadCloudSyncFeature() { await boundary('load'); return {
      async pullHoldingsCloud(options) { calls.push(['client', 'pull', options]); await boundary('pull'); return results.pull; },
      async synchronizeHoldingsCloud(options) { calls.push(['client', 'push', options]); await boundary('push'); return results.push; },
    }; },
    async listGists(token) { assert.equal(token, controls.discoveryToken || controls.token); await boundary('list'); return results.list; },
    setArchiveCandidates(candidates) { calls.push(['candidates', candidates]); },
    async findExistingGist() { throw new Error('New discovery must never use the old implicit-first API'); },
    async createGistRemoteAdapter(token, id, scope) {
      assert.equal(token, 'synthetic-session-token'); assert.equal(id, controls.id);
      calls.push(['remote-scope', scope]); await boundary('remote'); return {};
    },
    async createCloudLocalAdapter(id, scope) { calls.push(['local-scope', scope]); await boundary('local'); return {}; },
    async reloadHoldingsAfterCloud(scope) { calls.push(['reload-scope', scope]); await boundary('reload');
      if (scope?.isCurrent()) controls.meta.pending = results.reload.pending === true;
      return results.reload; },
    renderHoldingsList() { calls.push('render'); }, refresh() { calls.push('refresh'); },
    showToast(message) { calls.push(['toast', message]); }, nowISO: () => new Date(controls.clock).toISOString(),
    now: () => controls.clock, random: () => 0,
    setTimeout(callback, ms) { const id = nextTimer++; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval(callback, ms) { const id = nextTimer++; intervals.set(id, { callback, ms }); return id; },
    clearInterval: id => intervals.delete(id),
  };
  api = createSyncStatus(context);
  return { api, context, controls, calls, results, element, timers, intervals,
    hold(name) { return gates[name] = deferred(); },
    async tick() { const [id, timer] = timers.entries().next().value || [];
      assert.ok(timer, 'Expected a scheduled retry/debounce'); timers.delete(id); controls.clock += timer.ms;
      await timer.callback(); await flush(); },
    count(name) { return calls.filter(call => call === name).length; },
  };
}

test('M4 constructor is inert and exposes seven-state safe model without removing old APIs', () => {
  const h = harness();
  assert.deepEqual(h.calls, []); assert.equal(h.api.isSyncing(), false);
  assert.equal(h.api.getStatus().state, 'local-only');
  for (const method of ['hasCloudConfig', 'renderCloudStatus', 'handleCloudFailure', 'hasPendingSync', 'resolveGistId',
    'pullFromCloud', 'pushToCloud', 'scheduleAutoPush', 'startAutoPull', 'autoPullOnLoad', 'resetCloudState',
    'setSyncPending', 'getStatus', 'recordExternalResult', 'runManualOperation', 'dispose']) assert.equal(typeof h.api[method], 'function', method);
  h.api.renderCloudStatus(); assert.ok(h.element.textContent.includes(ID));
  assert.doesNotMatch(JSON.stringify(h.api.getStatus()), /synthetic-session-token|pending_hash|last_push_hash|https:/);
});

test('PWA guard precedes busy/token/lazy work and absent token remains local-only', async () => {
  const h = harness({ updating: true });
  for (const method of ['pullFromCloud', 'pushToCloud']) assert.deepEqual(await h.api[method](false), { ok: false, reason: 'service_worker_update_pending' });
  assert.deepEqual(await h.api.runManualOperation(() => { throw new Error('must not run'); }), { ok: false, reason: 'service_worker_update_pending' });
  h.controls.updating = false; h.controls.token = '';
  assert.equal(await h.api.pushToCloud(false), undefined); assert.deepEqual(h.calls, []);
});

test('single busy ownership spans lazy import, blocks both directions/manual, and PWA remains live', async () => {
  const h = harness(), gate = h.hold('load');
  const running = h.api.pushToCloud(false); assert.equal(h.api.isSyncing(), true);
  assert.equal(h.api.getStatus().state, 'syncing');
  assert.equal(await h.api.pullFromCloud(false), undefined); assert.equal(await h.api.pushToCloud(false), undefined);
  assert.equal(await h.api.runManualOperation(() => { throw new Error('busy'); }), undefined);
  h.controls.updating = true;
  assert.deepEqual(await h.api.pullFromCloud(false), { ok: false, reason: 'service_worker_update_pending' });
  gate.resolve(); await running; assert.equal(h.api.isSyncing(), false);
});

test('bare 2xx-like success never claims verified or updates last verified time', async () => {
  const h = harness(); h.results.push = { ok: true };
  assert.equal(await h.api.pushToCloud(false), h.results.push);
  assert.equal(h.api.getStatus().state, 'pending'); assert.equal(h.controls.time, '');
  assert.match(h.element.textContent, /验证|确认/);
});

test('M4 read-only discovery cannot implicitly schedule an automatic upload', async () => {
  const h = harness({ meta: { pending: true } });
  await h.api.runManualOperation(async () => ({ ok: true, pending: true }));
  assert.equal(h.api.getStatus().state, 'pending');
  assert.equal(h.timers.size, 0);
  assert.equal(h.count('push'), 0);
});

test('verified success needs remoteVerified and no persisted/result pending; changed pull order survives', async () => {
  const h = harness(); h.results.pull.changed = true;
  assert.equal(await h.api.pullFromCloud(false), h.results.pull);
  assert.equal(h.api.getStatus().state, 'verified'); assert.notEqual(h.controls.time, '');
  assert.ok(h.calls.indexOf('render') < h.calls.indexOf('refresh'));
  h.results.push.pending = true; await h.api.pushToCloud(true);
  assert.equal(h.api.getStatus().state, 'pending'); assert.equal(h.api.isPending(), true); assert.equal(h.timers.size, 1);
});

for (const [reason, state, code] of [
  ['remote_http_401', 'failed', 'auth'], ['remote_http_403', 'failed', 'permission'], ['remote_http_404', 'failed', 'missing'],
  ['remote_http_409', 'conflict', 'conflict'], ['remote_schema_future', 'readonly', 'newer_schema'],
  ['remote_schema_upgrade_required', 'pending', 'upgrade_required'], ['remote_payload_invalid', 'failed', 'validation'],
]) test('fixed safe UI and stopped automatic retry for ' + reason, async () => {
  const h = harness(); h.results.push = { ok: false, reason, message: 'SECRET_TOKEN <img onerror=secret>',
    pending_hash: 'SECRET_HASH', url: 'https://private.invalid/?token=secret' };
  await h.api.pushToCloud(false);
  assert.equal(h.api.getStatus().state, state); assert.equal(h.api.getStatus().code, code);
  assert.equal(h.timers.size, 0); assert.equal(h.controls.id, ID); assert.equal(h.api.isPending(), true);
  const count = h.count('load'); h.api.startAutoPull(); await [...h.intervals.values()][0].callback(); await flush();
  assert.equal(h.count('load'), count, 'A fixed interval cannot restart a terminal failure');
  assert.doesNotMatch(JSON.stringify([h.api.getStatus(), h.element, h.calls.filter(Array.isArray).filter(x => x[0] === 'toast')]), /SECRET|onerror|private.invalid/);
});

test('safe status suppresses non-hex archive identifiers instead of showing injected text', () => {
  const h = harness({ id: '<img onerror=secret>' }); h.api.renderCloudStatus();
  assert.equal(h.api.getStatus().gistId, ''); assert.doesNotMatch(h.element.textContent, /img|onerror/);
});

for (const [list, reason] of [
  [{ ok: true, complete: true, candidates: [] }, 'remote_archive_missing'],
  [{ ok: true, complete: true, candidates: [{ id: ID }, { id: OTHER }] }, 'archive_selection_required'],
  [{ ok: true, complete: false, candidates: [{ id: ID }] }, 'remote_discovery_incomplete'],
  [{ ok: true, complete: true, candidates: [{ id: 'bad-url?<token>' }] }, 'remote_discovery_incomplete'],
]) test('discovery does not select or sync on ' + reason, async () => {
  const h = harness({ id: '' }); h.results.list = list;
  assert.equal((await h.api.pushToCloud(false)).reason, reason); assert.equal(h.controls.id, '');
  assert.equal(h.count('push'), 0); assert.equal(h.count('pull'), 0);
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'candidates'));
});

test('only one complete valid candidate is selected; adapter scopes follow the selected identity', async () => {
  const h = harness({ id: '' }); h.results.list = { ok: true, complete: true, candidates: [{ id: ID, schema: 3, updatedAt: '2026-10-25T00:00:00Z' }] };
  await h.api.pushToCloud(false); assert.equal(h.controls.id, ID); assert.equal(h.count('push'), 1);
  for (const name of ['remote-scope', 'local-scope', 'reload-scope']) {
    const scope = h.calls.find(call => Array.isArray(call) && call[0] === name)[1];
    assert.equal(typeof scope.isCurrent, 'function'); assert.equal(scope.signal.aborted, false);
  }
});

test('standalone late discovery cannot select after reset or token identity changes', async () => {
  for (const reset of [false, true]) {
    const h = harness({ id: '' }), gate = h.hold('list'); h.results.list = { ok: true, complete: true, candidates: [{ id: ID }] };
    const resolving = h.api.resolveGistId(h.controls.token); await flush();
    if (reset) h.api.resetCloudState(); else h.controls.token = '';
    gate.resolve(); assert.equal((await resolving).ok, false); assert.equal(h.controls.id, '');
    assert.equal(h.calls.some(call => Array.isArray(call) && call[0] === 'select'), false);
  }
});

for (const boundary of ['load', 'list', 'remote', 'local', 'push', 'reload']) test('config epoch blocks stale effects after ' + boundary, async () => {
  const h = harness({ id: boundary === 'list' ? '' : ID }), gate = h.hold(boundary);
  h.results.list = { ok: true, complete: true, candidates: [{ id: ID }] };
  const running = h.api.pushToCloud(false); await flush(); assert.ok(h.calls.includes(boundary));
  const previousEffects = h.calls.length; h.controls.id = OTHER; h.api.resetCloudState();
  assert.equal(h.api.isSyncing(), true, 'Reset must not tell PWA that suspended network has stopped');
  gate.resolve(); assert.equal((await running).ok, false); assert.equal(h.api.isSyncing(), false);
  assert.equal(h.controls.time, ''); assert.equal(h.api.isPending(), false); assert.equal(h.timers.size, 0);
  assert.equal(h.calls.slice(previousEffects).some(call => ['time', 'refresh', 'render', 'pending'].includes(call)), false);
  assert.equal(h.controls.id, OTHER);
});

for (const boundary of ['load', 'remote', 'local', 'push', 'reload']) test('exception at ' + boundary + ' stays safe and releases busy', async () => {
  const h = harness({ throwAt: boundary }); const result = await h.api.pushToCloud(false);
  assert.equal(result.ok, false); assert.equal(h.api.isSyncing(), false); assert.equal(h.api.isPending(), true);
  assert.doesNotMatch(JSON.stringify([result, h.api.getStatus(), h.element]), /SECRET|private.invalid/);
});

test('pending callback failure remains pending without recursive callback or leaked exception', async () => {
  const h = harness({ pendingThrow: true }); h.results.push = { ok: false, reason: 'remote_http_403' };
  assert.equal((await h.api.pushToCloud(false)).ok, false); assert.equal(h.count('pending'), 1);
  assert.equal(h.api.isPending(), true); assert.equal(h.api.isSyncing(), false);
});

test('429 Retry-After cannot be bypassed by manual calls, debounce, interval, or startup online recovery', async () => {
  const h = harness(); h.results.push = { ok: false, reason: 'remote_http_429', failure: { code: 'rate_limit', retryAfterMs: 120000 } };
  await h.api.pushToCloud(false); assert.equal(h.api.getStatus().retryAt, 220000); assert.equal(h.timers.size, 1);
  assert.equal((await h.api.pushToCloud(false)).reason, 'sync_retry_cooldown');
  assert.equal((await h.api.pullFromCloud(false)).reason, 'sync_retry_cooldown');
  assert.equal((await h.api.runManualOperation(() => { throw new Error('cooldown'); })).reason, 'sync_retry_cooldown');
  h.api.scheduleAutoPush(); h.api.startAutoPull(); await [...h.intervals.values()][0].callback(); await h.api.autoPullOnLoad();
  assert.equal(h.count('load'), 1); assert.equal(h.timers.size, 1);
  h.results.push = { ok: true, remoteVerified: true }; await h.tick();
  assert.equal(h.count('push'), 2); assert.equal(h.api.getStatus().state, 'verified');
});

test('429 cooldown survives selecting a different archive with the same credential', async () => {
  const h = harness();
  h.results.pull = { ok: false, reason: 'remote_http_429', failure: { code: 'rate_limit', retryAfterMs: 120000 } };
  await h.api.pullFromCloud(false);
  const deadline = h.api.getStatus().retryAt;
  h.api.resetCloudState({ preserveBackoff: true });
  h.controls.id = OTHER;
  assert.equal(h.api.getStatus().retryAt, deadline);
  assert.equal(h.api.getStatus().code, 'rate_limit');
  assert.deepEqual(await h.api.pullFromCloud(false), { ok: false, reason: 'sync_retry_cooldown' });
  assert.equal(h.count('pull'), 1);
});

test('transient failures schedule at most eight retries and duplicate failure recording is idempotent', async () => {
  const h = harness();
  for (let i = 0; i < 9; i++) {
    h.results.push = { ok: false, reason: 'remote_http_503' };
    if (i === 0) await h.api.pushToCloud(false); else await h.tick();
    const attempt = h.api.getStatus().retryAttempt;
    h.api.handleCloudFailure(h.results.push, true); h.api.recordExternalResult(h.results.push);
    assert.equal(h.api.getStatus().retryAttempt, attempt);
  }
  assert.equal(h.count('push'), 9); assert.equal(h.timers.size, 0); assert.equal(h.api.getStatus().retryAt, null);
  h.api.scheduleAutoPush(); h.api.startAutoPull(); await [...h.intervals.values()][0].callback(); await flush();
  assert.equal(h.count('push'), 9);
});

test('unknown PATCH never blindly repeats PATCH; next manual operation must read first even after retry exhaustion', async () => {
  const h = harness(); h.results.push = { ok: false, reason: 'remote_readback_mismatch', patched: true, remoteVerified: false };
  await h.api.pushToCloud(false); assert.equal(h.api.getStatus().readFirst, true); assert.equal(h.count('push'), 1);
  h.results.pull = { ok: true, remoteVerified: true }; await h.api.pushToCloud(false);
  assert.equal(h.count('push'), 1); assert.equal(h.count('pull'), 1); assert.equal(h.api.getStatus().readFirst, false);
});

test('manual create uses same busy/epoch lock, automatically records one result and aborts safely on dispose', async () => {
  const h = harness(), gate = deferred(); let scope;
  const running = h.api.runManualOperation(async current => { scope = current; await gate.promise; return { ok: true, remoteVerified: true }; });
  await flush(); assert.equal(h.api.isSyncing(), true); assert.equal(scope.isCurrent(), true);
  h.api.dispose(); assert.equal(h.api.isSyncing(), true); assert.equal(scope.isCurrent(), false); assert.equal(scope.signal.aborted, true);
  gate.resolve(); assert.equal((await running).ok, false); assert.equal(h.api.isSyncing(), false); assert.equal(h.controls.time, '');
});

test('manual discovery shares active scope and successful creation verifies only after readback', async () => {
  const h = harness({ id: '' }); h.results.list = { ok: true, complete: true, candidates: [{ id: ID }] };
  await h.api.runManualOperation(async () => ({ ok: true, pending: true, gistId: await h.api.resolveGistId(h.controls.token) }));
  assert.equal(h.controls.id, ID); assert.equal(h.api.getStatus().state, 'pending');
  await h.api.runManualOperation(async () => ({ ok: true, remoteVerified: true }));
  assert.equal(h.api.getStatus().state, 'verified');
});

test('empty manual-create scope may atomically adopt one valid new archive and remain current through readback', async () => {
  const h = harness({ id: '' }); let captured;
  const result = await h.api.runManualOperation(async scope => {
    captured = scope; assert.equal(scope.adoptGistId(ID), true); assert.equal(scope.isCurrent(), true);
    assert.equal(scope.adoptGistId(OTHER), false); return { ok: true, remoteVerified: true };
  });
  assert.equal(result.ok, true); assert.equal(h.controls.id, ID); assert.equal(captured.isCurrent(), false);
  assert.equal(h.api.getStatus().state, 'verified');
});

for (const scenario of ['bound', 'epoch', 'invalid', 'write-false', 'write-throws']) test('scope adoption rejects ' + scenario, async () => {
  const h = harness({ id: scenario === 'bound' ? ID : '', idWrite: scenario === 'write-false' ? false : scenario === 'write-throws' ? 'throw' : true });
  await h.api.runManualOperation(async scope => {
    if (scenario === 'epoch') h.api.resetCloudState();
    assert.equal(scope.adoptGistId(scenario === 'invalid' ? 'https://private.invalid' : OTHER), false);
    return { ok: true };
  });
  assert.equal(h.controls.id, scenario === 'bound' ? ID : '');
});

test('discovery 429 passes only safe failure fields into the same cooldown policy', async () => {
  const h = harness({ id: '' });
  h.results.list = { ok: false, reason: 'remote_http_429', failure: { code: 'rate_limit', retryAfterMs: 120000 },
    token: 'SECRET', message: 'SECRET', privateURL: 'https://private.invalid/?token=secret' };
  const result = await h.api.pushToCloud(false);
  assert.equal(result.reason, 'remote_http_429'); assert.equal(h.api.getStatus().retryAt, 220000);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|privateURL/); assert.equal(h.count('push'), 0);
});

test('replaced debounce/interval callbacks and reset-era callbacks cannot dispatch stale work', async () => {
  const h = harness(); h.api.scheduleAutoPush(); const oldPush = [...h.timers.values()][0].callback;
  h.api.scheduleAutoPush(); h.api.startAutoPull(); const oldPull = [...h.intervals.values()][0].callback;
  h.api.startAutoPull(); await oldPush(); await oldPull(); assert.equal(h.count('load'), 0);
  const currentPush = [...h.timers.values()][0].callback, currentPull = [...h.intervals.values()][0].callback;
  h.api.resetCloudState(); await currentPush(); await currentPull(); assert.equal(h.count('load'), 0);
  assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});

test('device identity remains live after adapter awaits and options errors cannot leak raw messages', async () => {
  const h = harness(), gate = h.hold('local'); const running = h.api.pushToCloud(false); await flush();
  h.controls.document = { deviceId: 'new-synthetic-device' }; gate.resolve(); await running;
  assert.equal(h.calls.find(call => Array.isArray(call) && call[0] === 'client')[2].deviceId, 'new-synthetic-device');
  const next = harness();
  const result = await next.api.pushToCloud(false, { get upgradeSchema() { throw new Error('SECRET_OPTION'); } });
  assert.equal(result.ok, false); assert.equal(next.api.isSyncing(), false); assert.equal(next.api.isPending(), true);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_OPTION/);
});

test('failed reload and damaged sync metadata never claim verification or leave busy stuck', async () => {
  for (const metadata of [false, true]) {
    const h = harness({ metaThrow: metadata });
    if (!metadata) h.results.reload = { ok: false, reason: 'SECRET_RELOAD' };
    const result = await h.api.pushToCloud(false);
    assert.equal(result.ok, false); assert.equal(h.api.isSyncing(), false); assert.equal(h.controls.time, '');
    assert.notEqual(h.api.getStatus().state, 'verified'); assert.doesNotMatch(JSON.stringify(result), /SECRET|secret-meta/);
  }
});

test('unknown write remains read-first after all eight retries and explicit configuration reset', async () => {
  const h = harness(); h.results.push = { ok: false, reason: 'remote_readback_failed', patched: true };
  await h.api.pushToCloud(false);
  for (let i = 0; i < 8; i++) { h.results.pull = { ok: false, reason: 'remote_read_failed' }; await h.tick(); }
  assert.equal(h.timers.size, 0); assert.equal(h.api.getStatus().readFirst, true); assert.equal(h.count('push'), 1);
  h.api.resetCloudState(); assert.equal(h.api.getStatus().readFirst, true);
  h.results.pull = { ok: true, remoteVerified: true }; await h.api.pushToCloud(false);
  assert.equal(h.count('push'), 1); assert.equal(h.count('pull'), 9); assert.equal(h.api.getStatus().state, 'verified');
});

test('acknowledged but unverified 2xx write cannot schedule a blind pending PATCH', async () => {
  const h = harness(); h.results.push = { ok: true, patched: true, pending: true };
  await h.api.pushToCloud(false); assert.equal(h.api.getStatus().readFirst, true); assert.equal(h.timers.size, 0);
  await h.api.pushToCloud(false); assert.equal(h.count('push'), 1); assert.equal(h.count('pull'), 1);
});

test('completed manual scope cannot adopt an archive after busy ownership has ended', async () => {
  const h = harness({ id: '' }); let captured;
  await h.api.runManualOperation(async scope => { captured = scope; return { ok: true }; });
  assert.equal(h.api.isSyncing(), false); assert.equal(captured.isCurrent(), false);
  assert.equal(captured.adoptGistId(ID), false); assert.equal(h.controls.id, '');
});
