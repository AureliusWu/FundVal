const PAGE = 'fuyuPageNavigation';
const valid = name => name === 'market' || name === 'edit';

// History contains panel identity only. Drafts and holdings remain with their
// existing owners; changing a panel never clears or serializes either one.
export function createPageNavigation({ window: win = globalThis.window, showPage } = {}) {
  let started = false, active = 'market', backPending = false;
  const history = win?.history;
  const supported = typeof history?.pushState === 'function' && typeof history?.replaceState === 'function'
    && typeof history?.back === 'function' && typeof win?.addEventListener === 'function';
  const url = () => new URL(win.location.href);
  const pageFromUrl = () => { try { return url().hash === '#edit' ? 'edit' : 'market'; } catch (_) { return 'market'; } };
  const ownedEdit = () => { try { return history.state?.[PAGE] === 'edit'; } catch (_) { return false; } };
  const show = name => { active = name; showPage(name); };
  const pop = () => { backPending = false; show(pageFromUrl()); };
  function start() {
    if (started) return;
    started = true;
    if (!supported) return;
    win.addEventListener('popstate', pop);
    const initial = pageFromUrl();
    if (initial === 'edit' && !ownedEdit()) {
      try {
        const edit = url(), market = new URL(edit); market.hash = '';
        history.replaceState({ [PAGE]: 'market' }, '', market.href);
        history.pushState({ [PAGE]: 'edit' }, '', edit.href);
      } catch (_) { /* History denial must not prevent ordinary panel use. */ }
    }
    if (initial === 'edit') show('edit');
  }
  return Object.freeze({
    start,
    navigate(name) {
      if (!valid(name)) return false;
      start();
      if (name === active) return true;
      if (supported) {
        try {
          if (name === 'market' && ownedEdit()) {
            if (backPending) return true;
            backPending = true; history.back(); return true;
          }
          const next = url(); next.hash = name === 'edit' ? 'edit' : '';
          history.pushState({ [PAGE]: name }, '', next.href);
        } catch (_) { backPending = false; /* Keep the existing no-history navigation fallback. */ }
      }
      show(name); return true;
    },
    dispose() {
      if (started && supported) win.removeEventListener?.('popstate', pop);
      started = false; backPending = false;
    },
  });
}
