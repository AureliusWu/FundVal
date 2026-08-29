const CODE_RE = /^\d{6}$/;
const MAX_NAME_LENGTH = 120;
const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SAFE_RUNTIME_DIAGNOSTIC_TYPES = new Set([
  'storage_transaction_blocked', 'storage_recovery', 'window_error', 'unhandled_rejection',
]);
const SAFE_OCR_DIAGNOSTIC_BACKENDS = new Set(['webgpu', 'wasm', 'none']);
const SAFE_OCR_DIAGNOSTIC_CAPABILITIES = new Set(['webgpu', 'wasm_only', 'unsupported', 'unknown']);
const SAFE_OCR_DIAGNOSTIC_FALLBACK_REASONS = new Set([
  'none', 'backend_unavailable', 'initialization_failed', 'unknown',
]);
const SAFE_OCR_DIAGNOSTIC_ERRORS = new Set([
  'none', 'input_invalid', 'capability_missing', 'asset_manifest_failed',
  'webgpu_init_failed', 'wasm_init_failed', 'decode_failed', 'preprocess_failed',
  'recognition_failed', 'layout_failed', 'parse_failed', 'cancelled', 'unknown',
]);

export function safeJsonParse(raw, fallback = null) {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try { return JSON.parse(raw); }
  catch (_) { return fallback; }
}

function asNonNegativeFinite(value) {
  if (value == null || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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
  const shares = asNonNegativeFinite(item && item.shares);
  const cost = asNonNegativeFinite(item && item.cost);
  if (shares == null || cost == null) return null;
  return {
    code,
    name,
    shares,
    cost,
    updated_at: normalizedTimestamp(item && item.updated_at, fallbackTimestamp),
    deleted: item && item.deleted === true
  };
}

export function shouldReplaceHolding(current, candidate) {
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

export function mergeHoldingsByTimestamp(localItems, cloudItems, nowISO = new Date().toISOString()) {
  const local = normalizeHoldings(localItems, nowISO);
  const cloud = normalizeHoldings(cloudItems, nowISO);
  const cloudByCode = new Map(cloud.map(item => [item.code, item]));
  const localCodes = new Set(local.map(item => item.code));
  const merged = local.map(localItem => {
    const cloudItem = cloudByCode.get(localItem.code);
    return cloudItem && shouldReplaceHolding(localItem, cloudItem) ? cloudItem : localItem;
  });
  cloud.forEach(item => {
    if (!localCodes.has(item.code)) merged.push(item);
  });
  return merged;
}

function hasSemanticHoldingError(item) {
  const code = String(item && item.code || '').trim();
  if (!CODE_RE.test(code)) return false;
  return asNonNegativeFinite(item && item.shares) == null || asNonNegativeFinite(item && item.cost) == null;
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
    if (parsedPrimary.some(hasSemanticHoldingError)) {
      const latest = parseBackup(latestBackupRaw, nowISO);
      if (latest) {
        return { holdings: latest, source: 'latest_backup', recovered: true, changed: true, corruptRaw: String(primaryRaw).slice(0, 50000) };
      }
      const previous = parseBackup(previousBackupRaw, nowISO);
      if (previous) {
        return { holdings: previous, source: 'previous_backup', recovered: true, changed: true, corruptRaw: String(primaryRaw).slice(0, 50000) };
      }
      return {
        holdings: normalizeHoldings(parsedPrimary, nowISO),
        source: 'semantic_invalid',
        recovered: false,
        changed: false,
        preservePrimary: true,
        corruptRaw: String(primaryRaw).slice(0, 50000)
      };
    }
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
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '[REDACTED_IMAGE_DATA]')
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

export function selectSafeDiagnosticEvents(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  const boundedLimit = Math.max(1, Math.min(20, Number(limit) || 20));
  return value.slice(-boundedLimit).map(entry => {
    const type = String(entry && entry.type || '').trim().toLowerCase();
    return Object.freeze({
      time: typeof (entry && entry.time) === 'string' ? entry.time : '',
      type: SAFE_RUNTIME_DIAGNOSTIC_TYPES.has(type) ? type : 'unknown',
    });
  });
}

export function normalizeOcrDiagnosticForDisplay(value) {
  const backend = String(value && value.backend || '').trim().toLowerCase();
  const capabilityClass = String(value && value.capabilityClass || '').trim().toLowerCase();
  const errorCategory = String(value && value.errorCategory || '').trim().toLowerCase();
  const safeBackend = SAFE_OCR_DIAGNOSTIC_BACKENDS.has(backend) ? backend : 'unknown';
  const safeCapability = SAFE_OCR_DIAGNOSTIC_CAPABILITIES.has(capabilityClass) ? capabilityClass : 'unknown';
  const safeError = SAFE_OCR_DIAGNOSTIC_ERRORS.has(errorCategory) ? errorCategory : 'unknown';
  const fallback = value && value.fallback === true;
  const webgpuAttempted = typeof (value && value.webgpuAttempted) === 'boolean'
    ? value.webgpuAttempted
    : safeBackend === 'webgpu' || fallback;
  const fallbackReasonValue = String(value && value.fallbackReason || '').trim().toLowerCase();
  const fallbackReason = fallback
    ? (SAFE_OCR_DIAGNOSTIC_FALLBACK_REASONS.has(fallbackReasonValue) && fallbackReasonValue !== 'none'
      ? fallbackReasonValue
      : 'unknown')
    : 'none';
  const derivedInconsistent = safeBackend === 'unknown'
    || (safeBackend === 'webgpu' && (!webgpuAttempted || fallback))
    || (fallback && (!webgpuAttempted || (safeBackend !== 'wasm'
      && !(safeBackend === 'none' && safeError === 'wasm_init_failed'))))
    || (safeCapability === 'webgpu' && safeBackend === 'wasm' && !fallback)
    || (safeCapability === 'wasm_only' && (safeBackend === 'webgpu' || webgpuAttempted || fallback))
    || (safeCapability === 'unsupported' && safeBackend !== 'none')
    || (safeBackend === 'none' && safeError === 'none');
  return Object.freeze({
    backend: safeBackend,
    errorCategory: safeError,
    fallback,
    fallbackReason,
    consistency: ((value && value.consistency === 'inconsistent') || derivedInconsistent)
      ? 'inconsistent'
      : 'consistent',
  });
}
