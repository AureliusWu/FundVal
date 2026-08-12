import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EASTMONEY_FUND_CATALOG_SOURCE = 'https://fund.eastmoney.com/js/fundcode_search.js';

function text(value) {
  return String(value == null ? '' : value).trim();
}

/** Parse the upstream data assignment without evaluating third-party code. */
export function parseEastmoneyFundCatalogScript(source) {
  const raw = text(source);
  const declaration = raw.indexOf('var r');
  const start = declaration >= 0 ? raw.indexOf('[', declaration) : -1;
  if (start < 0) throw new Error('Fund catalog source is malformed.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) { end = index; break; }
    }
  }
  if (end < start || depth !== 0) throw new Error('Fund catalog source is malformed.');
  const rows = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(rows)) throw new Error('Fund catalog source is malformed.');
  const seen = new Set();
  const catalog = [];
  for (const row of rows) {
    const code = text(Array.isArray(row) ? row[0] : '');
    // Eastmoney raw rows use [code, shortPinyin, ChineseName, category, fullPinyin].
    const name = text(Array.isArray(row) ? row[2] : '');
    const pinyin = text(Array.isArray(row) ? (row[4] || row[1]) : '');
    if (!/^\d{6}$/.test(code) || !name || seen.has(code)) continue;
    seen.add(code);
    catalog.push({ code, name, pinyin });
  }
  if (!catalog.length) throw new Error('Fund catalog source contains no valid funds.');
  return catalog;
}

export async function refreshFundCatalog({ fetchFn = fetch, targetPath } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('Fund catalog fetch is unavailable.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const target = resolve(targetPath || resolve(root, 'data', 'fund-catalog.json'));
  if (target !== resolve(root, 'data', 'fund-catalog.json')) throw new Error('Refusing to write outside data/fund-catalog.json.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchFn(EASTMONEY_FUND_CATALOG_SOURCE, { signal: controller.signal, headers: { Accept: 'application/javascript' } });
    if (!response || !response.ok || typeof response.text !== 'function') throw new Error('Fund catalog download failed.');
    const catalog = parseEastmoneyFundCatalogScript(await response.text());
    await writeFile(target, JSON.stringify(catalog), 'utf8');
    return { count: catalog.length, target };
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await refreshFundCatalog();
  process.stdout.write(`Refreshed ${result.count} fund catalog records.\n`);
}
