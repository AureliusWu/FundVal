export function safeGetItem(key, storage = localStorage) {
  try { return storage.getItem(key); }
  catch (_) { return null; }
}

export function safeSetItem(key, value, storage = localStorage) {
  try { storage.setItem(key, value); return true; }
  catch (_) { return false; }
}

export function safeRemoveItem(key, storage = localStorage) {
  try { storage.removeItem(key); return true; }
  catch (_) { return false; }
}

export function getCached(key, ttl, storage = localStorage, now = Date.now()) {
  try {
    const entry = JSON.parse(safeGetItem(key, storage) || 'null');
    if (!entry || !('data' in entry) || !Number.isFinite(entry.fetchedAt)) return null;
    const expiresAt = Number.isFinite(entry.expiresAt) ? entry.expiresAt : entry.fetchedAt + ttl;
    return { ...entry, expiresAt, fresh: now < expiresAt };
  } catch (_) { return null; }
}

export function setCached(key, data, ttl, source, storage = localStorage, now = Date.now()) {
  const entry = { data, fetchedAt: now, expiresAt: now + ttl, source: source || 'unknown' };
  return safeSetItem(key, JSON.stringify(entry), storage) ? entry : null;
}

export function isCacheFresh(entry, now = Date.now()) {
  return Boolean(entry && Number.isFinite(entry.expiresAt) && now < entry.expiresAt);
}

export function backupHoldings(holdings, storage = localStorage) {
  try {
    const latest = safeGetItem('fuyu_backup_latest', storage);
    if (latest) safeSetItem('fuyu_backup_previous', latest, storage);
    return safeSetItem('fuyu_backup_latest', JSON.stringify({
      created_at: new Date().toISOString(),
      holdings: Array.isArray(holdings) ? holdings : []
    }), storage);
  } catch (_) { return false; }
}

export function parseCloudPayload(value) {
  if (Array.isArray(value)) return { schema: 1, updated_at: '', device_id: '', holdings: value };
  if (value && Number(value.schema) >= 2 && Array.isArray(value.holdings)) {
    return {
      ...value,
      schema: Number(value.schema),
      updated_at: typeof value.updated_at === 'string' ? value.updated_at : '',
      device_id: typeof value.device_id === 'string' ? value.device_id : '',
      holdings: value.holdings
    };
  }
  return { schema: 2, updated_at: '', device_id: '', holdings: [] };
}

export function makeCloudPayload(holdings, deviceId = '') {
  return {
    schema: 2,
    updated_at: new Date().toISOString(),
    device_id: String(deviceId || ''),
    holdings: Array.isArray(holdings) ? holdings.map(item => ({ ...item })) : []
  };
}
