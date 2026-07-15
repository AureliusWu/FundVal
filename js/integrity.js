const CODE_RE = /^\d{6}$/;
const MAX_NAME_LENGTH = 120;
const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function safeJsonParse(raw, fallback = null) {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try { return JSON.parse(raw); }
  catch (_) { return fallback; }
}

function asNonNegativeFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizedTimestamp(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function normalizedHolding(item, fallbackTimestamp) {
  const code = String(item && item.code || '').trim();
  if (!CODE_RE.test(code)) return null;
  const name = String(item && item.name || code).trim().slice(0, MAX_NAME_LENGTH) || code;
  return {
    code,
    name,
    shares: asNonNegativeFinite(item && item.shares),
    cost: asNonNegativeFinite(item && item.cost),
    updated_at: normalizedTimestamp(item && item.updated_at, fallbackTimestamp),
    deleted: item && item.deleted === true
  };
}

function shouldReplaceHolding(current, candidate) {
  if (!current) return true;
  if (candidate.updated_at > current.updated_at) return true;
  if (candidate.updated_at < current.updated_at) return false;
  if (candidate.deleted !== current.deleted) return candidate.deleted;
  return true;
}

export function normalizeHoldings(value, nowISO = new Date().toISOString()) {
  if (!Array.isArray(value)) return [];
  const byCode = new Map();
  for (const item of value) {
    const normalized = normalizedHolding(item, nowISO);
    if (!normalized) continue;
    const current = byCode.get(normalized.code);
    if (shouldReplaceHolding(current, normalized)) byCode.set(normalized.code, normalized);
  }
  return [...byCode.values()];
}

function parseBackup(raw, nowISO) {
  const parsed = safeJsonParse(raw, null);
  if (!parsed || !Array.isArray(parsed.holdings)) return null;
  return normalizeHoldings(parsed.holdings, nowISO);
}

export function repairHoldingsState({ primaryRaw, latestBackupRaw, previousBackupRaw, nowISO = new Date().toISOString() }) {
  if (primaryRaw == null || primaryRaw === '') {
    return { holdings: [], source: 'empty', recovered: false, changed: false, corruptRaw: '' };
  }

  const parsedPrimary = safeJsonParse(primaryRaw, null);
  if (Array.isArray(parsedPrimary)) {
    const holdings = normalizeHoldings(parsedPrimary, nowISO);
    return {
      holdings,
      source: 'primary',
      recovered: false,
      changed: JSON.stringify(holdings) !== JSON.stringify(parsedPrimary),
      corruptRaw: ''
    };
  }

  const latest = parseBackup(latestBackupRaw, nowISO);
  if (latest) {
    return { holdings: latest, source: 'latest_backup', recovered: true, changed: true, corruptRaw: String(primaryRaw).slice(0, 50000) };
  }

  const previous = parseBackup(previousBackupRaw, nowISO);
  if (previous) {
    return { holdings: previous, source: 'previous_backup', recovered: true, changed: true, corruptRaw: String(primaryRaw).slice(0, 50000) };
  }

  return { holdings: [], source: 'unrecoverable', recovered: true, changed: true, corruptRaw: String(primaryRaw).slice(0, 50000) };
}

function normalizeCacheTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function reconcileFundCache(rawCache, activeCodes, now = Date.now(), futureSkewMs = DEFAULT_FUTURE_SKEW_MS) {
  const parsed = typeof rawCache === 'string' ? safeJsonParse(rawCache, null) : rawCache;
  if (!parsed || !Array.isArray(parsed.data)) return { cache: null, changed: Boolean(rawCache), remove: true };

  const fetchedAt = normalizeCacheTimestamp(parsed.fetchedAt || parsed.time);
  if (!fetchedAt || fetchedAt > now + futureSkewMs) return { cache: null, changed: true, remove: true };

  const allowed = activeCodes instanceof Set ? activeCodes : new Set(activeCodes || []);
  const seen = new Set();
  const data = [];
  for (const item of parsed.data) {
    const code = String(item && item.code || '').trim();
    if (!CODE_RE.test(code) || !allowed.has(code) || seen.has(code)) continue;
    seen.add(code);
    data.push(item);
  }

  if (!data.length) return { cache: null, changed: true, remove: true };

  const expiresAt = normalizeCacheTimestamp(parsed.expiresAt) || fetchedAt;
  const cache = {
    ...parsed,
    data,
    fetchedAt,
    expiresAt: Math.max(fetchedAt, expiresAt)
  };
  return {
    cache,
    changed: JSON.stringify(cache) !== JSON.stringify(parsed),
    remove: false
  };
}

export function collectOrphanNavCacheKeys(keys, activeCodes) {
  const allowed = activeCodes instanceof Set ? activeCodes : new Set(activeCodes || []);
  return [...keys].filter(key => {
    const match = /^fuyu_nav_move_(\d{6})$/.exec(String(key));
    return Boolean(match && !allowed.has(match[1]));
  });
}

export function redactDiagnosticText(value) {
  return String(value || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(authorization\s*[:=]\s*)(?:token|bearer)\s+[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|access_token)=)[^&#\s]+/gi, '$1[REDACTED]')
    .slice(0, 4000);
}

export function appendDiagnostic(raw, entry, limit = 20) {
  const parsed = safeJsonParse(raw, []);
  const list = Array.isArray(parsed) ? parsed : [];
  const sanitized = {
    time: typeof entry.time === 'string' ? entry.time : new Date().toISOString(),
    type: redactDiagnosticText(entry.type).slice(0, 80),
    message: redactDiagnosticText(entry.message),
    stack: redactDiagnosticText(entry.stack)
  };
  return [...list, sanitized].slice(-Math.max(1, limit));
}
