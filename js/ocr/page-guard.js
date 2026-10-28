// Lightweight independent-page guard. No App, service-worker registration,
// screenshot, OCR text or holding data is sent through this channel.
export function createOcrPageGuard({ window, hasPendingWork, isSaving, discard, navigate, notify, restored }) {
  let started = false, attached = false, channel = null;
  const viewport = window.visualViewport;
  const style = window.document.documentElement.style;
  function updateViewport() {
    if (Number.isFinite(viewport?.height) && viewport.height > 0 && Number.isFinite(viewport.offsetTop) && viewport.offsetTop >= 0) {
      style.setProperty('--ocr-viewport-height', `${viewport.height}px`);
      style.setProperty('--ocr-viewport-top', `${viewport.offsetTop}px`);
    }
  }
  function beforeUnload(event) {
    if (!hasPendingWork()) return;
    event.preventDefault(); event.returnValue = '';
  }
  function focusInput(event) {
    const target = event.target;
    if (!target?.matches?.('input:not([type="checkbox"]), select')) return;
    window.requestAnimationFrame(() => {
      if (attached && window.document.activeElement === target) target.scrollIntoView({ block: 'nearest' });
    });
  }
  function prepareUpdate(event) {
    const message = event.data;
    if (message?.type === 'prepare' && typeof message.requestId === 'string'
      && /^sw-[a-zA-Z0-9-]{1,90}$/.test(message.requestId) && hasPendingWork()) {
      channel?.postMessage({ type: 'blocked', requestId: message.requestId });
    }
  }
  function resume() {
    if (attached) return;
    attached = true;
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('resize', updateViewport);
    window.document.addEventListener('focusin', focusInput);
    viewport?.addEventListener('resize', updateViewport);
    viewport?.addEventListener('scroll', updateViewport);
    try {
      if (typeof window.BroadcastChannel === 'function') {
        channel = new window.BroadcastChannel('fuyu_sw_update_v1');
        channel.addEventListener('message', prepareUpdate);
      }
    } catch (_) { channel = null; }
    updateViewport();
  }
  function suspend() {
    if (!attached) return;
    attached = false;
    window.removeEventListener('beforeunload', beforeUnload);
    window.removeEventListener('resize', updateViewport);
    window.document.removeEventListener('focusin', focusInput);
    viewport?.removeEventListener('resize', updateViewport);
    viewport?.removeEventListener('scroll', updateViewport);
    channel?.close(); channel = null;
  }
  function pageHide() { suspend(); discard(); }
  function pageShow(event) { if (event.persisted) { resume(); restored(); } }
  return {
    start() {
      if (started) return;
      started = true;
      window.addEventListener('pagehide', pageHide);
      window.addEventListener('pageshow', pageShow);
      resume();
    },
    requestLeave() {
      if (isSaving()) { notify('正在安全保存持仓，请稍候再离开。'); return false; }
      if (hasPendingWork() && !window.confirm('当前识别或确认结果尚未保存。放弃本次截图导入并离开？')) return false;
      discard(); navigate(); return true;
    },
    dispose() {
      if (!started) return;
      started = false; suspend();
      window.removeEventListener('pagehide', pageHide);
      window.removeEventListener('pageshow', pageShow);
    },
  };
}
