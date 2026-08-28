export const OCR_PERFORMANCE_LEDGER_KEY = 'fuyu_ocr_performance_ledger_v1';
export const OCR_PERFORMANCE_LEDGER_LIMIT = 20;

const CAPABILITY_CLASSES = new Set(['webgpu', 'wasm_only', 'unsupported', 'unknown']);
const BACKENDS = new Set(['webgpu', 'wasm', 'none']);
const ERROR_CATEGORIES = new Set([
  'none',
  'input_invalid',
  'capability_missing',
  'asset_manifest_failed',
  'webgpu_init_failed',
  'wasm_init_failed',
  'decode_failed',
  'preprocess_failed',
  'recognition_failed',
  'layout_failed',
  'parse_failed',
  'cancelled',
  'unknown',
]);
const INTEGER_FIELDS = Object.freeze([
  ['imageWidth', 0, 100_000],
  ['imageHeight', 0, 100_000],
  ['tileCount', 0, 10_000],
  ['coldInitMs', 0, 3_600_000],
  ['warmInitMs', 0, 3_600_000],
  ['preprocessMs', 0, 3_600_000],
  ['detectionMs', 0, 3_600_000],
  ['recognitionMs', 0, 3_600_000],
  ['layoutMs', 0, 3_600_000],
  ['parseMs', 0, 3_600_000],
  ['totalMs', 0, 7_200_000],
  ['blockCount', 0, 1_000_000],
]);

function integer(value, minimum, maximum) {
  if (value == null || value === '') return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function enumValue(value, allowed, fallback) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.has(normalized) ? normalized : fallback;
}

export function normalizeOcrPerformanceEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {
    capabilityClass: enumValue(value.capabilityClass, CAPABILITY_CLASSES, 'unknown'),
    backend: enumValue(value.backend, BACKENDS, 'none'),
    fallback: value.fallback === true,
    errorCategory: enumValue(value.errorCategory, ERROR_CATEGORIES, 'unknown'),
  };
  for (const [field, minimum, maximum] of INTEGER_FIELDS) {
    const normalized = integer(value[field], minimum, maximum);
    if (normalized == null) return null;
    output[field] = normalized;
  }
  if (output.totalMs === 0) {
    output.totalMs = output.coldInitMs + output.warmInitMs + output.preprocessMs
      + output.detectionMs + output.recognitionMs + output.layoutMs + output.parseMs;
  }
  return Object.freeze(output);
}

function defaultStorage() {
  try { return globalThis.localStorage; }
  catch (_) { return null; }
}

function readLedger(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(OCR_PERFORMANCE_LEDGER_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeOcrPerformanceEntry).filter(Boolean).slice(-OCR_PERFORMANCE_LEDGER_LIMIT);
  } catch (_) {
    return [];
  }
}

export function recordOcrPerformance(value, storage = defaultStorage()) {
  const entry = normalizeOcrPerformanceEntry(value);
  if (!entry || !storage) return { ok: false, reason: 'invalid_performance_entry' };
  const entries = [...readLedger(storage), entry].slice(-OCR_PERFORMANCE_LEDGER_LIMIT);
  const raw = JSON.stringify(entries);
  try {
    storage.setItem(OCR_PERFORMANCE_LEDGER_KEY, raw);
    if (storage.getItem(OCR_PERFORMANCE_LEDGER_KEY) !== raw) {
      return { ok: false, reason: 'ledger_readback_failed' };
    }
    return { ok: true, entry, count: entries.length };
  } catch (_) {
    return { ok: false, reason: 'ledger_write_failed' };
  }
}

export function readOcrPerformanceLedger(storage = defaultStorage()) {
  return Object.freeze(readLedger(storage));
}

export function summarizeOcrPerformance(storage = defaultStorage()) {
  const entries = readLedger(storage);
  const summary = {
    count: entries.length,
    webgpuRuns: 0,
    wasmRuns: 0,
    fallbackRuns: 0,
    failedRuns: 0,
    latest: entries.length ? entries[entries.length - 1] : null,
  };
  for (const entry of entries) {
    if (entry.backend === 'webgpu') summary.webgpuRuns += 1;
    if (entry.backend === 'wasm') summary.wasmRuns += 1;
    if (entry.fallback) summary.fallbackRuns += 1;
    if (entry.errorCategory !== 'none') summary.failedRuns += 1;
  }
  return Object.freeze(summary);
}

export function classifyOcrPerformanceError(error, stage = '') {
  if (error?.name === 'AbortError') return 'cancelled';
  if (error?.name === 'OcrAssetManifestError') return 'asset_manifest_failed';
  const normalizedStage = String(stage || '').trim().toLowerCase();
  if (normalizedStage === 'initialization') {
    return error?.backend === 'webgpu' ? 'webgpu_init_failed' : 'wasm_init_failed';
  }
  const byStage = {
    input: 'input_invalid',
    capability: 'capability_missing',
    manifest: 'asset_manifest_failed',
    webgpu: 'webgpu_init_failed',
    wasm: 'wasm_init_failed',
    decode: 'decode_failed',
    preprocess: 'preprocess_failed',
    recognition: 'recognition_failed',
    layout: 'layout_failed',
    parse: 'parse_failed',
  };
  return byStage[normalizedStage] || 'unknown';
}

// Backward-compatible boolean facade for any diagnostic tooling created while
// the v15 branch was in progress. New application code uses recordOcrPerformance.
export function appendOcrPerformanceRecord(value, storage = defaultStorage()) {
  return recordOcrPerformance(value, storage).ok;
}
