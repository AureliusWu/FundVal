import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalOcrEngine,
  OCR_BACKEND,
  OCR_ENGINE_ERROR,
  OcrEngineError,
  classifyOcrEngineError,
  createOcrEngine,
} from '../js/ocr/engine.js';

function capableRuntime({ webgpu = true } = {}) {
  return {
    Blob,
    Worker: class Worker {},
    createImageBitmap() {},
    OffscreenCanvas: class OffscreenCanvas {},
    WebAssembly: {},
    structuredClone(value) { return value; },
    isSecureContext: true,
    navigator: webgpu
      ? { gpu: { requestAdapter() { throw new Error('capability detection must not request adapter'); } } }
      : {},
  };
}

function localImage() {
  return new Blob(['local image bytes'], { type: 'image/png' });
}

function backend(result, overrides = {}) {
  return {
    async recognize() { return result; },
    ...overrides,
  };
}

test('uses WebGPU once when supported and shares one initialization across callers', async () => {
  let webgpuFactories = 0;
  let webgpuInitializations = 0;
  let wasmFactories = 0;
  let releaseInitialization;
  const initializationGate = new Promise(resolve => { releaseInitialization = resolve; });
  const selected = backend({ text: 'ok' }, {
    async initialize() {
      webgpuInitializations += 1;
      await initializationGate;
    },
  });
  const engine = createOcrEngine({
    runtime: capableRuntime(),
    backends: {
      webgpu: async () => {
        webgpuFactories += 1;
        return selected;
      },
      wasm: async () => {
        wasmFactories += 1;
        return backend({ text: 'wasm' });
      },
    },
  });

  const first = engine.initialize();
  const second = engine.initialize();
  assert.equal(first, second);
  releaseInitialization();
  assert.equal(await first, selected);
  assert.equal(await second, selected);
  assert.equal(webgpuFactories, 1);
  assert.equal(webgpuInitializations, 1);
  assert.equal(wasmFactories, 0);
  assert.deepEqual(engine.diagnostics, {
    state: 'ready',
    backend: OCR_BACKEND.WEBGPU,
    webgpuAttempted: true,
    wasmAttempted: false,
    fallback: null,
    initializationMs: engine.diagnostics.initializationMs,
    recognitionMs: 0,
    recognitionCount: 0,
  });
});

test('never attempts WebGPU when the browser does not expose it', async () => {
  let webgpuFactories = 0;
  let wasmFactories = 0;
  const engine = new LocalOcrEngine({
    runtime: capableRuntime({ webgpu: false }),
    backends: {
      webgpu: async () => {
        webgpuFactories += 1;
        return backend('gpu');
      },
      wasm: async () => {
        wasmFactories += 1;
        return backend('wasm');
      },
    },
  });

  await engine.initialize();

  assert.equal(webgpuFactories, 0);
  assert.equal(wasmFactories, 1);
  assert.equal(engine.diagnostics.backend, OCR_BACKEND.WASM);
  assert.equal(engine.diagnostics.webgpuAttempted, false);
});

test('falls back immediately and permanently to WASM after WebGPU initialization failure', async () => {
  let webgpuFactories = 0;
  let webgpuDisposals = 0;
  let wasmFactories = 0;
  const wasm = backend({ text: 'stable wasm result' });
  const engine = createOcrEngine({
    runtime: capableRuntime(),
    backends: {
      webgpu: async () => {
        webgpuFactories += 1;
        return backend(null, {
          async initialize() { throw new Error('private model path and screenshot name'); },
          async dispose() { webgpuDisposals += 1; },
        });
      },
      wasm: async () => {
        assert.equal(webgpuDisposals, 1, 'the failed WebGPU Worker must be released before creating the WASM fallback');
        wasmFactories += 1;
        return wasm;
      },
    },
  });

  assert.equal(await engine.initialize(), wasm);
  assert.equal(await engine.initialize(), wasm);
  assert.deepEqual(await engine.recognize(localImage()), { text: 'stable wasm result' });
  assert.equal(webgpuFactories, 1);
  assert.equal(webgpuDisposals, 1);
  assert.equal(wasmFactories, 1);
  assert.deepEqual(engine.diagnostics.fallback, {
    from: OCR_BACKEND.WEBGPU,
    to: OCR_BACKEND.WASM,
    reason: 'initialization_failed',
  });
});

test('treats model incompatibility as one WebGPU attempt and uses WASM', async () => {
  let compatibilityChecks = 0;
  let webgpuFactories = 0;
  const engine = createOcrEngine({
    runtime: capableRuntime(),
    backends: {
      webgpu: async () => {
        webgpuFactories += 1;
        return backend(null, {
          async isModelCompatible() {
            compatibilityChecks += 1;
            return false;
          },
        });
      },
      wasm: async () => backend('wasm'),
    },
  });

  assert.equal(await engine.initialize().then(() => engine.backendKind), OCR_BACKEND.WASM);
  assert.equal(await engine.initialize().then(() => engine.backendKind), OCR_BACKEND.WASM);
  assert.equal(webgpuFactories, 1);
  assert.equal(compatibilityChecks, 1);
});

test('keeps a failed initialization stable instead of retrying either backend', async () => {
  let webgpuFactories = 0;
  let wasmFactories = 0;
  const engine = createOcrEngine({
    runtime: capableRuntime(),
    backends: {
      webgpu: async () => {
        webgpuFactories += 1;
        throw new Error('secret-webgpu-detail');
      },
      wasm: async () => {
        wasmFactories += 1;
        throw new Error('secret-wasm-detail');
      },
    },
  });

  const first = await engine.initialize().catch(error => error);
  const second = await engine.initialize().catch(error => error);

  assert.equal(first, second);
  assert.ok(first instanceof OcrEngineError);
  assert.equal(first.code, OCR_ENGINE_ERROR.INITIALIZATION_FAILED);
  assert.equal(webgpuFactories, 1);
  assert.equal(wasmFactories, 1);
  assert.equal(JSON.stringify(first).includes('secret'), false);
  assert.equal(first.stack.includes('secret'), false);
});

test('concurrent recognition calls create and initialize only one backend', async () => {
  let factories = 0;
  let initializations = 0;
  let recognitions = 0;
  const engine = createOcrEngine({
    runtime: capableRuntime({ webgpu: false }),
    backends: {
      wasm: async () => {
        factories += 1;
        return backend(null, {
          async initialize() { initializations += 1; },
          async recognize() {
            recognitions += 1;
            return { index: recognitions };
          },
        });
      },
    },
  });

  const [first, second] = await Promise.all([
    engine.recognize(localImage()),
    engine.recognize(localImage()),
  ]);

  assert.equal(factories, 1);
  assert.equal(initializations, 1);
  assert.equal(recognitions, 2);
  assert.deepEqual([first.index, second.index].sort(), [1, 2]);
});

test('rejects URL, Base64, typed arrays, empty Blob, and blob-like objects before initialization', async () => {
  let factories = 0;
  const engine = createOcrEngine({
    runtime: capableRuntime({ webgpu: false }),
    backends: {
      wasm: async () => {
        factories += 1;
        return backend('unused');
      },
    },
  });
  const invalidInputs = [
    'https://example.com/private.png',
    'data:image/png;base64,c2VjcmV0',
    new Uint8Array([1, 2, 3]),
    { size: 10, type: 'image/png' },
    new Blob([], { type: 'image/png' }),
  ];

  for (const input of invalidInputs) {
    assert.throws(
      () => engine.recognize(input),
      error => error instanceof OcrEngineError && error.code === OCR_ENGINE_ERROR.INVALID_INPUT,
    );
  }
  assert.equal(factories, 0);
});

test('sanitizes backend recognition errors and classifications', async () => {
  const secret = 'data:image/png;base64,TOP_SECRET_OCR_TEXT';
  const engine = createOcrEngine({
    runtime: capableRuntime({ webgpu: false }),
    backends: {
      wasm: async () => backend(null, {
        async recognize() { throw new Error(secret); },
      }),
    },
  });

  const error = await engine.recognize(localImage()).catch(reason => reason);
  const classification = classifyOcrEngineError(error);
  const unknownClassification = classifyOcrEngineError(new Error(secret));

  assert.equal(error.code, OCR_ENGINE_ERROR.RECOGNITION_FAILED);
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal(JSON.stringify(classification).includes(secret), false);
  assert.equal(JSON.stringify(unknownClassification).includes(secret), false);
  assert.equal(unknownClassification.code, OCR_ENGINE_ERROR.UNEXPECTED);
});

test('dispose waits for active work, releases one backend once, and prevents reuse', async () => {
  let resolveRecognition;
  const recognitionGate = new Promise(resolve => { resolveRecognition = resolve; });
  let disposeCalls = 0;
  const engine = createOcrEngine({
    runtime: capableRuntime({ webgpu: false }),
    backends: {
      wasm: async () => backend(null, {
        async recognize() {
          await recognitionGate;
          return 'done';
        },
        async dispose() { disposeCalls += 1; },
      }),
    },
  });
  await engine.initialize();
  const recognition = engine.recognize(localImage());
  await Promise.resolve();
  const firstDispose = engine.dispose();
  const secondDispose = engine.dispose();
  assert.equal(firstDispose, secondDispose);
  assert.equal(disposeCalls, 0);
  resolveRecognition();
  assert.equal(await recognition, 'done');
  await firstDispose;
  assert.equal(disposeCalls, 1);
  assert.equal(engine.diagnostics.state, 'disposed');
  await assert.rejects(
    () => engine.initialize(),
    error => error.code === OCR_ENGINE_ERROR.DISPOSED,
  );
  assert.throws(
    () => engine.recognize(localImage()),
    error => error.code === OCR_ENGINE_ERROR.DISPOSED,
  );
});
