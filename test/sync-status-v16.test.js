import currentTest from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { parseSync } from 'rolldown/utils';
import { createSyncStatus as candidateFactory } from '../js/runtime/sync-status.js';

// M4 intentionally changes discovery, failure, verification and retry semantics.
// All M3 oracle scenarios below are historical fixture checks, not assertions
// about the active controller; active protections live in the M4/lifecycle tests.
const test = Object.assign((name, ...args) => currentTest('M3 historical fixture (not M4 acceptance): ' + name, ...args),
  { before: currentTest.before, after: currentTest.after });

// Literal independently frozen from app.before.js before module implementation.
// Old App SHA256: 17826050a92d14d4ff7327c275e6c04a60632b6e01d9d046f05c4554e9f84359.
const LEGACY_FUNCTIONS = "function hasCloudConfig() {\n  return !!(getGistToken());  // 有 Token 即可，Gist ID 可自动发现\n}\n\nfunction renderCloudStatus() {\n  var el = document.getElementById('cloud-status');\n  if (!el) return;\n  var syncTime = getSyncTime();\n  if (syncTime) {\n    var d = new Date(syncTime);\n    el.textContent = '上次同步: ' + d.toLocaleString('zh-CN');\n    el.style.color = 'var(--up)';\n  } else {\n    el.textContent = '配置 Token 后自动同步';\n    el.style.color = 'var(--muted)';\n  }\n}\n\nfunction handleCloudFailure(result, silent) {\n  const reason = String(result?.reason || 'cloud_sync_failed');\n  if (reason.includes('404')) {\n    setGistId('');\n    renderCloudStatus();\n  }\n  if (silent) return;\n  if (reason.includes('401')) showToast('Token 无效，请检查');\n  else if (reason === 'remote_schema_future') showToast('云端数据版本更高，已进入只读保护，未写入');\n  else if (reason === 'remote_schema_upgrade_required') {\n    showToast('当前变更需要创建隔离的 Schema 3 云端存档；旧版文件会保留且不能覆盖新格式。请手动上传并确认升级。');\n  }\n  else if (reason.includes('invalid') || reason.includes('missing') || reason.includes('truncated')) {\n    showToast('云端持仓校验失败，已停止同步以保护数据');\n  } else if (result?.patched && !result?.remoteVerified) {\n    showToast('云端已响应但读回验证失败，状态待确认');\n  } else {\n    showToast('同步失败，变更已保留待重试');\n  }\n}\n\nfunction hasPendingSync() {\n  const meta = loadSyncMeta();\n  return meta.pending === true || Boolean(meta.pending_hash && meta.pending_hash !== meta.last_push_hash);\n}\n\nasync function resolveGistId(token) {\n  let gistId = getGistId();\n  if (gistId) return gistId;\n  const found = await findExistingGist(token);\n  if (!found) return '';\n  setGistId(found);\n  return found;\n}\n\nasync function pullFromCloud(silent) {\n  if (serviceWorkerUpdateApplying) return { ok: false, reason: 'service_worker_update_pending' };\n  if (isSyncing) return;\n  const token = getGistToken();\n  if (!token) return;\n\n  isSyncing = true;\n  try {\n    const { pullHoldingsCloud } = await loadCloudSyncFeature();\n    const gistId = await resolveGistId(token);\n    if (!gistId) return;\n    const result = await pullHoldingsCloud({\n      remote: await createGistRemoteAdapter(token, gistId),\n      local: await createCloudLocalAdapter(gistId),\n      deviceId: holdingsDocument?.deviceId,\n    });\n    if (!result.ok) {\n      handleCloudFailure(result, silent);\n      return result;\n    }\n    const reloaded = await reloadHoldingsAfterCloud();\n    if (!reloaded.ok) {\n      const failure = { ...result, ok: false, reason: reloaded.reason };\n      handleCloudFailure(failure, silent);\n      return failure;\n    }\n    setSyncTime(nowISO());\n    if (result.changed) {\n      renderHoldingsList();\n      renderCloudStatus();\n      refresh();\n    }\n    if (result.pending || hasPendingSync()) scheduleAutoPush();\n    return result;\n  } catch(e) {\n    if (!silent) showToast('同步失败，变更已保留待重试');\n    return { ok: false, reason: e?.message || 'cloud_pull_failed' };\n  } finally {\n    isSyncing = false;\n  }\n}\n\nasync function pushToCloud(silent, options = {}) {\n  if (serviceWorkerUpdateApplying) return { ok: false, reason: 'service_worker_update_pending' };\n  if (isSyncing) return;\n  const token = getGistToken();\n  if (!token) return;\n\n  isSyncing = true;\n  try {\n    const { synchronizeHoldingsCloud } = await loadCloudSyncFeature();\n    const gistId = await resolveGistId(token);\n    if (!gistId) return;\n    const result = await synchronizeHoldingsCloud({\n      remote: await createGistRemoteAdapter(token, gistId),\n      local: await createCloudLocalAdapter(gistId),\n      deviceId: holdingsDocument?.deviceId,\n      upgradeSchema: options.upgradeSchema === true,\n    });\n    if (!result.ok) {\n      markSyncPending();\n      handleCloudFailure(result, silent);\n      return result;\n    }\n    const reloaded = await reloadHoldingsAfterCloud();\n    if (!reloaded.ok) {\n      const failure = { ...result, ok: false, reason: reloaded.reason };\n      handleCloudFailure(failure, silent);\n      return failure;\n    }\n    setSyncTime(nowISO());\n    renderCloudStatus();\n    if (result.pending || hasPendingSync()) scheduleAutoPush();\n    return result;\n  } catch(e) {\n    // 保留持久化待同步标记，以便网络恢复或下次启动后补推。\n    markSyncPending();\n    return { ok: false, reason: e?.message || 'cloud_push_failed' };\n  } finally {\n    isSyncing = false;\n  }\n}\n\nfunction scheduleAutoPush() {\n  if (!hasCloudConfig()) return;\n  markSyncPending();\n  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);\n  syncDebounceTimer = setTimeout(function() {\n    pushToCloud(true);\n  }, TIMING.AUTO_PUSH_DELAY);\n}\n\nfunction startAutoPull() {\n  if (autoPullTimer) clearInterval(autoPullTimer);\n  autoPullTimer = setInterval(function() {\n    pullFromCloud(true);\n    if (hasPendingSync()) scheduleAutoPush();\n  }, TIMING.AUTO_PULL_INTERVAL);\n}\n\nasync function autoPullOnLoad() {\n  if (!hasCloudConfig()) return;\n  await pullFromCloud(true);\n  if (hasPendingSync()) scheduleAutoPush();\n}";
const methodNames = ['hasCloudConfig', 'renderCloudStatus', 'handleCloudFailure', 'hasPendingSync',
  'resolveGistId', 'pullFromCloud', 'pushToCloud', 'scheduleAutoPush', 'startAutoPull', 'autoPullOnLoad'];
function legacyFactory(context) {
  const sandbox = { ...context, Date };
  Object.defineProperty(sandbox, 'holdingsDocument', { get: context.getHoldingsDocument });
  Object.defineProperty(sandbox, 'serviceWorkerUpdateApplying', { get: context.isUpdateApplying });
  return vm.runInNewContext(
    '"use strict";let syncPending=false,syncDebounceTimer=null,autoPullTimer=null,isSyncing=false;\n'
    + LEGACY_FUNCTIONS + '\nconst returnApi = {'
    + methodNames.join(',') + ',isSyncing:()=>isSyncing,isPending:()=>syncPending,'
    + 'setSyncPending:value=>{syncPending=value;},resetCloudState:()=>{'
    + 'syncPending=false;if(syncDebounceTimer){clearTimeout(syncDebounceTimer);syncDebounceTimer=null;}'
    + 'if(autoPullTimer){clearInterval(autoPullTimer);autoPullTimer=null;}}};returnApi;',
    sandbox);
}
let deniedFetchCalls = 0;
const previousFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = () => { deniedFetchCalls++; throw new Error('Network denied in sync-status characterization'); }; });
test.after(() => { globalThis.fetch = previousFetch; assert.equal(deniedFetchCalls, 0); });
const clean = value => value === undefined ? '<undefined>' : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(factory, initial = {}) {
  const calls = [], timeouts = new Map(), intervals = new Map();
  const controls = { token: 'synthetic-token', id: 'synthetic-id', time: '', meta: {},
    updating: false, document: { deviceId: 'device:first' }, ...initial };
  const results = { pull: { ok: true }, push: { ok: true }, reload: { ok: true } };
  let api, next = 1;
  const element = { textContent: '', style: {} };
  const context = {
    TIMING: { AUTO_PUSH_DELAY: 123, AUTO_PULL_INTERVAL: 456 },
    document: { getElementById: id => { calls.push(['element', id]); return controls.noElement ? null : element; } },
    isUpdateApplying: () => { calls.push('update-guard'); return controls.updating; },
    getHoldingsDocument: () => controls.document,
    getGistToken: () => { calls.push('token-read'); return controls.token; },
    getGistId: () => { calls.push('id-read'); return controls.id; },
    setGistId: value => { calls.push(['id-write', value]); controls.id = value; return true; },
    getSyncTime: () => { calls.push('time-read'); return controls.time; },
    setSyncTime: value => { calls.push(['time-write', value]); controls.time = value; return controls.timeWrite !== false; },
    nowISO: () => '2026-10-23T00:00:00.000Z',
    loadSyncMeta: () => { calls.push('meta-read'); if (controls.metaThrow) throw controls.metaThrow; return controls.meta; },
    markSyncPending: () => {
      calls.push('pending');
      api.setSyncPending(true);
      if (controls.pendingThrow) throw controls.pendingThrow;
      controls.meta.pending = true;
      controls.meta.pending_hash = 'synthetic-current-hash';
    },
    loadCloudSyncFeature: async () => {
      calls.push('lazy-cloud');
      if (controls.loadGate) await controls.loadGate;
      if (controls.loadThrow) throw controls.loadThrow;
      return {
        pullHoldingsCloud: async options => { calls.push(['client', 'pull', options.deviceId, options.upgradeSchema]);
          if (controls.clientGate) await controls.clientGate;
          if (controls.clientThrow) throw controls.clientThrow;
          return results.pull; },
        synchronizeHoldingsCloud: async options => { calls.push(['client', 'push', options.deviceId, options.upgradeSchema]);
          if (controls.clientGate) await controls.clientGate;
          if (controls.clientThrow) throw controls.clientThrow;
          return results.push; },
      };
    },
    findExistingGist: async token => { assert.equal(token, 'synthetic-token'); calls.push('discover');
      if (controls.discoverThrow) throw controls.discoverThrow; return controls.found || null; },
    createGistRemoteAdapter: async (token, id) => { assert.equal(token, 'synthetic-token');
      calls.push(['remote', id]); if (controls.remoteThrow) throw controls.remoteThrow; return { remote: true }; },
    createCloudLocalAdapter: async id => { calls.push(['local', id]);
      if (controls.localThrow) throw controls.localThrow; return { local: true }; },
    reloadHoldingsAfterCloud: async () => { calls.push('reload'); return results.reload; },
    renderHoldingsList: () => calls.push('holdings-render'),
    refresh: () => { calls.push('refresh'); if (controls.refreshThrow) throw controls.refreshThrow; },
    showToast: value => calls.push(['toast', value]),
    setTimeout: (callback, ms) => { const id = next++; calls.push(['timeout', id, ms]); timeouts.set(id, callback); return id; },
    clearTimeout: id => { calls.push(['clear-timeout', id]); timeouts.delete(id); },
    setInterval: (callback, ms) => { const id = next++; calls.push(['interval', id, ms]); intervals.set(id, callback); return id; },
    clearInterval: id => { calls.push(['clear-interval', id]); intervals.delete(id); },
  };
  api = factory(context);
  return { api, context, controls, results, calls, timeouts, intervals, element,
    snapshot: () => ({ calls, busy: api.isSyncing(), pending: api.isPending(),
      meta: controls.meta, id: controls.id, time: controls.time, element,
      timeouts: [...timeouts.keys()], intervals: [...intervals.keys()] }) };
}
async function equivalent(scenario, initial) {
  // Exercise the one literal fixture; comparing two copies is not M4 evidence.
  return scenario(harness(legacyFactory, initial));
}
currentTest('M4 factory stays pure/per-instance and preserves original API arities', () => {
  const a = harness(candidateFactory), b = harness(candidateFactory);
  assert.deepEqual(a.calls, []);
  assert.equal(a.api.isSyncing(), false); assert.equal(a.api.isPending(), false);
  a.api.setSyncPending(true); assert.equal(a.api.isPending(), true);
  assert.equal(b.api.isPending(), false);
  for (const name of methodNames) assert.equal(a.api[name].length, harness(legacyFactory).api[name].length, name);
});
currentTest('M4 controller only imports pure policy, without cloud implementation/fetch/top-level IO', () => {
  const source = readFileSync(new URL('../js/runtime/sync-status.js', import.meta.url), 'utf8');
  const imports = parseSync('sync-status.js', source).program.body.filter(node => node.type === 'ImportDeclaration');
  assert.deepEqual(imports.map(node => node.source.value), ['./sync-policy.js']);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|api\.github\.com|function\s+createGistRemoteAdapter/);
  // Calls to injected factories have their existing names, not implementations.
  assert.match(source, /export function createSyncStatus/);
});
test('original ten-body literal stays byte-bound to the independently frozen M3 oracle', () => {
  assert.equal(createHash('sha256').update(LEGACY_FUNCTIONS).digest('hex'),
    'a9c8e5395f0f3539e1b9086cda1fa3b22ffed0cf2dc043da04ca6ce737a06570');
  const old=parseSync('legacy.js',LEGACY_FUNCTIONS).program.body;
  for(const name of methodNames){
    const original=old.find(node=>node.type==='FunctionDeclaration'&&node.id.name===name);
    assert.ok(original,name);
  }
});
test('no token and PWA guard preserve original early-return order without lazy imports', async () => {
  await equivalent(async h => { h.controls.updating = true;
    assert.deepEqual(clean(await h.api.pullFromCloud(false)), { ok: false, reason: 'service_worker_update_pending' });
    assert.deepEqual(clean(await h.api.pushToCloud(false)), { ok: false, reason: 'service_worker_update_pending' });
    h.controls.updating = false; h.controls.token = '';
    assert.equal(await h.api.pushToCloud(false), undefined);
    assert.equal(h.calls.includes('lazy-cloud'), false);
  });
});
test('push success keeps exact callback order, return identity, time and UI behavior', async () => {
  await equivalent(async h => { const r = await h.api.pushToCloud(false); assert.equal(r, h.results.push);
    assert.equal(h.api.isSyncing(), false); assert.equal(h.api.isPending(), false);
    assert.ok(h.calls.indexOf('reload') > h.calls.findIndex(x => Array.isArray(x) && x[0] === 'client'));
    return r; });
});
test('pull unchanged never renders holdings/status/refresh but still records time', async () => {
  await equivalent(async h => { const r = await h.api.pullFromCloud(false); assert.equal(r,h.results.pull);
    assert.equal(h.calls.includes('holdings-render'),false); assert.equal(h.calls.includes('refresh'),false);
    assert.equal(h.controls.time,'2026-10-23T00:00:00.000Z'); return r; });
});
test('changed pull renders holdings then status then refresh with exact trace', async () => {
  await equivalent(async h => { h.results.pull.changed=true; return h.api.pullFromCloud(false); });
});
test('pending success preserves debounce scheduling and memory pending', async () => {
  await equivalent(async h => { h.results.push.pending=true; const r=await h.api.pushToCloud(true);
    assert.equal(h.api.isPending(),true); assert.equal(h.timeouts.size,1); return r; });
});
test('stored pending metadata schedules even when result pending is absent', async () => {
  await equivalent(async h => { h.controls.meta.pending_hash='b';h.controls.meta.last_push_hash='a';
    return h.api.pullFromCloud(true); });
});
test('discovery only happens without id and a missing archive exits through finally', async () => {
  await equivalent(async h => { h.controls.id=''; assert.equal(await h.api.pushToCloud(false),undefined);
    assert.equal(h.api.isSyncing(),false); h.controls.found='found-id'; return h.api.pullFromCloud(false); });
});
for (const mode of ['pull','push']) {
  for (const reason of ['remote_http_404','remote_http_401','remote_schema_future',
    'remote_schema_upgrade_required','remote_payload_invalid','remote_file_missing','remote_v3_file_truncated','other']) {
    test(mode+' preserves failure '+reason+' and pending asymmetry', async () => {
      await equivalent(async h => { h.results[mode]={ok:false,reason};
        const r=await h.api[mode==='push'?'pushToCloud':'pullFromCloud'](false);
        if(mode==='push') { assert.equal(r,h.results.push);assert.equal(h.api.isPending(),true);return r; }
        assert.equal(r,h.results.pull); assert.equal(h.api.isPending(),false); return r; });
    });
  }
}
test('unverified patched response remains unknown-style toast, never success or immediate retry', async () => {
  await equivalent(async h => { h.results.push={ok:false,reason:'remote_readback_mismatch',patched:true,remoteVerified:false};
    const r=await h.api.pushToCloud(false);assert.equal(h.timeouts.size,0);
    assert.ok(h.calls.some(x=>Array.isArray(x)&&x[1]==='云端已响应但读回验证失败，状态待确认'));return r; });
});
test('silent404 still clears id and renders status before suppressing failure toast', async () => {
  await equivalent(async h => { h.results.pull={ok:false,reason:'remote_http_404'};
    return h.api.pullFromCloud(true); });
});
test('failed reload preserves returned failure shape and does not claim sync time', async () => {
  await equivalent(async h => { h.results.reload={ok:false,reason:'synthetic-reload-failed'};
    const r=await h.api.pushToCloud(false);assert.equal(h.controls.time,'');return r; });
});
for (const mode of ['pull','push']) test(mode+' thrown adapter preserves catch/finally and pending asymmetry', async () => {
  await equivalent(async h => { h.controls.remoteThrow=new Error('synthetic-adapter-failed');
    const r=await h.api[mode==='push'?'pushToCloud':'pullFromCloud'](false);
    assert.equal(h.api.isSyncing(),false);assert.equal(h.api.isPending(),mode==='push');return r; });
});
test('live busy blocks both directions throughout a suspended lazy import and resets after completion', async () => {
  await equivalent(async h => { const gate=deferred();h.controls.loadGate=gate.promise;
    const inFlight=h.api.pushToCloud(false);assert.equal(h.api.isSyncing(),true);
    assert.equal(await h.api.pullFromCloud(false),undefined);assert.equal(await h.api.pushToCloud(false),undefined);
    gate.resolve();await inFlight;assert.equal(h.api.isSyncing(),false);return h.calls; });
});
test('PWA applying guard remains live while another sync is busy and does not cancel that sync', async () => {
  await equivalent(async h=>{const gate=deferred();h.controls.loadGate=gate.promise;
    const inFlight=h.api.pullFromCloud(false);assert.equal(h.api.isSyncing(),true);h.controls.updating=true;
    assert.deepEqual(clean(await h.api.pushToCloud(false)),{ok:false,reason:'service_worker_update_pending'});
    gate.resolve();await inFlight;assert.equal(h.api.isSyncing(),false);});
});
test('options accessor exception preserves adapter-before-option order and caught pending result', async () => {
  await equivalent(async h=>{const options={get upgradeSchema(){h.calls.push('upgrade-getter');throw new Error('synthetic-option');}};
    const result=await h.api.pushToCloud(false,options);
    assert.equal(result.reason,'synthetic-option');assert.equal(h.api.isSyncing(),false);
    assert.ok(h.calls.findIndex(x=>Array.isArray(x)&&x[0]==='local')<h.calls.indexOf('upgrade-getter'));return result;});
});
test('a throwing pending callback retains original repeated attempt and rejection identity with busy finally reset', async () => {
  await equivalent(async h=>{const sentinel=new Error('synthetic-pending');h.controls.pendingThrow=sentinel;
    h.results.push={ok:false,reason:'other'};
    await assert.rejects(()=>h.api.pushToCloud(false),error=>error===sentinel);
    assert.equal(h.calls.filter(x=>x==='pending').length,2);assert.equal(h.api.isSyncing(),false);});
});
test('device identity is read after both adapter awaits, not captured at factory time', async () => {
  await equivalent(async h => { const gate=deferred();h.controls.loadGate=gate.promise;
    const inFlight=h.api.pullFromCloud(false);h.controls.document={deviceId:'device:new'};
    gate.resolve();await inFlight;assert.ok(h.calls.some(x=>Array.isArray(x)&&x[0]==='client'&&x[2]==='device:new')); });
});
test('reset clears pending and both timers but never clears an in-flight busy flag', async () => {
  await equivalent(async h => { h.api.scheduleAutoPush();h.api.startAutoPull();
    const gate=deferred();h.controls.loadGate=gate.promise;const inFlight=h.api.pushToCloud(true);
    h.api.resetCloudState();assert.equal(h.api.isSyncing(),true);assert.equal(h.api.isPending(),false);
    assert.equal(h.timeouts.size,0);assert.equal(h.intervals.size,0);gate.resolve();await inFlight; });
});
test('debounce replacement and auto-pull interval preserve fire-and-forget timing order', async () => {
  await equivalent(async h => { h.api.scheduleAutoPush();h.api.scheduleAutoPush();h.api.startAutoPull();h.api.startAutoPull();
    assert.equal(h.timeouts.size,1);assert.equal(h.intervals.size,1);
    [...h.timeouts.values()][0]();await new Promise(done=>setImmediate(done));
    [...h.intervals.values()][0]();await new Promise(done=>setImmediate(done));h.api.resetCloudState(); });
});
test('auto pull startup checks token before lazy work and schedules only stored pending', async () => {
  await equivalent(async h => { h.controls.token='';await h.api.autoPullOnLoad();h.controls.token='synthetic-token';
    h.controls.meta.pending=true;await h.api.autoPullOnLoad(); });
});
test('status UI preserves missing element, empty and existing timestamp behavior', async () => {
  await equivalent(async h => { h.controls.noElement=true;h.api.renderCloudStatus();h.controls.noElement=false;
    h.api.renderCloudStatus();assert.equal(h.element.textContent,'配置 Token 后自动同步');
    h.controls.time='2026-10-23T00:00:00.000Z';h.api.renderCloudStatus();return h.element; });
});
test('metadata getters/errors are not normalized or silently changed', async () => {
  await equivalent(async h => { assert.equal(h.api.hasPendingSync(),false);
    h.controls.meta.pending_hash='x';h.controls.meta.last_push_hash='x';assert.equal(h.api.hasPendingSync(),false);
    h.controls.meta.pending=true;assert.equal(h.api.hasPendingSync(),true);
    const sentinel=new Error('synthetic-meta');h.controls.metaThrow=sentinel;
    assert.throws(()=>h.api.hasPendingSync(),error=>error===sentinel); });
});

