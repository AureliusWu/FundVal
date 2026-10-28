// Independent explicit M5 delta allowed by the scoped lifecycle fix. The
// legacy compatibility harness may remove only this exact statement. Full
// runtime regression tests import the original controller, not this view.
export const m5PostDrainPeerGuard = `if (!serviceWorkerReloadPending) {
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
      }`;
export const m5PostDrainPeerGuardSha256 = '2176e479eb1dd5866bd0328cf02893bfc4ac248781b185281533fa7b24c008a6';
