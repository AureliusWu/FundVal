import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalPaddleOcr } from '../scripts/paddle-ocr-entry.mjs';
import {
  PaddleLocalOcrError,
  PADDLE_ALIPAY_RECOGNITION_OPTIONS,
  PADDLE_LOCAL_OCR_ASSETS,
  PADDLE_ROW_OCR_REGION,
  PADDLE_SOURCE_OCR_REGION,
  assertPaddleOcrBrowserCapabilities,
  createPaddleOcrOptions,
  isSupportedPaddleOcrImage,
  mapPaddlePolygonToImage,
  missingPaddleOcrBrowserCapabilities,
  normalizePaddleOcrPerformance,
  normalizePaddleOcrItems,
  paddleItemIsInTileCore,
  planPaddleRowOcrTiles,
  recognizeAlipayPaddleImage,
  validatePaddleOcrImage,
  verifyPaddleOcrImageSignature,
} from '../js/paddle-local-ocr.js';

test('accepts only a local Blob with a supported screenshot type', () => {
  const png = new Blob(['image'], { type: 'image/png' });
  const json = new Blob(['{}'], { type: 'application/json' });
  assert.equal(isSupportedPaddleOcrImage(png), true);
  assert.equal(isSupportedPaddleOcrImage(json), false);
  assert.throws(() => validatePaddleOcrImage('https://example.com/screenshot.png'));
  assert.throws(() => validatePaddleOcrImage(json));
});

test('defers generic Android file metadata to the local image signature', async () => {
  const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const unnamed = new Blob([pngHeader]);
  const octetStream = new Blob([pngHeader], { type: 'application/octet-stream' });
  Object.defineProperty(octetStream, 'name', { value: 'content' });
  assert.equal(isSupportedPaddleOcrImage(unnamed), true);
  assert.equal(isSupportedPaddleOcrImage(octetStream), true);
  await assert.doesNotReject(() => verifyPaddleOcrImageSignature(unnamed));
  await assert.doesNotReject(() => verifyPaddleOcrImageSignature(octetStream));
});

test('rejects clearly non-image MIME types or filename suffixes before decoding', () => {
  const jsonWithImageName = new Blob(['{}'], { type: 'application/json' });
  Object.defineProperty(jsonWithImageName, 'name', { value: 'holding.png' });
  const imageWithTextName = new Blob(['image'], { type: 'image/png' });
  Object.defineProperty(imageWithTextName, 'name', { value: 'holding.txt' });
  assert.equal(isSupportedPaddleOcrImage(jsonWithImageName), false);
  assert.equal(isSupportedPaddleOcrImage(imageWithTextName), false);
  assert.throws(() => validatePaddleOcrImage(jsonWithImageName));
  assert.throws(() => validatePaddleOcrImage(imageWithTextName));
});

test('checks the local binary signature before image decoding', async () => {
  const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const valid = new Blob([pngHeader], { type: 'image/png' });
  const renamedSvg = new Blob(['<svg></svg>'], { type: 'image/png' });
  await assert.doesNotReject(() => verifyPaddleOcrImageSignature(valid));
  await assert.rejects(() => verifyPaddleOcrImageSignature(renamedSvg));
});

test('preflights the browser capabilities required by the Android OCR path', () => {
  const supportedRuntime = {
    Worker() {},
    createImageBitmap() {},
    OffscreenCanvas() {},
    WebAssembly: {},
    structuredClone() {},
  };
  assert.deepEqual(missingPaddleOcrBrowserCapabilities(supportedRuntime), []);
  assert.equal(assertPaddleOcrBrowserCapabilities(supportedRuntime), true);

  const unsupportedRuntime = { ...supportedRuntime, OffscreenCanvas: undefined, structuredClone: undefined };
  assert.deepEqual(missingPaddleOcrBrowserCapabilities(unsupportedRuntime), ['OffscreenCanvas', 'structuredClone']);
  assert.throws(
    () => assertPaddleOcrBrowserCapabilities(unsupportedRuntime),
    /Android.*最新版 Chrome/
  );
});

test('plans bounded whole-row tiles for the long holdings-list region', () => {
  const tiles = planPaddleRowOcrTiles(1440, 9317);
  assert.equal(tiles[0].x, 28);
  assert.equal(tiles[0].right, 1433);
  assert.equal(tiles[0].y, 1490);
  assert.equal(tiles.at(-1).bottom, 8386);
  assert.equal(tiles.at(-1).coreBottom, 8386);
  assert.equal(tiles.length, 6);
  assert.deepEqual(PADDLE_ROW_OCR_REGION, {
    left: 0.02,
    right: 0.995,
    top: 0.16,
    bottom: 0.90,
    tileHeight: 1500,
    overlap: 160,
  });
  for (const [index, tile] of tiles.entries()) {
    assert.ok(tile.height <= 1500);
    assert.ok(tile.width > 0);
    assert.ok(tile.coreTop < tile.coreBottom);
    if (index > 0) {
      assert.equal(tile.y - tiles[index - 1].y, 1340);
      assert.equal(tiles[index - 1].coreBottom, tile.coreTop);
    }
  }
});

test('plans a separate bounded header region for machine source evidence', () => {
  const tiles = planPaddleRowOcrTiles(1440, 9317, PADDLE_SOURCE_OCR_REGION);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].x, 0);
  assert.equal(tiles[0].y, 0);
  assert.equal(tiles[0].right, 1440);
  assert.equal(tiles[0].bottom, 1678);
});

test('maps Paddle polygon coordinates to original image coordinates and keeps one core owner', () => {
  const [, tile] = planPaddleRowOcrTiles(1440, 9317);
  const poly = [{ x: 12, y: 100 }, { x: 112, y: 100 }, { x: 112, y: 140 }, { x: 12, y: 140 }];
  assert.deepEqual(mapPaddlePolygonToImage(poly, tile), [
    { x: tile.x + 12, y: tile.y + 100 },
    { x: tile.x + 112, y: tile.y + 100 },
    { x: tile.x + 112, y: tile.y + 140 },
    { x: tile.x + 12, y: tile.y + 140 },
  ]);
  assert.equal(paddleItemIsInTileCore({ poly }, tile), true);
  const outsideCore = { poly: poly.map(point => ({ ...point, y: point.y - 90 })) };
  assert.equal(paddleItemIsInTileCore(outsideCore, tile), false);
});

test('normalizes only accepted positioned tokens without forming an OCR transcript', () => {
  const [, tile] = planPaddleRowOcrTiles(1440, 9317);
  const accepted = { text: '示例基金', score: 0.92, poly: [[8, 100], [108, 100], [108, 140], [8, 140]] };
  const rejected = { text: '重叠项', score: 0.91, poly: [[8, 0], [108, 0], [108, 30], [8, 30]] };
  const tokens = normalizePaddleOcrItems([accepted, rejected], tile);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].text, '示例基金');
  assert.equal(tokens[0].score, 0.92);
  assert.equal(tokens[0].x, tile.x + 8);
  assert.equal(tokens[0].y, tile.y + 100);
  assert.deepEqual(Object.keys(tokens[0]).sort(), ['bottom', 'height', 'poly', 'right', 'score', 'text', 'width', 'x', 'y']);
});

test('uses a same-origin static Paddle engine with local tiny models and single-threaded WASM', () => {
  const options = createPaddleOcrOptions();
  assert.equal(options.worker, true);
  assert.equal(options.textDetectionModelName, 'PP-OCRv6_tiny_det');
  assert.equal(options.textRecognitionModelName, 'PP-OCRv6_tiny_rec');
  assert.equal(options.ortOptions.numThreads, 1);
  assert.equal(options.ortOptions.simd, true);
  assert.equal(options.ortOptions.proxy, false);
  assert.equal(PADDLE_ALIPAY_RECOGNITION_OPTIONS.textDetLimitSideLen, 1600);
  for (const value of Object.values(PADDLE_LOCAL_OCR_ASSETS)) {
    assert.equal(new URL(value).protocol, 'file:');
  }
  assert.match(options.textDetectionModelAsset.url, /PP-OCRv6_tiny_det_onnx_infer\.tar$/);
  assert.match(options.textRecognitionModelAsset.url, /PP-OCRv6_tiny_rec_onnx_infer\.tar$/);
});

test('sanitizes successful and failed engine performance without retaining private fields', () => {
  const performance = normalizePaddleOcrPerformance({
    capabilityClass: 'webgpu', backend: 'wasm', webgpuAttempted: true,
    fallback: true, fallbackReason: 'initialization_failed', coldInitMs: 123.4,
    detectionMs: 456.7, recognitionMs: 89.1, totalMs: 800.2,
    localPath: 'C:/private/screenshot.jpg', ocrText: 'private OCR text',
  });
  assert.deepEqual(performance, {
    capabilityClass: 'webgpu', backend: 'wasm', webgpuAttempted: true,
    fallback: true, fallbackReason: 'initialization_failed', coldInitMs: 123.4,
    detectionMs: 456.7, recognitionMs: 89.1, totalMs: 800.2,
    imageWidth: 0, imageHeight: 0, tileCount: 0, preprocessMs: 0, blockCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(performance), /private|screenshot|ocr text/i);

  const error = new PaddleLocalOcrError('本地识别失败', {
    stage: 'recognition', performance,
  });
  assert.equal(error.backend, 'wasm');
  assert.deepEqual(error.performance, performance);
});

function localPng() {
  return new Blob([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  ], { type: 'image/png' });
}

async function runRecognitionScenario(performance, { predictionError = null } = {}) {
  const source = {
    width: 100,
    height: 100,
    closeCalls: 0,
    close() { this.closeCalls += 1; },
  };
  const crops = [];
  const createBitmap = async input => {
    if (input instanceof Blob) return source;
    const crop = { closeCalls: 0, close() { this.closeCalls += 1; } };
    crops.push(crop);
    return crop;
  };
  const runtime = {
    Worker() {},
    createImageBitmap: createBitmap,
    OffscreenCanvas() {},
    WebAssembly: {},
    structuredClone(value) { return value; },
  };
  let manifestCalls = 0;
  let factoryCalls = 0;
  let predictCalls = 0;
  let disposeCalls = 0;
  const phases = [];

  const options = {
    runtime,
    createBitmap,
    onProgress({ phase }) { phases.push(phase); },
    async loadAssetManifest(expected) {
      manifestCalls += 1;
      assert.deepEqual(expected, { engineVersion: '0.4.2', ortVersion: '1.27.0' });
    },
    async loadPaddleFactory() {
      factoryCalls += 1;
      return async ({ onProgress }) => {
        if (performance.fallback) onProgress({ phase: 'webgpu-fallback' });
        return {
          get performance() { return performance; },
          async predict() {
            predictCalls += 1;
            if (predictionError) throw predictionError;
            return [{ items: [] }];
          },
          async dispose() { disposeCalls += 1; },
        };
      };
    },
  };

  try {
    const result = await recognizeAlipayPaddleImage(localPng(), options);
    return {
      result, source, crops, phases,
      counts: { manifestCalls, factoryCalls, predictCalls, disposeCalls },
    };
  } catch (error) {
    error.testEvidence = {
      source, crops, phases,
      counts: { manifestCalls, factoryCalls, predictCalls, disposeCalls },
    };
    throw error;
  }
}

for (const scenario of [
  {
    name: 'WebGPU success',
    performance: {
      capabilityClass: 'webgpu', backend: 'webgpu', webgpuAttempted: true,
      fallback: false, fallbackReason: 'none',
    },
  },
  {
    name: 'WASM-only success',
    performance: {
      capabilityClass: 'wasm_only', backend: 'wasm', webgpuAttempted: false,
      fallback: false, fallbackReason: 'none',
    },
  },
  {
    name: 'WebGPU to WASM fallback success',
    performance: {
      capabilityClass: 'webgpu', backend: 'wasm', webgpuAttempted: true,
      fallback: true, fallbackReason: 'initialization_failed',
    },
  },
]) {
  test(`preserves truthful ${scenario.name} performance through the image adapter`, async () => {
    const evidence = await runRecognitionScenario(scenario.performance);
    assert.deepEqual({
      capabilityClass: evidence.result.performance.capabilityClass,
      backend: evidence.result.performance.backend,
      webgpuAttempted: evidence.result.performance.webgpuAttempted,
      fallback: evidence.result.performance.fallback,
      fallbackReason: evidence.result.performance.fallbackReason,
    }, scenario.performance);
    assert.deepEqual(evidence.counts, {
      manifestCalls: 1, factoryCalls: 1, predictCalls: 2, disposeCalls: 1,
    });
    assert.equal(evidence.source.closeCalls, 1);
    assert.equal(evidence.crops.length, 2);
    assert.ok(evidence.crops.every(crop => crop.closeCalls === 1));
    assert.equal(
      evidence.phases.filter(phase => phase === 'webgpu-fallback').length,
      scenario.performance.fallback ? 1 : 0,
    );
  });
}

test('preserves fallback evidence when recognition fails without leaking the backend error', async () => {
  const privateError = new Error('private model path and screenshot name');
  const performance = {
    capabilityClass: 'webgpu', backend: 'wasm', webgpuAttempted: true,
    fallback: true, fallbackReason: 'initialization_failed',
  };
  const error = await runRecognitionScenario(performance, { predictionError: privateError })
    .catch(value => value);
  assert.ok(error instanceof PaddleLocalOcrError);
  assert.equal(error.stage, 'recognition');
  assert.equal(error.backend, 'wasm');
  assert.deepEqual({
    capabilityClass: error.performance.capabilityClass,
    backend: error.performance.backend,
    webgpuAttempted: error.performance.webgpuAttempted,
    fallback: error.performance.fallback,
    fallbackReason: error.performance.fallbackReason,
  }, performance);
  assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error.performance)}`, /private|screenshot name/i);
  assert.deepEqual(error.testEvidence.counts, {
    manifestCalls: 1, factoryCalls: 1, predictCalls: 1, disposeCalls: 1,
  });
  assert.equal(error.testEvidence.source.closeCalls, 1);
  assert.equal(error.testEvidence.crops.length, 1);
  assert.equal(error.testEvidence.crops[0].closeCalls, 1);
});

test('initialization failure exports only a safe exhausted-fallback snapshot and disposes the engine', async () => {
  let disposeCalls = 0;
  const engine = {
    capabilities: {
      webgpu: { supported: true },
      wasm: { supported: true },
    },
    diagnostics: {
      backend: null,
      webgpuAttempted: true,
      fallback: { from: 'webgpu', to: 'wasm', reason: 'initialization_failed' },
      initializationMs: 321,
      recognitionMs: 0,
    },
    backend: null,
    async initialize() { throw new Error('private initialization path'); },
    async dispose() { disposeCalls += 1; },
  };
  const error = await createLocalPaddleOcr({ createEngine: () => engine }).catch(value => value);
  assert.equal(error.message, 'PaddleOCR worker operation failed.');
  assert.deepEqual(error.performance, {
    capabilityClass: 'webgpu', backend: 'none', webgpuAttempted: true,
    fallback: true, fallbackReason: 'initialization_failed', coldInitMs: 321,
    detectionMs: 0, recognitionMs: 0, blockCount: 0,
  });
  assert.equal(disposeCalls, 1);
  assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error.performance)}`, /private|initialization path/i);
});
