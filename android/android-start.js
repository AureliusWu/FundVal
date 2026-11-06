// Allow the document to finish loading before waiting for the native port.
// A top-level await in a module loaded before onPageFinished can deadlock.
(() => {
  'use strict';
  const path = location.pathname;
  const entry = path === '/FundVal/ocr-import.html' ? './js/ocr-import-page.js'
    : (path === '/FundVal/' || path === '/FundVal/index.html' ? './js/app-shell.js' : null);
  if (!entry || document.documentElement.dataset.fundvalPlatform !== 'android') return;
  const start = async () => {
    try {
      await window.FundValAndroid.ready();
      await import(entry);
    } catch (_) {
      const status = document.getElementById('fund-list') || document.getElementById('ocr-import-status');
      if (status) status.textContent = 'Android 本地存储暂不可用，已停止写入。请重新打开应用。';
      for (const control of document.querySelectorAll('#ocr-image-input, #ocr-import-pick')) control.disabled = true;
    }
  };
  if (document.readyState === 'complete') void start();
  else window.addEventListener('load', start, { once: true });
})();
