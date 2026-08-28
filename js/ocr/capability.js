// Local OCR capability detection only. This module performs no model load,
// image processing, persistence, logging, or user-agent fingerprinting.

export const OCR_CAPABILITY_REASON = Object.freeze({
  AVAILABLE: 'available',
  MISSING_API: 'missing_api',
  INSECURE_CONTEXT: 'insecure_context',
  BASELINE_UNAVAILABLE: 'baseline_unavailable',
  ADAPTER_UNAVAILABLE: 'adapter_unavailable',
  ADAPTER_REQUEST_FAILED: 'adapter_request_failed',
});

const BACKENDS = new Set(['webgpu', 'wasm']);
const LOCAL_OCR_REQUIREMENTS = Object.freeze([
  Object.freeze({ name: 'Worker', test: value => typeof value === 'function' }),
  Object.freeze({ name: 'createImageBitmap', test: value => typeof value === 'function' }),
  Object.freeze({ name: 'OffscreenCanvas', test: value => typeof value === 'function' }),
  Object.freeze({
    name: 'WebAssembly',
    test: value => value != null && (typeof value === 'object' || typeof value === 'function'),
  }),
  Object.freeze({ name: 'structuredClone', test: value => typeof value === 'function' }),
]);

function freezeCapability(supported, reason) {
  return Object.freeze({ supported: Boolean(supported), reason });
}

function hasWebGpuApi(runtime) {
  const gpu = runtime?.navigator?.gpu;
  return Boolean(gpu && typeof gpu.requestAdapter === 'function');
}

/**
 * Synchronous API-shape detection. It deliberately does not request a GPU
 * adapter; the real engine initialization is the single authoritative attempt.
 */
export function detectOcrCapabilities(runtime = globalThis) {
  const target = runtime || {};
  const missing = LOCAL_OCR_REQUIREMENTS
    .filter(requirement => !requirement.test(target[requirement.name]))
    .map(requirement => requirement.name);
  const baselineSupported = missing.length === 0;
  const secureContext = target.isSecureContext !== false;
  const webGpuApi = hasWebGpuApi(target);

  let webGpuReason = OCR_CAPABILITY_REASON.AVAILABLE;
  if (!baselineSupported) webGpuReason = OCR_CAPABILITY_REASON.BASELINE_UNAVAILABLE;
  else if (!secureContext) webGpuReason = OCR_CAPABILITY_REASON.INSECURE_CONTEXT;
  else if (!webGpuApi) webGpuReason = OCR_CAPABILITY_REASON.MISSING_API;

  const wasmApi = LOCAL_OCR_REQUIREMENTS
    .find(requirement => requirement.name === 'WebAssembly')
    .test(target.WebAssembly);

  return Object.freeze({
    localOnly: true,
    baseline: Object.freeze({
      supported: baselineSupported,
      missing: Object.freeze([...missing]),
    }),
    wasm: freezeCapability(
      wasmApi && baselineSupported,
      wasmApi && baselineSupported
        ? OCR_CAPABILITY_REASON.AVAILABLE
        : OCR_CAPABILITY_REASON.BASELINE_UNAVAILABLE,
    ),
    webgpu: freezeCapability(
      baselineSupported && secureContext && webGpuApi,
      webGpuReason,
    ),
  });
}

export function canAttemptWebGpu(capabilities) {
  return capabilities?.webgpu?.supported === true;
}

export function canUseWasmOcr(capabilities) {
  return capabilities?.wasm?.supported === true;
}

export function normalizeOcrBackend(value, fallback = 'wasm') {
  return BACKENDS.has(value) ? value : fallback;
}

/**
 * Optional diagnostic probe retained for focused tests. Production backend
 * selection does not call it, so adapter creation is never duplicated.
 */
export async function probeOcrWebGpu(runtime = globalThis) {
  const gpu = runtime?.navigator?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') {
    return Object.freeze({ available: false, backend: 'wasm', reason: 'api_unavailable' });
  }
  try {
    const adapter = await gpu.requestAdapter();
    return adapter
      ? Object.freeze({ available: true, backend: 'webgpu', reason: null })
      : Object.freeze({ available: false, backend: 'wasm', reason: 'adapter_unavailable' });
  } catch (_) {
    return Object.freeze({ available: false, backend: 'wasm', reason: 'adapter_request_failed' });
  }
}

export async function selectOcrBackend(runtime = globalThis) {
  const webgpu = await probeOcrWebGpu(runtime);
  return Object.freeze({
    preferred: webgpu.available ? 'webgpu' : 'wasm',
    fallback: 'wasm',
    webgpu,
  });
}
