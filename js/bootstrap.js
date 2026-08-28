import { installRuntimeGuards, runStartupIntegrityChecks } from './resilience.js';

function showStartupFailure() {
  const list = document.getElementById('fund-list');
  if (list) {
    list.innerHTML = '<div class="empty-hint">应用启动失败，请刷新页面后重试。</div>';
  }
}

try {
  const { recoverPendingRepositoryTransaction } = await import('./storage/holdings-repository.js');
  const recovery = recoverPendingRepositoryTransaction();
  if (!recovery.ok) throw new Error(recovery.reason || 'holdings_transaction_recovery_failed');
  const { runLocalMigrations } = await import('./migrations.js');
  const migration = runLocalMigrations();
  if (!migration.ok) throw new Error('local_migration_failed');
  const integrity = runStartupIntegrityChecks();
  window.__FUNDVAL_BOOTSTRAP_STATUS__ = Object.freeze({
    migration: 'ok',
    integrity: integrity.transactionBlocked ? 'blocked' : (integrity.recovered ? 'recovered' : 'ok'),
    cacheRepaired: Boolean(integrity.cacheRepaired),
  });
  installRuntimeGuards();
  await import('./app.js');
} catch (_) {
  showStartupFailure();
}
