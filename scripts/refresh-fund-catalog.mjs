import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EASTMONEY_FUND_CATALOG_SOURCE = 'https://fund.eastmoney.com/js/fundcode_search.js';

// Maintenance-tool limits, not browser bundle budgets. Never truncate identities.
export const FUND_CATALOG_LIMITS = Object.freeze({
  sourceBytes: 16 * 1024 * 1024,
  rows: 100000,
  nameLength: 128,
  pinyinLength: 512,
  outputBytes: 16 * 1024 * 1024,
  timeoutMs: 20000,
});

function text(value) {
  return String(value == null ? '' : value).trim();
}

function sourceSize(bytes) {
  if (bytes > FUND_CATALOG_LIMITS.sourceBytes) throw new Error('Fund catalog source exceeds the byte limit.');
}

/** Parse the upstream data assignment without evaluating third-party code. */
export function parseEastmoneyFundCatalogScript(source) {
  const input = String(source == null ? '' : source);
  sourceSize(Buffer.byteLength(input, 'utf8'));
  const raw = input.trim();
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
  if (rows.length > FUND_CATALOG_LIMITS.rows) throw new Error('Fund catalog source exceeds the row limit.');
  const seen = new Set();
  const catalog = [];
  for (const row of rows) {
    const code = text(Array.isArray(row) ? row[0] : '');
    // Eastmoney raw rows use [code, shortPinyin, ChineseName, category, fullPinyin].
    const name = text(Array.isArray(row) ? row[2] : '');
    const pinyin = text(Array.isArray(row) ? (row[4] || row[1]) : '');
    if (!/^\d{6}$/.test(code) || !name || seen.has(code)) continue;
    if (name.length > FUND_CATALOG_LIMITS.nameLength || pinyin.length > FUND_CATALOG_LIMITS.pinyinLength) {
      throw new Error('Fund catalog identity exceeds the field limit.');
    }
    seen.add(code);
    catalog.push({ code, name, pinyin });
  }
  if (!catalog.length) throw new Error('Fund catalog source contains no valid funds.');
  if (Buffer.byteLength(JSON.stringify(catalog), 'utf8') > FUND_CATALOG_LIMITS.outputBytes) {
    throw new Error('Fund catalog output exceeds the byte limit.');
  }
  return catalog;
}

function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch (_) { /* best effort */ }
}

async function readCatalogSource(response, signal, assertDeadline) {
  assertDeadline();
  const declared = response.headers?.get?.('content-length');
  if (declared != null) {
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) {
      cancelBody(response);
      throw new Error('Fund catalog content length is malformed.');
    }
    if (Number(declared) > FUND_CATALOG_LIMITS.sourceBytes) {
      cancelBody(response);
      throw new Error('Fund catalog source exceeds the byte limit.');
    }
  }
  if (typeof response.body?.getReader !== 'function') {
    // Compatibility for injected text-only responses: this is a post-read cap,
    // not protection against allocations performed inside a custom text().
    if (typeof response.text !== 'function') throw new Error('Fund catalog download failed.');
    const source = await response.text();
    assertDeadline();
    sourceSize(Buffer.byteLength(String(source == null ? '' : source), 'utf8'));
    return source;
  }
  const reader = response.body.getReader();
  let complete = false;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try { Promise.resolve(reader.cancel(signal.reason)).catch(() => {}); } catch (_) { /* best effort */ }
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    // Bound retained payload storage independently of chunk count: an upstream
    // can produce empty/tiny chunks without increasing the byte counter.
    const source = Buffer.alloc(FUND_CATALOG_LIMITS.sourceBytes);
    let bytes = 0;
    while (true) {
      assertDeadline();
      const item = await reader.read();
      assertDeadline();
      if (item.done) { complete = true; break; }
      if (!(item.value instanceof Uint8Array)) throw new Error('Fund catalog stream is malformed.');
      const nextBytes = bytes + item.value.byteLength;
      sourceSize(nextBytes); // Enforce actual decoded bytes, not just headers.
      source.set(item.value, bytes);
      bytes = nextBytes;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(source.subarray(0, bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

async function downloadCatalogSource(fetchFn) {
  const controller = new AbortController();
  const startedAt = performance.now();
  const assertDeadline = () => {
    controller.signal.throwIfAborted();
    if (performance.now() - startedAt >= FUND_CATALOG_LIMITS.timeoutMs) {
      throw new Error('Fund catalog download timed out.');
    }
  };
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Fund catalog download timed out.');
      controller.abort(error);
      reject(error);
    }, FUND_CATALOG_LIMITS.timeoutMs);
  });
  const operation = (async () => {
    const response = await fetchFn(EASTMONEY_FUND_CATALOG_SOURCE, {
      signal: controller.signal, headers: { Accept: 'application/javascript' },
    });
    if (controller.signal.aborted) {
      cancelBody(response);
      controller.signal.throwIfAborted();
    }
    if (!response || !response.ok) {
      cancelBody(response);
      throw new Error('Fund catalog download failed.');
    }
    return readCatalogSource(response, controller.signal, assertDeadline);
  })();
  try {
    const source = await Promise.race([operation, deadline]);
    // Synchronous work/microtasks can starve the timers queue. Do not publish
    // an elapsed download merely because its Promise beat setTimeout.
    assertDeadline();
    return source;
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function replaceCatalog(target, serialized) {
  const temporary = resolve(dirname(target), '.fund-catalog.' + randomUUID() + '.tmp');
  // Owning a successfully opened exclusive file is required before cleanup.
  const handle = await open(temporary, 'wx');
  try {
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The only commit point. Never delete the old catalog or fall back to
    // truncating it if replacement is denied (including on Windows).
    await rename(temporary, target);
  } catch (error) {
    try { await unlink(temporary); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'Fund catalog replacement and temporary cleanup failed.');
      }
    }
    throw error;
  }
}

export async function refreshFundCatalog({ fetchFn = fetch, targetPath } = {}) {
  if (typeof fetchFn !== 'function') throw new Error('Fund catalog fetch is unavailable.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const target = resolve(targetPath || resolve(root, 'data', 'fund-catalog.json'));
  if (target !== resolve(root, 'data', 'fund-catalog.json')) throw new Error('Refusing to write outside data/fund-catalog.json.');
  // Deadline covers download only. A rejected/late download never starts I/O;
  // an already committed rename cannot be cancelled or rolled back by a timer.
  const catalog = parseEastmoneyFundCatalogScript(await downloadCatalogSource(fetchFn));
  await replaceCatalog(target, JSON.stringify(catalog));
  return { count: catalog.length, target };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await refreshFundCatalog();
  process.stdout.write(`Refreshed ${result.count} fund catalog records.\n`);
}
