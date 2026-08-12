import { PaddleOCR } from '@paddleocr/paddleocr-js';

// This entry is bundled by Vite into a lazy, same-origin module.  Keep model
// and WASM paths relative to this module so GitHub Pages project paths work.
const LOCAL_MODEL_PATHS = Object.freeze({
  detection: '../models/PP-OCRv6_tiny_det_onnx_infer.tar',
  recognition: '../models/PP-OCRv6_tiny_rec_onnx_infer.tar',
  ortDirectory: '../ort/',
});

const DEFAULT_PREDICT_OPTIONS = Object.freeze({
  textDetLimitType: 'max',
  textDetLimitSideLen: 1600,
  textDetMaxSideLimit: 2048,
  textDetThresh: 0.3,
  textDetBoxThresh: 0.35,
  textDetUnclipRatio: 1.5,
  textRecScoreThresh: 0.15,
});

function resolveSameOriginAsset(relativePath) {
  const assetUrl = new URL(relativePath, import.meta.url);
  if (typeof window !== 'undefined' && assetUrl.origin !== window.location.origin) {
    throw new Error('PaddleOCR local asset must stay on the current origin.');
  }
  return assetUrl.href;
}

function emitProgress(onProgress, phase) {
  if (typeof onProgress === 'function') {
    try {
      onProgress({ engine: 'paddleocr', phase });
    } catch {
      // UI progress is advisory and must never retain or expose OCR output.
    }
  }
}

/**
 * Creates an isolated, same-origin PaddleOCR instance for a user-selected
 * screenshot. No model, WASM, worker, or image URL is allowed to fall back to
 * a CDN. Callers own image validation and must dispose the returned instance.
 */
export async function createLocalPaddleOcr({ onProgress } = {}) {
  const textDetectionModelAsset = {
    url: resolveSameOriginAsset(LOCAL_MODEL_PATHS.detection),
  };
  const textRecognitionModelAsset = {
    url: resolveSameOriginAsset(LOCAL_MODEL_PATHS.recognition),
  };
  const wasmPaths = resolveSameOriginAsset(LOCAL_MODEL_PATHS.ortDirectory);

  emitProgress(onProgress, 'initializing');
  const instance = await PaddleOCR.create({
    worker: true,
    textDetectionModelName: 'PP-OCRv6_tiny_det',
    textRecognitionModelName: 'PP-OCRv6_tiny_rec',
    textDetectionModelAsset,
    textRecognitionModelAsset,
    textDetectionBatchSize: 1,
    textRecognitionBatchSize: 2,
    ortOptions: {
      backend: 'wasm',
      wasmPaths,
      // GitHub Pages does not provide cross-origin isolation, so do not rely
      // on multi-threaded SharedArrayBuffer execution.
      numThreads: 1,
      simd: true,
      proxy: false,
    },
  });
  let disposed = false;
  emitProgress(onProgress, 'ready');

  return Object.freeze({
    async predict(image, options = {}) {
      if (disposed) {
        throw new Error('PaddleOCR instance has already been disposed.');
      }
      if (typeof image === 'string') {
        throw new TypeError('PaddleOCR local import does not accept image URLs.');
      }
      emitProgress(onProgress, 'recognizing');
      try {
        return await instance.predict(image, {
          ...DEFAULT_PREDICT_OPTIONS,
          ...options,
        });
      } finally {
        emitProgress(onProgress, 'recognized');
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await instance.dispose();
      } finally {
        emitProgress(onProgress, 'disposed');
      }
    },
  });
}

export const LOCAL_PADDLE_OCR_DEFAULT_PREDICT_OPTIONS = DEFAULT_PREDICT_OPTIONS;
