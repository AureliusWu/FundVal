import {
  canonicalCloudPayload,
  reconcileCloudBridgePayloadSet,
} from './cloud-sync.js';
import { classifyGistHttpFailure, gistFailure } from './gist-http.js';
export { classifyGistHttpFailure } from './gist-http.js';

export const LEGACY_GIST_FILENAME = 'fuyu-holdings.json';
export const V3_GIST_CANONICAL_FILENAME = 'fuyu-holdings-v3.json';
export const V3_GIST_DEVICE_PREFIX = 'fuyu-holdings-v3-';
export const MAX_V3_GIST_FILES = 64;
const V3_GIST_DEVICE_PATTERN = /^fuyu-holdings-v3-[0-9a-f]{16}\.json$/;
const GIST_ID_PATTERN = /^[0-9a-f]{1,64}$/i;
const MAX_DISCOVERY_PAGES = 5;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validToken = token => typeof token === 'string' && token.length > 0 && token.length <= 2048 && !/[\x00-\x20\x7f]/.test(token);
const validGistId = id => typeof id === 'string' && GIST_ID_PATTERN.test(id);

function failed(reason, code = 'invalid_response', phase = 'get', extra = {}) {
  return { ok: false, reason, failure: gistFailure(code, { phase }), ...extra };
}

function validResponse(response) {
  try {
    return isRecord(response) && Number.isInteger(response.status) && response.status >= 100
      && response.status <= 599 && typeof response.ok === 'boolean'
      && response.ok === (response.status >= 200 && response.status < 300);
  } catch (_) { return false; }
}

function deviceHash(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('missing cloud device id');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193) >>> 0;
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

export function v3GistFilename(deviceId) {
  return `${V3_GIST_DEVICE_PREFIX}${deviceHash(deviceId)}.json`;
}

export function isV3GistFilename(filename) {
  const value = String(filename || '');
  return value === V3_GIST_CANONICAL_FILENAME
    || V3_GIST_DEVICE_PATTERN.test(value);
}

export function hasV3GistFile(files) {
  return Object.keys(files || {}).some(isV3GistFilename);
}

export function hasHoldingsGistFile(files) {
  return hasV3GistFile(files) || Boolean(files?.[LEGACY_GIST_FILENAME]);
}

function readableFile(file, label) {
  if (!file) return { ok: false, reason: `remote_${label}_file_missing` };
  if (file.truncated) return { ok: false, reason: `remote_${label}_file_truncated` };
  if (typeof file.content !== 'string' || !file.content.trim()) {
    return { ok: false, reason: `remote_${label}_payload_missing` };
  }
  return { ok: true, content: file.content };
}

function backupFiles(files) {
  const holdingsFiles = {};
  for (const [filename, file] of Object.entries(files || {})) {
    if (filename !== LEGACY_GIST_FILENAME && !isV3GistFilename(filename)) continue;
    if (typeof file?.content === 'string') holdingsFiles[filename] = file.content;
  }
  return { files: holdingsFiles };
}

export function createGistRemoteAdapter({ token, gistId, deviceId, request, now = () => new Date().toISOString() }) {
  if (typeof request !== 'function') throw new TypeError('Gist adapter requires a request function');
  const url = `https://api.github.com/gists/${gistId}`;
  const targetFilename = v3GistFilename(deviceId);

  return {
    async get() {
      if (!validGistId(gistId) || !validToken(token)) return failed('remote_invalid_request', 'invalid_request');
      let response;
      try { response = await request(url, {
        cache: 'no-store',
        redirect: 'error',
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github+json',
          'Cache-Control': 'no-cache',
        },
      }); } catch (_) { return failed('remote_network', 'network'); }
      if (!validResponse(response)) return failed('remote_invalid_response');
      if (!response.ok) return { ok: false, reason: `remote_http_${response.status}`, failure: classifyGistHttpFailure(response, { phase: 'get', now }) };
      let data;
      try { data = await response.json(); } catch (_) { return failed('remote_invalid_response'); }
      if (!isRecord(data) || !isRecord(data.files)) return failed('remote_invalid_response');
      if (data.truncated === true) return failed('remote_gist_truncated');
      const files = data.files;
      let etag = null;
      try { etag = response.headers?.get('etag'); } catch (_) { /* Optional metadata only. */ }
      const version = typeof etag === 'string' ? etag : data.updated_at || null;
      const v3Entries = Object.entries(files)
        .filter(([filename]) => isV3GistFilename(filename))
        .sort(([left], [right]) => left.localeCompare(right));
      if (v3Entries.length > MAX_V3_GIST_FILES) {
        return failed('remote_v3_file_limit_exceeded');
      }

      if (v3Entries.length) {
        const v3Values = [];
        for (const [, file] of v3Entries) {
          const readable = readableFile(file, 'v3');
          if (!readable.ok) return failed(readable.reason);
          v3Values.push(readable.content);
        }
        const legacy = files[LEGACY_GIST_FILENAME]
          ? readableFile(files[LEGACY_GIST_FILENAME], 'legacy')
          : null;
        const bridge = reconcileCloudBridgePayloadSet(
          v3Values,
          legacy?.ok ? legacy.content : null,
          { deviceId }
        );
        if (!bridge.ok) return failed(bridge.reason);

        let targetCanonical = null;
        const target = files[targetFilename] ? readableFile(files[targetFilename], 'v3_device') : null;
        if (target?.ok) {
          try { targetCanonical = canonicalCloudPayload(target.content, 3); }
          catch (_) { targetCanonical = null; }
        }
        const mergedCanonical = canonicalCloudPayload(bridge.payload, 3);
        return {
          ok: true,
          raw: JSON.stringify(bridge.payload),
          backupRaw: backupFiles(files),
          version,
          requiresPatch: targetCanonical !== mergedCanonical,
          sourceFile: targetFilename,
        };
      }

      const legacy = readableFile(files[LEGACY_GIST_FILENAME], 'legacy');
      if (!legacy.ok) return failed('remote_file_missing');
      return {
        ok: true,
        raw: legacy.content,
        backupRaw: backupFiles(files),
        version,
        requiresPatch: false,
        sourceFile: LEGACY_GIST_FILENAME,
      };
    },

    async patch(write) {
      if (!validGistId(gistId) || !validToken(token)) return failed('remote_patch_invalid_request', 'invalid_request', 'patch', { writeUnknown: false });
      if (write?.schema !== 3) {
        return failed('remote_schema_downgrade_blocked', 'invalid_request', 'patch', { writeUnknown: false });
      }
      if (typeof write.content !== 'string' || !write.content.trim()) return failed('remote_patch_invalid_request', 'invalid_request', 'patch', { writeUnknown: false });
      const headers = {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      };
      // Gist PATCH does not document conditional-write/CAS semantics. Device
      // shards, deterministic merges and verified readback are the guards;
      // ETag remains backup/diagnostic metadata only.
      const filename = targetFilename;
      let body;
      try { body = JSON.stringify({ description: `FundVal 持仓数据 | ${now()}`, files: { [filename]: { content: write.content } } }); }
      catch (_) { return failed('remote_patch_invalid_request', 'invalid_request', 'patch', { writeUnknown: false }); }
      let response;
      try { response = await request(url, {
        method: 'PATCH',
        redirect: 'error',
        headers,
        body,
      }); } catch (_) { return failed('remote_patch_network', 'network', 'patch', { writeUnknown: true }); }
      if (!validResponse(response)) return failed('remote_patch_invalid_response', 'invalid_response', 'patch', { writeUnknown: true });
      return response.ok
        ? { ok: true, filename }
        : { ok: false, reason: `remote_patch_http_${response.status}`, failure: classifyGistHttpFailure(response, { phase: 'patch', now }), writeUnknown: response.status >= 500 };
    },
  };
}

function updatedAt(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error('invalid timestamp');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('invalid timestamp');
  return new Date(timestamp).toISOString();
}

function nextPage(response, page, count) {
  const link = response.headers?.get('link');
  if (link === null || link === undefined || link === '') return count === 100;
  if (typeof link !== 'string' || link.length > 4096 || /[\r\n]/.test(link)) throw new Error('invalid pagination');
  const relations = new Map();
  for (const part of link.split(',')) {
    const match = /^\s*<([^<>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(part);
    if (!match || relations.has(match[2])) throw new Error('invalid pagination');
    const url = new URL(match[1]);
    const target = url.searchParams.get('page');
    if (url.origin !== 'https://api.github.com' || url.pathname !== '/gists' || url.username || url.password || url.hash
      || Array.from(url.searchParams).length !== 2 || url.searchParams.getAll('page').length !== 1 || url.searchParams.getAll('per_page').length !== 1
      || url.searchParams.get('per_page') !== '100' || !/^[1-9]\d{0,5}$/.test(target || '')
      || (match[2] === 'next' && (Number(target) !== page + 1 || count === 0))
      || (match[2] === 'first' && Number(target) !== 1)
      || (match[2] === 'prev' && Number(target) !== page - 1)
      || (match[2] === 'last' && Number(target) < page)) throw new Error('invalid pagination');
    relations.set(match[2], Number(target));
  }
  if (relations.has('last') && (relations.get('last') > page) !== relations.has('next')) throw new Error('invalid pagination');
  if (!relations.has('next') && count === 100 && !relations.has('last') && !relations.has('prev')) return true;
  return relations.has('next');
}

export async function listHoldingsGists({ token, request, maxPages = 5, now = Date.now } = {}) {
  const incomplete = (reason = 'remote_discovery_incomplete', failure = gistFailure('invalid_response', { phase: 'discovery' })) => ({ ok: false, candidates: [], complete: false, reason, failure });
  if (!validToken(token) || typeof request !== 'function' || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_DISCOVERY_PAGES) return incomplete();
  const candidates = [];
  const seen = new Set();
  try {
    for (let page = 1; page <= maxPages; page += 1) {
      let response;
      try { response = await request(`https://api.github.com/gists?per_page=100&page=${page}`, {
        cache: 'no-store', redirect: 'error', headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
      }); } catch (_) { return incomplete('remote_network', gistFailure('network', { phase: 'discovery' })); }
      if (!validResponse(response)) return incomplete();
      if (!response.ok) return incomplete(`remote_http_${response.status}`, classifyGistHttpFailure(response, { phase: 'discovery', now }));
      if (response.status !== 200) return incomplete();
      const gists = await response.json();
      if (!Array.isArray(gists) || gists.length > 100) return incomplete();
      for (const archive of gists) {
        if (!isRecord(archive) || !validGistId(archive.id) || archive.truncated === true || !isRecord(archive.files)) return incomplete();
        const id = archive.id.toLowerCase();
        if (seen.has(id)) return incomplete();
        seen.add(id);
        const entries = Object.entries(archive.files);
        if (entries.length > 300) return incomplete();
        const v3Entries = entries.filter(([filename]) => isV3GistFilename(filename));
        if (v3Entries.length > MAX_V3_GIST_FILES) return incomplete();
        const relevant = entries.filter(([filename]) => isV3GistFilename(filename) || filename === LEGACY_GIST_FILENAME);
        if (relevant.some(([, file]) => !isRecord(file) || file.truncated === true)) return incomplete();
        if (relevant.length) candidates.push({ id, schema: v3Entries.length ? 3 : 2, updatedAt: updatedAt(archive.updated_at) });
      }
      if (!nextPage(response, page, gists.length)) return { ok: true, candidates, complete: true };
    }
  } catch (_) { /* Fail closed without copying Error messages or private metadata. */ }
  return incomplete();
}

export async function findExistingHoldingsGist(options) {
  const result = await listHoldingsGists(options);
  return result.ok && result.complete && result.candidates.length === 1 ? result.candidates[0].id : '';
}
