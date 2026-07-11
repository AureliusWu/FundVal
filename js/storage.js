export function getCached(key, ttl, storage = localStorage, now = Date.now()) {
  try {
    const entry = JSON.parse(storage.getItem(key) || 'null');
    if (!entry || !('data' in entry) || !Number.isFinite(entry.fetchedAt)) return null;
    return { ...entry, fresh: now < (entry.expiresAt || entry.fetchedAt + ttl) };
  } catch (_) { return null; }
}

export function setCached(key, data, ttl, source, storage = localStorage, now = Date.now()) {
  const entry = { data, fetchedAt: now, expiresAt: now + ttl, source: source || 'unknown' };
  storage.setItem(key, JSON.stringify(entry));
  return entry;
}

export function isCacheFresh(entry, now = Date.now()) {
  return Boolean(entry && now < entry.expiresAt);
}

export function backupHoldings(holdings, storage = localStorage) {
  const latest = storage.getItem('fuyu_backup_latest');
  if (latest) storage.setItem('fuyu_backup_previous', latest);
  storage.setItem('fuyu_backup_latest', JSON.stringify({ created_at: new Date().toISOString(), holdings }));
}

export function parseCloudPayload(value) {
  if (Array.isArray(value)) return { schema: 1, updated_at: '', device_id: '', holdings: value };
  if (value && value.schema === 2 && Array.isArray(value.holdings)) return value;
  return { schema: 2, updated_at: '', device_id: '', holdings: [] };
}

export function makeCloudPayload(holdings, deviceId = '') {
  return { schema: 2, updated_at: new Date().toISOString(), device_id: deviceId, holdings };
}
