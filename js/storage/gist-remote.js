import {
  canonicalCloudPayload,
  reconcileCloudBridgePayloadSet,
} from './cloud-sync.js';

export const LEGACY_GIST_FILENAME = 'fuyu-holdings.json';
export const V3_GIST_CANONICAL_FILENAME = 'fuyu-holdings-v3.json';
export const V3_GIST_DEVICE_PREFIX = 'fuyu-holdings-v3-';
export const MAX_V3_GIST_FILES = 64;
const V3_GIST_DEVICE_PATTERN = /^fuyu-holdings-v3-[0-9a-f]{16}\.json$/;

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
      const response = await request(url, {
        cache: 'no-store',
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github+json',
          'Cache-Control': 'no-cache',
        },
      });
      if (!response.ok) return { ok: false, reason: `remote_http_${response.status}` };
      const data = await response.json();
      if (data?.truncated === true) return { ok: false, reason: 'remote_gist_truncated' };
      const files = data?.files || {};
      const version = response.headers.get('etag') || data.updated_at || null;
      const v3Entries = Object.entries(files)
        .filter(([filename]) => isV3GistFilename(filename))
        .sort(([left], [right]) => left.localeCompare(right));
      if (v3Entries.length > MAX_V3_GIST_FILES) {
        return { ok: false, reason: 'remote_v3_file_limit_exceeded' };
      }

      if (v3Entries.length) {
        const v3Values = [];
        for (const [, file] of v3Entries) {
          const readable = readableFile(file, 'v3');
          if (!readable.ok) return readable;
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
        if (!bridge.ok) return { ok: false, reason: bridge.reason };

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
      if (!legacy.ok) return { ok: false, reason: 'remote_file_missing' };
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
      if (write?.schema !== 3) {
        return { ok: false, reason: 'remote_schema_downgrade_blocked' };
      }
      const headers = {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      };
      // Gist PATCH does not document conditional-write/CAS semantics. Device
      // shards, deterministic merges and verified readback are the guards;
      // ETag remains backup/diagnostic metadata only.
      const filename = targetFilename;
      const response = await request(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          description: `FundVal 持仓数据 | ${now()}`,
          files: { [filename]: { content: write.content } },
        }),
      });
      return response.ok
        ? { ok: true, filename }
        : { ok: false, reason: `remote_patch_http_${response.status}` };
    },
  };
}

export async function findExistingHoldingsGist({ token, request, maxPages = 5 }) {
  let legacyFallback = '';
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await request(`https://api.github.com/gists?per_page=100&page=${page}`, {
      headers: { 'Authorization': `token ${token}` },
    });
    if (!response.ok) return '';
    const gists = await response.json();
    if (!gists.length) break;
    for (const gist of gists) {
      if (hasV3GistFile(gist.files)) return String(gist.id || '');
      if (!legacyFallback && gist.files?.[LEGACY_GIST_FILENAME]) {
        legacyFallback = String(gist.id || '');
      }
    }
    if (gists.length < 100) break;
  }
  return legacyFallback;
}
