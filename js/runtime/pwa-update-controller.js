// The App owns editor/sync/refresh state; this controller owns update state.
// Construction is inert. Start at the App's original SW registration position.
export function createPwaUpdateController({ hasUnsavedPageInput, isSyncing, isSavingHolding,
  clearAutoRefresh, startAutoRefresh, stopAndDrain, showToast, updateIntervalMs }) {
  let pendingServiceWorker = null;
  let requestedServiceWorker = null;
  let serviceWorkerUpdateApplying = false;
  let serviceWorkerReloadPending = false;
  let serviceWorkerUpdateChannel = null;
  let reloadingForServiceWorkerUpdate = false;

  function hasServiceWorkerUpdateBlocker() {
    return hasUnsavedPageInput() || isSyncing() || isSavingHolding();
  }

  function setupServiceWorkerUpdateChannel() {
    if (typeof BroadcastChannel !== 'function') return null;
    try {
      var channel = new BroadcastChannel('fuyu_sw_update_v1');
      channel.addEventListener('message', function(event) {
        var message = event.data || {};
        if (message.type !== 'prepare' || !message.requestId || !hasServiceWorkerUpdateBlocker()) return;
        channel.postMessage({ type: 'blocked', requestId: message.requestId });
      });
      return channel;
    } catch (_) {
      return null;
    }
  }

  async function otherPageBlocksServiceWorkerUpdate() {
    if (!serviceWorkerUpdateChannel) return false;
    var requestId = 'sw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    var blocked = false;
    function onMessage(event) {
      var message = event.data || {};
      if (message.type === 'blocked' && message.requestId === requestId) blocked = true;
    }
    serviceWorkerUpdateChannel.addEventListener('message', onMessage);
    serviceWorkerUpdateChannel.postMessage({ type: 'prepare', requestId: requestId });
    await new Promise(function(resolve) { setTimeout(resolve, 450); });
    serviceWorkerUpdateChannel.removeEventListener('message', onMessage);
    return blocked;
  }

  function showServiceWorkerUpdate(worker) {
    if (worker) pendingServiceWorker = worker;
    var banner = document.getElementById('update-banner');
    var text = document.getElementById('update-banner-text');
    var button = document.getElementById('update-now-btn');
    if (!banner || !text || !button || !pendingServiceWorker) return;
    banner.hidden = false;
    text.textContent = serviceWorkerReloadPending
      ? '新版本已激活；保存当前输入后重新载入'
      : (hasServiceWorkerUpdateBlocker()
        ? (isSyncing() ? '新版本已就绪；云同步完成后即可更新' : '新版本已就绪；请先保存或清空当前输入')
        : '新版本已就绪，可安全更新');
    button.disabled = false;
    button.textContent = serviceWorkerReloadPending ? '重新载入' : '安全更新';
  }

  function handleActivatedServiceWorker(worker) {
    requestedServiceWorker = null;
    if (reloadingForServiceWorkerUpdate) return;
    if (hasServiceWorkerUpdateBlocker()) {
      serviceWorkerReloadPending = true;
      serviceWorkerUpdateApplying = false;
      pendingServiceWorker = worker || navigator.serviceWorker.controller;
      showServiceWorkerUpdate(pendingServiceWorker);
      showToast('新版本已激活；当前输入已保留，请保存后重新载入', 7000);
      return;
    }
    reloadingForServiceWorkerUpdate = true;
    pendingServiceWorker = null;
    location.reload();
  }

  async function applyPendingServiceWorkerUpdate() {
    var worker = pendingServiceWorker;
    if ((!worker && !serviceWorkerReloadPending) || serviceWorkerUpdateApplying) return;
    var text = document.getElementById('update-banner-text');
    var button = document.getElementById('update-now-btn');
    if (hasServiceWorkerUpdateBlocker()) {
      if (text) text.textContent = isSyncing()
        ? '云同步仍在进行，完成后才能安全更新'
        : '为避免丢失，请先保存或清空当前输入';
      showToast(isSyncing() ? '云同步进行中，已暂停更新' : '当前页面有未保存输入，已暂停更新');
      return;
    }

    if (!serviceWorkerReloadPending && await otherPageBlocksServiceWorkerUpdate() && !serviceWorkerReloadPending) {
      if (text) text.textContent = '其他已打开页面有未保存输入，更新已暂停';
      showToast('请先处理其他页面中的未保存输入');
      return;
    }
    if (serviceWorkerUpdateApplying) return;

    serviceWorkerUpdateApplying = true;
    clearAutoRefresh();
    if (text) text.textContent = '正在停止旧刷新任务并更新…';
    if (button) {
      button.disabled = true;
      button.textContent = '更新中';
    }
    try {
      await stopAndDrain('service-worker-update');
      if (hasServiceWorkerUpdateBlocker()) {
        serviceWorkerUpdateApplying = false;
        showServiceWorkerUpdate(worker);
        if (text) text.textContent = '检测到未保存编辑，更新仍已暂停';
        startAutoRefresh();
        return;
      }
      if (!serviceWorkerReloadPending) {
        var peerBlocked = await otherPageBlocksServiceWorkerUpdate();
        var localBlocked = hasServiceWorkerUpdateBlocker();
        if (localBlocked || peerBlocked && !serviceWorkerReloadPending) {
          serviceWorkerUpdateApplying = false;
          showServiceWorkerUpdate(worker);
          if (text) text.textContent = localBlocked
            ? '检测到未保存编辑，更新仍已暂停'
            : '其他已打开页面有未保存输入，更新已暂停';
          if (peerBlocked && !localBlocked) showToast('请先处理其他页面中的未保存输入');
          startAutoRefresh();
          return;
        }
      }
      if (serviceWorkerReloadPending) {
        handleActivatedServiceWorker(navigator.serviceWorker.controller || worker);
        return;
      }
      requestedServiceWorker = worker;
      worker.postMessage({ type: 'SKIP_WAITING' });
    } catch (_) {
      requestedServiceWorker = null;
      serviceWorkerUpdateApplying = false;
      showServiceWorkerUpdate(worker);
      if (text) text.textContent = '安全更新未完成，可稍后重试';
      startAutoRefresh();
    }
  }

  function start() {
    if ('serviceWorker' in navigator) {
      var previousServiceWorkerController = navigator.serviceWorker.controller;
      serviceWorkerUpdateChannel = setupServiceWorkerUpdateChannel();
      navigator.serviceWorker.register('sw.js').then(function(reg) {
        if (reg.waiting && navigator.serviceWorker.controller) showServiceWorkerUpdate(reg.waiting);
        reg.addEventListener('updatefound', function() {
          var newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', function() {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              showServiceWorkerUpdate(newWorker);
            }
          });
        });
        setInterval(function() { reg.update(); }, updateIntervalMs);
      }).catch(function() {});
      navigator.serviceWorker.addEventListener('message', function(event) {
        var message = event.data || {};
        if (message.type === 'UPDATE_ACTIVATED' && event.origin === location.origin
          && requestedServiceWorker && event.source === requestedServiceWorker) handleActivatedServiceWorker(event.source);
      });
      navigator.serviceWorker.addEventListener('controllerchange', function() {
        var controller = navigator.serviceWorker.controller;
        if (!controller || controller === previousServiceWorkerController) return;
        var firstInstallation = !previousServiceWorkerController;
        previousServiceWorkerController = controller;
        if (reloadingForServiceWorkerUpdate) return;
        if (firstInstallation || controller === requestedServiceWorker) {
          handleActivatedServiceWorker(controller);
        } else {
          // A native replacement affects peers without authorizing their reload.
          serviceWorkerReloadPending = true;
          pendingServiceWorker = controller;
          if (!serviceWorkerUpdateApplying) showServiceWorkerUpdate(controller);
        }
      });
    }
  }

  return { start, hasServiceWorkerUpdateBlocker, applyPendingServiceWorkerUpdate,
    isUpdateApplying: () => serviceWorkerUpdateApplying };
}
