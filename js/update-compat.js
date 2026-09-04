(function installLegacyUpdateActionBridge() {
  'use strict';

  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;

  document.addEventListener('click', function handleLegacyUpdateAction(event) {
    var source = event && event.target;
    var button = source && typeof source.closest === 'function'
      ? source.closest('#update-now-btn[data-action="apply-update"]')
      : null;
    if (!button) return;

    var legacyApply = Object.prototype.hasOwnProperty.call(globalThis, 'applyPendingServiceWorkerUpdate')
      ? globalThis.applyPendingServiceWorkerUpdate
      : null;
    if (typeof legacyApply !== 'function') return;

    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    try {
      var result = legacyApply();
      if (result && typeof result.catch === 'function') result.catch(function ignoreLegacyFailure() {});
    } catch (_) {
      // The legacy app owns retry messaging and remains in control of its waiting worker.
    }
  });
})();
