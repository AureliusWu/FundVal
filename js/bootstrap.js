import { installRuntimeGuards, runStartupIntegrityChecks } from './resilience.js';

function showStartupFailure() {
  const list = document.getElementById('fund-list');
  if (list) {
    list.innerHTML = '<div class="empty-hint">应用启动失败，请刷新页面后重试。</div>';
  }
}

try {
  await import('./migrations.js');
  runStartupIntegrityChecks();
  installRuntimeGuards();
  await import('./app.js');
} catch (_) {
  showStartupFailure();
}
