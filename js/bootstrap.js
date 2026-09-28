import { installRuntimeGuards, runStartupIntegrityChecks } from './resilience.js';

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
  const { recoverPendingRepositoryTransaction, withHoldingsLock } = await import('./storage/holdings-repository.js');
  const { runLocalMigrations } = await import('./migrations.js');
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
  await import('./app.js');
} catch (error) {
  showStartupFailure(error?.code);
}
