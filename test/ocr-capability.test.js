import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOcrBackend, probeOcrWebGpu, selectOcrBackend } from '../js/ocr/capability.js';

test('OCR backend selection uses WASM when WebGPU is absent or cannot create an adapter', async () => {
  assert.deepEqual(await probeOcrWebGpu({}), {
    available: false,
    backend: 'wasm',
    reason: 'api_unavailable',
  });
  assert.deepEqual(await probeOcrWebGpu({
    navigator: { gpu: { async requestAdapter() { return null; } } },
  }), {
    available: false,
    backend: 'wasm',
    reason: 'adapter_unavailable',
  });
  assert.equal((await selectOcrBackend({})).preferred, 'wasm');
});

test('OCR tries WebGPU once when an adapter is available and keeps WASM as the fallback', async () => {
  const selection = await selectOcrBackend({
    navigator: { gpu: { async requestAdapter() { return {}; } } },
  });
  assert.equal(selection.preferred, 'webgpu');
  assert.equal(selection.fallback, 'wasm');
  assert.equal(selection.webgpu.available, true);
  assert.equal(normalizeOcrBackend('webgpu'), 'webgpu');
  assert.equal(normalizeOcrBackend('unexpected'), 'wasm');
});
