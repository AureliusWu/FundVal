// Same-origin, on-demand fund catalog loader.
// The Pages build creates data/fund-catalog.json from an upstream data file;
// the browser never executes an upstream JSONP script and never sends images.

export const FUND_CATALOG_PATH = new URL('../data/fund-catalog.json', import.meta.url).href;
export const FUND_CATALOG_ERROR_MESSAGE = '基金目录暂不可用，请稍后重试';

const CODE_RE = /^\d{6}$/;
const pendingLoads = new Map();

function text(value) {
  return String(value == null ? '' : value).trim();
}

function defaultFetch() {
  return typeof fetch === 'function' ? fetch.bind(globalThis) : null;
}

function defaultLocation() {
  return typeof location === 'undefined' ? null : location;
}

function timeoutValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000;
}

function entryFromRow(row) {
  const array = Array.isArray(row) ? row : null;
  const code = text(array ? array[0] : row && (row.code ?? row.fundCode));
  // Eastmoney raw rows use [code, shortPinyin, ChineseName, category, fullPinyin].
  const name = text(array ? array[2] : row && (row.name ?? row.fundName));
  const pinyin = text(array ? (array[4] || array[1]) : row && row.pinyin);
  if (!CODE_RE.test(code) || !name) return null;
  return { code, name, pinyin };
}

/** Keep only fund identity fields; OCR data never belongs in the catalogue. */
export function normalizeFundCatalog(raw) {
  if (!Array.isArray(raw)) throw new FundCatalogError();
  const seen = new Set();
  const catalog = [];
  for (const row of raw) {
    const entry = entryFromRow(row);
    if (!entry || seen.has(entry.code)) continue;
    seen.add(entry.code);
    catalog.push(entry);
  }
  if (raw.length && !catalog.length) throw new FundCatalogError();
  return catalog;
}

export function normalizeFundCatalogQuery(value) {
  return text(value)
    .replace(/[（）]/g, character => character === '（' ? '(' : ')')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** A small local search helper for a confirmation-page fund picker. */
export function findFundCatalogMatches(catalog, query, limit = 8) {
  const needle = normalizeFundCatalogQuery(query);
  if (!needle) return [];
  const maximum = Math.max(1, Math.min(50, Number.isFinite(Number(limit)) ? Number(limit) : 8));
  const entries = normalizeFundCatalog(Array.isArray(catalog) ? catalog : []);
  const scored = entries.map(entry => {
    const normalizedName = normalizeFundCatalogQuery(entry.name);
    const normalizedPinyin = normalizeFundCatalogQuery(entry.pinyin);
    let score = 0;
    if (entry.code === needle) score = 100;
    else if (normalizedName === needle) score = 90;
    else if (normalizedPinyin === needle) score = 80;
    else if (entry.code.startsWith(needle)) score = 60;
    else if (normalizedName.startsWith(needle)) score = 50;
    else if (normalizedName.includes(needle) || normalizedPinyin.includes(needle)) score = 40;
    return { entry, score };
  }).filter(item => item.score > 0);
  return scored
    .sort((left, right) => right.score - left.score || left.entry.code.localeCompare(right.entry.code))
    .slice(0, maximum)
    .map(item => ({ ...item.entry }));
}

export class FundCatalogError extends Error {
  constructor() {
    super(FUND_CATALOG_ERROR_MESSAGE);
    this.name = 'FundCatalogError';
    this.code = 'FUND_CATALOG_UNAVAILABLE';
  }
}

function sameOriginUrl(value, locationRef) {
  try {
    const parsed = new URL(value);
    if (locationRef && locationRef.origin && parsed.origin !== locationRef.origin) return null;
    return parsed.href;
  } catch (_) {
    return null;
  }
}

function loadWithTimeout(fetchFn, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { controller?.abort(); } catch (_) { /* best effort */ }
      finish(reject, new FundCatalogError());
    }, timeoutMs);
    Promise.resolve(fetchFn(url, {
      method: 'GET',
      credentials: 'same-origin',
      signal: controller?.signal,
      headers: { Accept: 'application/json' },
    })).then(async response => {
      if (!response || !response.ok || typeof response.json !== 'function') throw new FundCatalogError();
      const catalog = normalizeFundCatalog(await response.json());
      finish(resolve, catalog);
    }).catch(() => finish(reject, new FundCatalogError()));
  });
}

/**
 * Fetch the generated same-origin catalog only when an OCR confirmation flow
 * needs it. The request carries no screenshot, OCR text, holding data or ID.
 */
export function loadFundCatalog(options = {}) {
  const locationRef = options.locationRef || defaultLocation();
  const url = sameOriginUrl(options.url || FUND_CATALOG_PATH, locationRef);
  const fetchFn = options.fetchFn || defaultFetch();
  if (!url || typeof fetchFn !== 'function') return Promise.reject(new FundCatalogError());
  const existing = pendingLoads.get(url);
  if (existing) return existing;
  const promise = loadWithTimeout(fetchFn, url, timeoutValue(options.timeoutMs));
  pendingLoads.set(url, promise);
  promise.then(
    () => pendingLoads.delete(url),
    () => pendingLoads.delete(url)
  );
  return promise;
}
