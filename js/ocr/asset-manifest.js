export const OCR_ASSET_MANIFEST_PATH = 'assets/ocr/asset-manifest.json';
export const OCR_ASSET_MANIFEST_URL = new URL('../../assets/ocr/asset-manifest.json', import.meta.url).href;
export const OCR_ENGINE_NAME = 'paddleocr-js';
// These values are the browser-side counterpart of the exact package pins.
// The build verifies the package pins agree, so a stale cached manifest cannot
// silently describe a different Paddle/ORT runtime than the page will load.
export const OCR_ENGINE_VERSION = '0.4.2';
export const OCR_MODEL_NAME = 'PP-OCRv6-tiny';
export const OCR_ORT_VERSION = '1.27.0';

export const OCR_MODEL_ASSET_PATHS = Object.freeze([
  'paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar',
  'paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
]);

export const OCR_MANIFEST_ASSET_ROLES = Object.freeze([
  'engine', 'worker', 'model', 'model_metadata', 'runtime',
  'fallback', 'license', 'support',
]);

const MANIFEST_FIELDS = Object.freeze([
  'engine', 'engine_version', 'model', 'model_hash',
  'ort_version', 'generated_at', 'assets',
]);
const ASSET_FIELDS = Object.freeze(['path', 'role', 'bytes', 'sha256']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/;

export class OcrAssetManifestError extends Error {
  constructor(code = 'manifest_invalid') {
    super('本地 OCR 资源清单校验失败，请更新应用后重试。');
    this.name = 'OcrAssetManifestError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.every((field, index) => actual[index] === [...expected].sort()[index]);
}

export function isSafeOcrAssetPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return false;
  if (value.startsWith('//') || URL_SCHEME_PATTERN.test(value)) return false;
  if (value.includes('?') || value.includes('#')) return false;
  if (/%(?:2e|2f|5c)/i.test(value)) return false;
  const segments = value.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..');
}

export function assertSafeOcrAssetPath(value) {
  if (!isSafeOcrAssetPath(value)) {
    throw new TypeError(`Unsafe OCR asset path: ${String(value)}`);
  }
  return value;
}

export function canonicalModelAssetSignature(assets) {
  if (!Array.isArray(assets)) throw new TypeError('OCR manifest assets must be an array.');
  const byPath = new Map(assets.map(asset => [asset?.path, asset]));
  return `${OCR_MODEL_ASSET_PATHS.map(path => {
    const asset = byPath.get(path);
    if (!asset || asset.role !== 'model') {
      throw new TypeError(`Missing required OCR model asset: ${path}`);
    }
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !SHA256_PATTERN.test(asset.sha256 || '')) {
      throw new TypeError(`Invalid OCR model asset metadata: ${path}`);
    }
    return `${path}\0${asset.bytes}\0${asset.sha256}`;
  }).join('\n')}\n`;
}

function validateGeneratedAt(value) {
  if (typeof value !== 'string') {
    throw new TypeError('OCR manifest generated_at must be a canonical ISO timestamp.');
  }
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch (_) {
    throw new TypeError('OCR manifest generated_at must be a canonical ISO timestamp.');
  }
  if (canonical !== value) {
    throw new TypeError('OCR manifest generated_at must be a canonical ISO timestamp.');
  }
}

export function validateOcrAssetManifest(manifest, { engineVersion, ortVersion } = {}) {
  if (!hasExactFields(manifest, MANIFEST_FIELDS)) {
    throw new TypeError('OCR manifest fields do not match the v15 contract.');
  }
  if (manifest.engine !== OCR_ENGINE_NAME) throw new TypeError('Unexpected OCR engine name.');
  if (!EXACT_VERSION_PATTERN.test(manifest.engine_version || '')) {
    throw new TypeError('OCR engine_version must be an exact version.');
  }
  if (engineVersion !== undefined && manifest.engine_version !== engineVersion) {
    throw new TypeError(`OCR engine version mismatch: expected ${engineVersion}.`);
  }
  if (manifest.model !== OCR_MODEL_NAME) throw new TypeError('Unexpected OCR model name.');
  if (!SHA256_PATTERN.test(manifest.model_hash || '')) throw new TypeError('Invalid OCR model_hash.');
  if (!EXACT_VERSION_PATTERN.test(manifest.ort_version || '')) {
    throw new TypeError('OCR ort_version must be an exact version.');
  }
  if (ortVersion !== undefined && manifest.ort_version !== ortVersion) {
    throw new TypeError(`OCR runtime version mismatch: expected ${ortVersion}.`);
  }
  validateGeneratedAt(manifest.generated_at);
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new TypeError('OCR manifest assets must be a non-empty array.');
  }

  const seen = new Set();
  const roles = new Set(OCR_MANIFEST_ASSET_ROLES);
  let previousPath = null;
  for (const asset of manifest.assets) {
    if (!hasExactFields(asset, ASSET_FIELDS)) {
      throw new TypeError('OCR asset fields do not match the v15 contract.');
    }
    assertSafeOcrAssetPath(asset.path);
    if (seen.has(asset.path)) throw new TypeError(`Duplicate OCR asset path: ${asset.path}`);
    if (previousPath !== null && previousPath >= asset.path) {
      throw new TypeError('OCR manifest assets must be sorted by path.');
    }
    if (!roles.has(asset.role)) throw new TypeError(`Unknown OCR asset role: ${String(asset.role)}`);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
      throw new TypeError(`Invalid OCR asset byte length: ${asset.path}`);
    }
    if (!SHA256_PATTERN.test(asset.sha256 || '')) {
      throw new TypeError(`Invalid OCR asset SHA-256: ${asset.path}`);
    }
    seen.add(asset.path);
    previousPath = asset.path;
  }

  canonicalModelAssetSignature(manifest.assets);
  if (!manifest.assets.some(asset => asset.role === 'engine')) throw new TypeError('OCR manifest has no engine asset.');
  if (!manifest.assets.some(asset => asset.role === 'worker')) throw new TypeError('OCR manifest has no Worker asset.');
  if (!manifest.assets.some(asset => asset.role === 'runtime')) throw new TypeError('OCR manifest has no runtime asset.');
  return manifest;
}

export async function loadOcrAssetManifest({
  fetchImpl = globalThis.fetch,
  url = OCR_ASSET_MANIFEST_URL,
  engineVersion = OCR_ENGINE_VERSION,
  ortVersion = OCR_ORT_VERSION,
  timeoutMs = 20_000,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new OcrAssetManifestError('fetch_unavailable');
  const controller = new AbortController();
  let timer;
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new OcrAssetManifestError('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new OcrAssetManifestError('fetch_timeout'));
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000);
    if (signal?.aborted) onAbort();
  });
  try {
    return await Promise.race([cancelled, (async () => {
      if (controller.signal.aborted) throw new OcrAssetManifestError('aborted');
      let response;
      try {
        response = await fetchImpl(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      } catch {
        throw new OcrAssetManifestError('fetch_failed');
      }
      if (!response?.ok) throw new OcrAssetManifestError('fetch_failed');
      return validateOcrAssetManifest(await response.json(), { engineVersion, ortVersion });
    })()]);
  } catch (error) {
    if (error instanceof OcrAssetManifestError) throw error;
    throw new OcrAssetManifestError('manifest_invalid');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
