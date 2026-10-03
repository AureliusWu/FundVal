import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as cloud from '../js/storage/cloud-sync.js';
import * as cloudRuntime from '../js/storage/cloud-runtime.js';
import * as gist from '../js/storage/gist-remote.js';
import * as gistRuntime from '../js/storage/gist-runtime.js';
import * as repository from '../js/storage/holdings-repository.js';
import * as startupRepository from '../js/storage/startup-repository.js';
import * as migrations from '../js/migrations.js';
import * as startupMigrations from '../js/startup-migrations.js';

const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const bootstrap = await readFile(new URL('../js/bootstrap.js', import.meta.url), 'utf8');
const surfaces = [
  ['cloud', cloudRuntime, cloud, [
    'synchronizeHoldingsCloud', 'pullHoldingsCloud', 'canonicalCloudPayload',
    'makeCloudWritePayload', 'finalizeCreatedArchiveState', 'finalizeCloudSyncMetadata',
  ]],
  ['gist', gistRuntime, gist, ['createGistRemoteAdapter', 'findExistingHoldingsGist', 'v3GistFilename']],
  ['repository', startupRepository, repository, ['recoverPendingRepositoryTransaction', 'withHoldingsLock']],
  ['migrations', startupMigrations, migrations, ['runLocalMigrations']],
];

test('runtime facades expose precisely the required original references', () => {
  for (const [label, facade, original, keys] of surfaces) {
    assert.deepEqual(Object.keys(facade).sort(), [...keys].sort(), label);
    for (const key of keys) assert.strictEqual(facade[key], original[key], `${label}.${key}`);
  }
  // These remain available to original consumers/tests, not to UI namespaces.
  assert.equal(typeof cloud.reconcileCloudBridgePayload, 'function');
  assert.equal(typeof cloud.requiresSchema3CloudUpgrade, 'function');
  assert.equal(typeof gist.hasHoldingsGistFile, 'function');
});

function loaderHarness(name, acquire) {
  const specs = {
    cloud: ['loadCloudSyncFeature', 'cloudSyncModulePromise', '\nfunction notificationPermissionLabel'],
    gist: ['loadGistRemoteModule', 'gistRemoteModulePromise', '\nfunction gistRequest'],
  };
  const [functionName, memo, end] = specs[name];
  const start = app.indexOf(`function ${functionName}()`);
  assert.ok(start >= 0);
  const source = app.slice(start, app.indexOf(end, start));
  assert.equal((source.match(/import\(/g) || []).length, 1);
  const seam = source.replace(/import\('\.\/storage\/(?:cloud|gist)-runtime\.js'\)/, 'acquire()');
  assert.notEqual(seam, source);
  return vm.runInNewContext(`let ${memo} = null; ${seam}; ${functionName}`, { acquire });
}

for (const name of ['cloud', 'gist']) {
  test(`${name} lazy loader preserves one shared fulfilled import Promise`, async () => {
    let calls = 0;
    const value = Object.freeze({ namespace: name });
    const originalPromise = Promise.resolve(value);
    const load = loaderHarness(name, () => { calls++; return originalPromise; });
    assert.strictEqual(load(), originalPromise);
    assert.strictEqual(load(), originalPromise);
    assert.strictEqual(await load(), value);
    assert.equal(calls, 1);
  });

  test(`${name} lazy loader retains failed import identity without an implicit retry`, async () => {
    let calls = 0;
    const error = new Error(`${name} fixture failure`);
    const originalPromise = Promise.reject(error);
    const load = loaderHarness(name, () => { calls++; return originalPromise; });
    const first = load();
    assert.strictEqual(first, originalPromise);
    assert.strictEqual(load(), first);
    await assert.rejects(first, caught => caught === error);
    assert.strictEqual(load(), first);
    await assert.rejects(load(), caught => caught === error);
    assert.equal(calls, 1);
  });
}

// Independent old bootstrap reference. Only imports are seam-injected; none of
// its recovery/migration/guard/error ordering is derived from current code.
const originalBootstrap = `
function showStartupFailure(reason) {
  const list = document.getElementById('fund-list');
  if (list) {
    const message = reason === 'future_schema_readonly'
      ? '本地持仓由较新版本创建，已保留原始数据并停止写入。请更新应用后重试。'
      : reason === 'storage_lock_unavailable'
        ? '此浏览器不支持安全持仓事务，已停止写入。请使用支持 Web Locks 的浏览器。'
        : '应用启动失败，原始持仓已保留，请刷新页面后重试。';
    list.textContent = message;
  }
}
try {
  const { recoverPendingRepositoryTransaction, withHoldingsLock } = await importModule('./storage/holdings-repository.js');
  const { runLocalMigrations } = await importModule('./migrations.js');
  const startup = await withHoldingsLock(() => {
    const recovery = recoverPendingRepositoryTransaction();
    if (!recovery.ok) return recovery;
    const migration = runLocalMigrations();
    if (!migration.ok) throw new Error('local_migration_failed');
    const integrity = runStartupIntegrityChecks();
    return { ok: true, integrity };
  });
  if (!startup.ok) throw Object.assign(new Error('startup_blocked'), { code: startup.reason });
  const { integrity } = startup;
  window.__FUNDVAL_BOOTSTRAP_STATUS__ = Object.freeze({
    migration: 'ok',
    integrity: integrity.transactionBlocked ? 'blocked' : (integrity.recovered ? 'recovered' : 'ok'),
    cacheRepaired: Boolean(integrity.cacheRepaired),
  });
  installRuntimeGuards();
  await importModule('./app.js');
} catch (error) {
  showStartupFailure(error?.code);
}`;

const currentBootstrap = bootstrap
  .replace(/^import \{ installRuntimeGuards, runStartupIntegrityChecks \} from '\.\/resilience\.js';\r?\n/, '')
  .replace(/import\(/g, 'importModule(');

async function runBootstrap(source, scenario) {
  const trace = [];
  const window = {};
  const list = { textContent: '' };
  const error = Object.assign(new Error('fixture failure'), { code: scenario.errorCode });
  const sandbox = {
    window,
    document: { getElementById(id) { trace.push(`element:${id}`); return list; } },
    runStartupIntegrityChecks() {
      trace.push('integrity');
      if (scenario.fail === 'integrity') throw error;
      return scenario.integrity || { cacheRepaired: true };
    },
    installRuntimeGuards() { trace.push('guards'); if (scenario.fail === 'guards') throw error; },
    async importModule(path) {
      const phase = path.includes('repository') ? 'repository' : path.includes('migrations') ? 'migrations' : 'app';
      trace.push(`import:${phase}`);
      if (scenario.fail === `import:${phase}`) throw error;
      return {
        async withHoldingsLock(callback) {
          if (scenario.realLock) {
            const withLock = path.endsWith('/startup-repository.js')
              ? startupRepository.withHoldingsLock : repository.withHoldingsLock;
            return withLock(callback, { locks: scenario.missingLock ? null : {
              async request(name, options, operation) {
                assert.equal(name, repository.HOLDINGS_LOCK_NAME);
                assert.deepEqual(options, { mode: 'exclusive' });
                trace.push('lock');
                if (scenario.fail === 'lock') throw error;
                try { return await operation({ name }); } finally { trace.push('unlock'); }
              },
            } });
          }
          trace.push('lock');
          if (scenario.fail === 'lock') throw error;
          try { return callback(); } finally { trace.push('unlock'); }
        },
        recoverPendingRepositoryTransaction() {
          trace.push('recovery');
          if (scenario.fail === 'recovery') throw error;
          return scenario.recovery || { ok: true };
        },
        runLocalMigrations() {
          trace.push('migration');
          if (scenario.fail === 'migration') throw error;
          return { ok: scenario.migrationOk !== false };
        },
      };
    },
  };
  await vm.runInNewContext(`(async () => { ${source} })()`, sandbox);
  const status = window.__FUNDVAL_BOOTSTRAP_STATUS__;
  return { trace, message: list.textContent, status: status ? JSON.parse(JSON.stringify(status)) : null,
    frozenStatus: Boolean(status && Object.isFrozen(status)) };
}

test('startup facade paths preserve recovery, integrity, app and every failed-phase ordering', async () => {
  const scenarios = [
    {}, { integrity: { recovered: true, cacheRepaired: false } },
    { integrity: { transactionBlocked: true, cacheRepaired: true } },
    { recovery: { ok: false, reason: 'future_schema_readonly' } },
    { recovery: { ok: false, reason: 'storage_lock_unavailable' } },
    { migrationOk: false },
    ...['import:repository', 'import:migrations', 'import:app', 'lock', 'recovery', 'migration', 'integrity', 'guards']
      .map(fail => ({ fail })),
    { fail: 'lock', errorCode: 'storage_lock_unavailable' },
  ];
  for (const scenario of scenarios) {
    assert.deepEqual(await runBootstrap(currentBootstrap, scenario), await runBootstrap(originalBootstrap, scenario),
      JSON.stringify(scenario));
  }
  assert.deepEqual((await runBootstrap(currentBootstrap, {})).trace,
    ['import:repository', 'import:migrations', 'lock', 'recovery', 'migration', 'integrity', 'unlock', 'guards', 'import:app']);
});

test('bootstrap uses the real lock wrapper through the facade, including failure conversion', async () => {
  for (const scenario of [{}, { missingLock: true }, { fail: 'lock' }, { fail: 'migration' },
    { migrationOk: false }, { fail: 'integrity' }, { recovery: { ok: false, reason: 'future_schema_readonly' } }]) {
    const options = { ...scenario, realLock: true };
    assert.deepEqual(await runBootstrap(currentBootstrap, options), await runBootstrap(originalBootstrap, options));
  }
  const failed = await runBootstrap(currentBootstrap, { realLock: true, fail: 'migration' });
  assert.equal(failed.status, null);
  assert.equal(failed.trace.includes('guards'), false);
  assert.equal(failed.trace.includes('import:app'), false);
  assert.equal(failed.message, '应用启动失败，原始持仓已保留，请刷新页面后重试。');
});

test('only dynamic namespace targets change; original static domain consumers remain', async () => {
  assert.match(app, /import\('\.\/storage\/cloud-runtime\.js'\)/);
  assert.match(app, /import\('\.\/storage\/gist-runtime\.js'\)/);
  assert.match(app, /from '\.\/storage\/holdings-repository\.js'/);
  const adapter = await readFile(new URL('../js/storage/gist-remote.js', import.meta.url), 'utf8');
  assert.match(adapter, /from '\.\/cloud-sync\.js'/);
  const worker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  for (const path of ['js/storage/cloud-runtime.js', 'js/storage/gist-runtime.js',
    'js/storage/startup-repository.js', 'js/startup-migrations.js']) assert.ok(worker.includes(`'./${path}'`), path);
});
