// Loaded only by packaged FundVal documents, never by the public PWA.
(() => {
  'use strict';
  const root = document.documentElement;
  if (root.dataset.fundvalPlatform !== 'android' || window.top !== window
    || location.origin !== 'https://aureliuswu.github.io'
    || !['/FundVal/', '/FundVal/index.html', '/FundVal/ocr-import.html'].includes(location.pathname)) return;

  const keys = Object.freeze([
    'fuyu_holdings_v3', 'fuyu_holdings_v1', 'fuyu_device_id_v1',
    'fuyu_holdings_repository_backup_latest_v1', 'fuyu_holdings_repository_backup_previous_v1',
    'fuyu_holdings_repository_journal_v1', 'fuyu_holdings_projection_meta_v1',
    'fuyu_backup_latest', 'fuyu_backup_previous',
  ]);
  const SNAPSHOT_BYTES = 8 * 1024 * 1024;
  const WIRE_BYTES = SNAPSHOT_BYTES + 2048;
  const EXPORT_BYTES = 4 * 1024 * 1024;
  const TIMEOUT_MS = 12000;
  const encoder = new TextEncoder();
  const bytes = text => encoder.encode(text).length;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const bounded = (text, limit) => typeof text === 'string' && text.length <= limit && bytes(text) <= limit;
  const failure = (reason, recoveryRequired = false) => ({ ok: false, reason, document: null, legacy: [], recoveryRequired });

  let port = null;
  let nonce = null;
  let nextId = 0;
  let exportActive = false;
  const waiters = new Set();
  const requests = new Map();

  function finishRequest(id, value) {
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    clearTimeout(request.timer);
    request.resolve(value);
  }

  function closePort() {
    const previous = port;
    port = null;
    try { previous?.close(); } catch (_) { /* Closed already. */ }
    for (const id of requests.keys()) finishRequest(id, null);
  }

  function ready() {
    if (port) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error('android_bridge_unavailable'));
      }, TIMEOUT_MS);
      waiters.add(waiter);
    });
  }

  function arm(value) {
    // Called by the native committed-document hook. A one-time challenge
    // permits the actual native "null" source origin on older WebViews without
    // accepting postMessage from the sandbox iframe (which has a WindowProxy).
    if (typeof value !== 'string'
      || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)) return false;
    closePort();
    nonce = value;
    return true;
  }

  window.addEventListener('message', event => {
    if (!nonce || !event.isTrusted || event.source !== null || !['', 'null', location.origin].includes(event.origin)
      || event.data !== `fundval-android-v2:${nonce}` || event.ports?.length !== 1) return;
    nonce = null;
    closePort();
    const bound = event.ports[0];
    port = bound;
    bound.onmessage = ({ data }) => {
      if (port !== bound || !bounded(data, WIRE_BYTES)) return;
      try {
        const response = JSON.parse(data);
        if (!response || !Number.isInteger(response.id) || typeof response.ok !== 'boolean') return;
        finishRequest(response.id, response);
      } catch (_) { /* Unmatched or malformed replies cannot acknowledge a write. */ }
    };
    bound.onmessageerror = () => { if (port === bound) closePort(); };
    for (const waiter of waiters) waiter();
    waiters.clear();
  });

  async function request(op, payload = {}) {
    try { await ready(); } catch (_) { return null; }
    if (!port || nextId >= 2147483647) return null;
    const id = ++nextId;
    const wire = JSON.stringify({ id, op, ...payload });
    if (!bounded(wire, WIRE_BYTES)) return null;
    return new Promise(resolve => {
      // A person may leave the system file picker open. Only repository I/O
      // times out; the export is ended by the picker reply or a closed port.
      const timer = op === 'export' ? undefined : setTimeout(() => finishRequest(id, null), TIMEOUT_MS);
      requests.set(id, { resolve, timer });
      try { port.postMessage(wire); } catch (_) { finishRequest(id, null); }
    });
  }

  function validSnapshot(snapshot) {
    return snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
      && Object.keys(snapshot).length === keys.length
      && keys.every(key => own(snapshot, key) && (snapshot[key] === null || typeof snapshot[key] === 'string'))
      && bounded(JSON.stringify(snapshot), SNAPSHOT_BYTES);
  }

  function capture() {
    return Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]));
  }

  function sameSnapshot(left, right) {
    return keys.every(key => left[key] === right[key]);
  }

  function restore(snapshot) {
    try {
      for (const key of keys) {
        if (localStorage.getItem(key) === snapshot[key]) continue;
        if (snapshot[key] === null) localStorage.removeItem(key);
        else localStorage.setItem(key, snapshot[key]);
      }
      return sameSnapshot(capture(), snapshot);
    } catch (_) { return false; }
  }

  function newerSchema(snapshot) {
    // Never overwrite a future local document or journal during a downgrade.
    const parse = raw => { try { return JSON.parse(raw); } catch (_) { return null; } };
    const journal = parse(snapshot.fuyu_holdings_repository_journal_v1);
    return [snapshot.fuyu_holdings_v3, snapshot.fuyu_holdings_v1,
      journal?.previous?.v3Raw, journal?.previous?.v1Raw, journal?.next?.v3Raw, journal?.next?.v1Raw]
      .some(raw => {
        const schema = Number(parse(raw)?.schema);
        return Number.isSafeInteger(schema) && schema > 3;
      });
  }

  // The caller holds the real origin-wide Web Lock. Native state is the
  // durability authority; WebView storage is only a synchronous projection.
  async function withDurableHoldings(callback, validate) {
    if (typeof callback !== 'function' || typeof validate !== 'function') return failure('android_store_invalid');
    let initial, previous;
    const rollback = (reason, ambiguous = false) => {
      const restored = previous ? restore(previous) : true;
      return failure(restored ? reason : 'android_store_projection_failed', ambiguous || !restored);
    };
    try {
      const read = await request('read');
      if (!read?.ok || !Number.isSafeInteger(read.generation) || read.generation < 0) {
        return failure('android_store_unavailable', true);
      }
      initial = capture();
      if (newerSchema(initial)) return failure('future_schema_readonly');
      if (read.generation === 0) {
        if (read.snapshot !== null) return failure('android_store_invalid', true);
        previous = initial;
      } else {
        if (!validSnapshot(read.snapshot) || validate(read.snapshot) !== true) return failure('android_store_invalid', true);
        if (!restore(read.snapshot)) {
          restore(initial);
          return failure('android_store_projection_failed', true);
        }
        previous = read.snapshot;
      }

      const result = await callback();
      const snapshot = capture();
      const changed = !sameSnapshot(snapshot, previous);
      if (result == null || result === false || result.ok === false || result.integrity?.transactionBlocked) {
        // Do not let a failed callback return a candidate it changed but did
        // not durably commit. Ordinary conflicts can return confirmed data.
        return changed ? rollback(result?.reason || 'android_store_transaction_failed', result?.recoveryRequired === true) : result;
      }
      if (!validSnapshot(snapshot) || validate(snapshot) !== true) return rollback('android_store_invalid');
      if (!changed && read.generation > 0) return result;

      const committed = await request('commit', { generation: read.generation, snapshot });
      if (committed?.ok !== true || committed.generation !== read.generation + 1) {
        // Native might have committed before a lost response. Never send a
        // compensating write; the next locked operation must re-read native.
        return rollback('android_store_commit_failed', true);
      }
      return result;
    } catch (_) {
      return rollback('android_store_transaction_failed', true);
    }
  }

  async function exportHoldings(contents) {
    if (exportActive || !contents || !bounded(contents, EXPORT_BYTES)) return 'failed';
    exportActive = true;
    try {
      const reply = await request('export', { contents });
      if (reply?.status === 'cancelled') return 'cancelled';
      return reply?.ok === true && reply.status === 'saved' ? 'saved' : 'failed';
    } catch (_) { return 'failed'; }
    finally { exportActive = false; }
  }

  Object.defineProperty(window, 'FundValAndroid', {
    value: Object.freeze({ arm, ready, withDurableHoldings, exportHoldings }), configurable: false, writable: false,
  });
})();
