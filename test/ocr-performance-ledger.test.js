import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyOcrPerformanceError,
  OCR_PERFORMANCE_LEDGER_KEY,
  normalizeOcrPerformanceEntry,
  readOcrPerformanceLedger,
  recordOcrPerformance,
  summarizeOcrPerformance,
} from '../js/ocr/performance-ledger.js';
import { PaddleLocalOcrError } from '../js/paddle-local-ocr.js';

function memoryStorage(hooks = {}) {
  const values = new Map();
  return {
    getItem(key) { return hooks.getItem ? hooks.getItem(key, values) : values.get(key) ?? null; },
    setItem(key, value) {
      if (hooks.setItem) return hooks.setItem(key, value, values);
      values.set(key, String(value));
    },
  };
}

function entry(overrides = {}) {
  return {
    capabilityClass: 'webgpu', backend: 'webgpu', fallback: false, errorCategory: 'none',
    imageWidth: 1440, imageHeight: 9317, tileCount: 7, coldInitMs: 1200, warmInitMs: 0,
    preprocessMs: 100, detectionMs: 500, recognitionMs: 900, layoutMs: 20,
    parseMs: 10, totalMs: 2730, blockCount: 120,
    ...overrides,
  };
}

test('normalizes only the fixed non-sensitive performance contract', () => {
  const normalized = normalizeOcrPerformanceEntry({
    ...entry(),
    ocrText: '基金名称和金额 30216.39',
    imageBase64: 'data:image/png;base64,SECRET',
    token: 'ghp_secret',
    localPath: 'C:\\Users\\person\\screenshot.png',
    arbitrary: { private: true },
  });
  assert.deepEqual(Object.keys(normalized), [
    'capabilityClass', 'backend', 'fallback', 'errorCategory',
    'imageWidth', 'imageHeight', 'tileCount', 'coldInitMs', 'warmInitMs',
    'preprocessMs', 'detectionMs', 'recognitionMs', 'layoutMs', 'parseMs',
    'totalMs', 'blockCount',
  ]);
  const raw = JSON.stringify(normalized);
  assert.doesNotMatch(raw, /基金|30216|base64|ghp_|Users|screenshot|private/);
});

test('keeps only the latest twenty entries and reports aggregate backend counts', () => {
  const storage = memoryStorage();
  for (let index = 0; index < 25; index += 1) {
    assert.equal(recordOcrPerformance(entry({
      backend: index % 2 ? 'wasm' : 'webgpu',
      fallback: index % 3 === 0,
      blockCount: index,
    }), storage).ok, true);
  }
  const entries = readOcrPerformanceLedger(storage);
  assert.equal(entries.length, 20);
  assert.equal(entries[0].blockCount, 5);
  assert.equal(entries[19].blockCount, 24);
  const summary = summarizeOcrPerformance(storage);
  assert.equal(summary.count, 20);
  assert.equal(summary.webgpuRuns + summary.wasmRuns, 20);
  assert.ok(summary.fallbackRuns > 0);
});

test('contains malformed storage and write failures without exposing the submitted object', () => {
  const brokenRead = memoryStorage({ getItem: () => '{broken' });
  assert.deepEqual(readOcrPerformanceLedger(brokenRead), []);

  const blocked = memoryStorage({ setItem: () => { throw new Error('quota'); } });
  assert.deepEqual(recordOcrPerformance(entry({ ocrText: 'secret' }), blocked), {
    ok: false,
    reason: 'ledger_write_failed',
  });
  assert.equal(blocked.getItem(OCR_PERFORMANCE_LEDGER_KEY), null);
});

test('rejects non-finite timing data and bounds numeric telemetry', () => {
  assert.equal(normalizeOcrPerformanceEntry(entry({ totalMs: Number.NaN })), null);
  const normalized = normalizeOcrPerformanceEntry(entry({ imageHeight: 9999999, totalMs: 99999999 }));
  assert.equal(normalized.imageHeight, 100000);
  assert.equal(normalized.totalMs, 7200000);
});

test('classifies only fixed local OCR stages without retaining underlying details', () => {
  const manifestFailure = new PaddleLocalOcrError('本地资源校验失败', { stage: 'manifest' });
  const webgpuFailure = new PaddleLocalOcrError('初始化失败', { stage: 'initialization', backend: 'webgpu' });
  const wasmFailure = new PaddleLocalOcrError('初始化失败', { stage: 'initialization', backend: 'wasm' });
  const unsafeStage = new PaddleLocalOcrError('本地识别失败', { stage: 'https://secret.invalid/?token=abc' });

  assert.equal(classifyOcrPerformanceError(manifestFailure, manifestFailure.stage), 'asset_manifest_failed');
  assert.equal(classifyOcrPerformanceError(webgpuFailure, webgpuFailure.stage), 'webgpu_init_failed');
  assert.equal(classifyOcrPerformanceError(wasmFailure, wasmFailure.stage), 'wasm_init_failed');
  assert.equal(unsafeStage.stage, '');
  assert.equal(classifyOcrPerformanceError(unsafeStage, unsafeStage.stage), 'unknown');
});
