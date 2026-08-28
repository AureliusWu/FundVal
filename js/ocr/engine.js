import {
  canAttemptWebGpu,
  canUseWasmOcr,
  detectOcrCapabilities,
} from './capability.js';

export const OCR_BACKEND = Object.freeze({
  WEBGPU: 'webgpu',
  WASM: 'wasm',
});

export const OCR_ENGINE_ERROR = Object.freeze({
  INVALID_INPUT: 'OCR_INVALID_INPUT',
  CAPABILITY_UNAVAILABLE: 'OCR_CAPABILITY_UNAVAILABLE',
  BACKEND_UNAVAILABLE: 'OCR_BACKEND_UNAVAILABLE',
  INITIALIZATION_FAILED: 'OCR_INITIALIZATION_FAILED',
  RECOGNITION_FAILED: 'OCR_RECOGNITION_FAILED',
  DISPOSE_FAILED: 'OCR_DISPOSE_FAILED',
  DISPOSED: 'OCR_ENGINE_DISPOSED',
  UNEXPECTED: 'OCR_UNEXPECTED',
});

const ERROR_DEFINITIONS = Object.freeze({
  [OCR_ENGINE_ERROR.INVALID_INPUT]: Object.freeze({
    category: 'input',
    message: '仅支持用户选择的本地图片文件。',
  }),
  [OCR_ENGINE_ERROR.CAPABILITY_UNAVAILABLE]: Object.freeze({
    category: 'capability',
    message: '当前浏览器不具备本地识别所需能力。',
  }),
  [OCR_ENGINE_ERROR.BACKEND_UNAVAILABLE]: Object.freeze({
    category: 'initialization',
    message: '本地识别引擎未正确配置。',
  }),
  [OCR_ENGINE_ERROR.INITIALIZATION_FAILED]: Object.freeze({
    category: 'initialization',
    message: '本地识别引擎初始化失败。',
  }),
  [OCR_ENGINE_ERROR.RECOGNITION_FAILED]: Object.freeze({
    category: 'recognition',
    message: '本地识别失败，请重试。',
  }),
  [OCR_ENGINE_ERROR.DISPOSE_FAILED]: Object.freeze({
    category: 'lifecycle',
    message: '本地识别引擎释放失败。',
  }),
  [OCR_ENGINE_ERROR.DISPOSED]: Object.freeze({
    category: 'lifecycle',
    message: '本地识别引擎已释放。',
  }),
  [OCR_ENGINE_ERROR.UNEXPECTED]: Object.freeze({
    category: 'internal',
    message: '本地识别发生未知错误。',
  }),
});

function errorDefinition(code) {
  return ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS[OCR_ENGINE_ERROR.UNEXPECTED];
}

/**
 * Public OCR errors contain only fixed codes and fixed messages. Raw backend
 * errors, model paths, image names, OCR text, and Blob contents are never
 * attached to the public error or its JSON representation.
 */
export class OcrEngineError extends Error {
  constructor(code, { stage = null, backend = null } = {}) {
    const normalizedCode = ERROR_DEFINITIONS[code] ? code : OCR_ENGINE_ERROR.UNEXPECTED;
    const definition = errorDefinition(normalizedCode);
    super(definition.message);
    this.name = 'OcrEngineError';
    this.code = normalizedCode;
    this.category = definition.category;
    this.stage = typeof stage === 'string' ? stage : null;
    this.backend = Object.values(OCR_BACKEND).includes(backend) ? backend : null;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      stage: this.stage,
      backend: this.backend,
    };
  }
}

export function classifyOcrEngineError(error) {
  if (error instanceof OcrEngineError) return Object.freeze(error.toJSON());
  const fallback = new OcrEngineError(OCR_ENGINE_ERROR.UNEXPECTED);
  return Object.freeze(fallback.toJSON());
}

export function isLocalOcrBlob(input, runtime = globalThis) {
  const BlobConstructor = runtime?.Blob || globalThis.Blob;
  return typeof BlobConstructor === 'function'
    && input instanceof BlobConstructor
    && Number.isFinite(input.size)
    && input.size > 0;
}

export function assertLocalOcrBlob(input, runtime = globalThis) {
  if (!isLocalOcrBlob(input, runtime)) {
    throw new OcrEngineError(OCR_ENGINE_ERROR.INVALID_INPUT, { stage: 'input' });
  }
  return input;
}

function assertBackend(backend, kind) {
  if (!backend || typeof backend !== 'object' || typeof backend.recognize !== 'function') {
    throw new OcrEngineError(OCR_ENGINE_ERROR.BACKEND_UNAVAILABLE, {
      stage: 'initialization',
      backend: kind,
    });
  }
  return backend;
}

function createMonotonicClock(runtime) {
  const performanceNow = runtime?.performance?.now;
  if (typeof performanceNow === 'function') {
    return () => {
      const value = Number(performanceNow.call(runtime.performance));
      return Number.isFinite(value) ? value : Date.now();
    };
  }
  return () => Date.now();
}

function elapsedMilliseconds(now, startedAt) {
  const value = Number(now()) - Number(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export class LocalOcrEngine {
  constructor({
    runtime = globalThis,
    detectCapabilities = detectOcrCapabilities,
    backends = {},
    validateInput = assertLocalOcrBlob,
  } = {}) {
    if (typeof detectCapabilities !== 'function') {
      throw new TypeError('detectCapabilities must be a function');
    }
    if (typeof validateInput !== 'function') {
      throw new TypeError('validateInput must be a function');
    }
    this.runtime = runtime || {};
    this.now = createMonotonicClock(this.runtime);
    this.detectCapabilities = detectCapabilities;
    this.validateInput = validateInput;
    this.backendFactories = Object.freeze({
      [OCR_BACKEND.WEBGPU]: backends?.[OCR_BACKEND.WEBGPU],
      [OCR_BACKEND.WASM]: backends?.[OCR_BACKEND.WASM],
    });
    this.state = 'idle';
    this.backend = null;
    this.backendKind = null;
    this.capabilities = null;
    this.fallback = null;
    this.attempted = {
      [OCR_BACKEND.WEBGPU]: false,
      [OCR_BACKEND.WASM]: false,
    };
    this.initializationPromise = null;
    this.disposePromise = null;
    this.disposed = false;
    this.disposedBackends = new WeakSet();
    this.activeOperations = new Set();
    this.metrics = {
      initializationMs: 0,
      recognitionMs: 0,
      recognitionCount: 0,
    };
  }

  get diagnostics() {
    return Object.freeze({
      state: this.state,
      backend: this.backendKind,
      webgpuAttempted: this.attempted[OCR_BACKEND.WEBGPU],
      wasmAttempted: this.attempted[OCR_BACKEND.WASM],
      fallback: this.fallback ? Object.freeze({ ...this.fallback }) : null,
      initializationMs: this.metrics.initializationMs,
      recognitionMs: this.metrics.recognitionMs,
      recognitionCount: this.metrics.recognitionCount,
    });
  }

  initialize() {
    if (this.disposed) {
      return Promise.reject(new OcrEngineError(OCR_ENGINE_ERROR.DISPOSED, { stage: 'initialization' }));
    }
    if (this.initializationPromise) return this.initializationPromise;

    this.state = 'initializing';
    const startedAt = this.now();
    this.initializationPromise = this.initializeOnce().finally(() => {
      this.metrics.initializationMs = elapsedMilliseconds(this.now, startedAt);
    });
    return this.initializationPromise;
  }

  async initializeOnce() {
    try {
      this.capabilities = this.detectCapabilities(this.runtime);
      if (!this.capabilities?.baseline?.supported || !canUseWasmOcr(this.capabilities)) {
        throw new OcrEngineError(OCR_ENGINE_ERROR.CAPABILITY_UNAVAILABLE, {
          stage: 'capability',
        });
      }

      if (canAttemptWebGpu(this.capabilities)) {
        try {
          return await this.initializeBackend(OCR_BACKEND.WEBGPU);
        } catch (error) {
          if (this.disposed || (error instanceof OcrEngineError && error.code === OCR_ENGINE_ERROR.DISPOSED)) {
            throw new OcrEngineError(OCR_ENGINE_ERROR.DISPOSED, { stage: 'initialization' });
          }
          this.fallback = Object.freeze({
            from: OCR_BACKEND.WEBGPU,
            to: OCR_BACKEND.WASM,
            reason: error instanceof OcrEngineError
              && error.code === OCR_ENGINE_ERROR.BACKEND_UNAVAILABLE
              ? 'backend_unavailable'
              : 'initialization_failed',
          });
        }
      }

      return await this.initializeBackend(OCR_BACKEND.WASM);
    } catch (error) {
      this.state = this.disposed ? 'disposed' : 'failed';
      if (error instanceof OcrEngineError) throw error;
      throw new OcrEngineError(OCR_ENGINE_ERROR.INITIALIZATION_FAILED, {
        stage: 'initialization',
        backend: this.attempted[OCR_BACKEND.WASM] ? OCR_BACKEND.WASM : OCR_BACKEND.WEBGPU,
      });
    }
  }

  async initializeBackend(kind) {
    if (this.attempted[kind]) {
      throw new OcrEngineError(OCR_ENGINE_ERROR.INITIALIZATION_FAILED, {
        stage: 'initialization',
        backend: kind,
      });
    }
    this.attempted[kind] = true;
    const factory = this.backendFactories[kind];
    if (typeof factory !== 'function') {
      throw new OcrEngineError(OCR_ENGINE_ERROR.BACKEND_UNAVAILABLE, {
        stage: 'initialization',
        backend: kind,
      });
    }

    let candidate = null;
    try {
      candidate = assertBackend(await factory({
        backend: kind,
        capabilities: this.capabilities,
      }), kind);
      if (typeof candidate.initialize === 'function') {
        await candidate.initialize({ backend: kind });
      }
      if (typeof candidate.isModelCompatible === 'function'
        && await candidate.isModelCompatible() !== true) {
        throw new OcrEngineError(OCR_ENGINE_ERROR.INITIALIZATION_FAILED, {
          stage: 'model_compatibility',
          backend: kind,
        });
      }
      if (this.disposed) {
        await this.safeDisposeBackend(candidate);
        throw new OcrEngineError(OCR_ENGINE_ERROR.DISPOSED, { stage: 'initialization' });
      }
      this.backend = candidate;
      this.backendKind = kind;
      this.state = 'ready';
      return candidate;
    } catch (error) {
      if (candidate) await this.safeDisposeBackend(candidate);
      if (error instanceof OcrEngineError) throw error;
      throw new OcrEngineError(OCR_ENGINE_ERROR.INITIALIZATION_FAILED, {
        stage: 'initialization',
        backend: kind,
      });
    }
  }

  recognize(input, ...args) {
    this.validateInput(input, this.runtime);
    if (this.disposed) {
      throw new OcrEngineError(OCR_ENGINE_ERROR.DISPOSED, { stage: 'recognition' });
    }

    const startedAt = this.now();
    const operation = (async () => {
      const backend = await this.initialize();
      if (this.disposed) {
        throw new OcrEngineError(OCR_ENGINE_ERROR.DISPOSED, { stage: 'recognition' });
      }
      try {
        return await backend.recognize(input, ...args);
      } catch (error) {
        if (error instanceof OcrEngineError && error.code === OCR_ENGINE_ERROR.DISPOSED) throw error;
        throw new OcrEngineError(OCR_ENGINE_ERROR.RECOGNITION_FAILED, {
          stage: 'recognition',
          backend: this.backendKind,
        });
      }
    })().finally(() => {
      this.metrics.recognitionMs = elapsedMilliseconds(this.now, startedAt);
      this.metrics.recognitionCount += 1;
    });

    this.activeOperations.add(operation);
    operation.then(
      () => this.activeOperations.delete(operation),
      () => this.activeOperations.delete(operation),
    );
    return operation;
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.state = 'disposing';
    this.disposePromise = (async () => {
      if (this.initializationPromise) {
        await this.initializationPromise.catch(() => {});
      }
      if (this.activeOperations.size) {
        await Promise.allSettled([...this.activeOperations]);
      }
      const backend = this.backend;
      this.backend = null;
      try {
        if (backend) await this.safeDisposeBackend(backend, true);
      } finally {
        this.state = 'disposed';
      }
    })();
    return this.disposePromise;
  }

  async safeDisposeBackend(backend, reportFailure = false) {
    if (!backend || (typeof backend !== 'object' && typeof backend !== 'function')) return;
    if (this.disposedBackends.has(backend)) return;
    this.disposedBackends.add(backend);
    if (typeof backend.dispose !== 'function') return;
    try {
      await backend.dispose();
    } catch {
      if (reportFailure) {
        throw new OcrEngineError(OCR_ENGINE_ERROR.DISPOSE_FAILED, { stage: 'dispose' });
      }
    }
  }
}

export function createOcrEngine(options) {
  return new LocalOcrEngine(options);
}
