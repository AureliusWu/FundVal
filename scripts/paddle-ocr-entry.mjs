// Lightweight page-side facade for the local PaddleOCR engine. The heavy
// Paddle/OpenCV runtime is imported only inside our module Worker so Android
// does not parse or retain a second copy on the main thread.
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

const REQUEST_KIND = 'worker-transport-request';
const RESPONSE_KIND = 'worker-transport-response';
const SAFE_WORKER_ERRORS = Object.freeze({
  'invalid-request': 'PaddleOCR worker rejected an invalid request.',
  'invalid-assets': 'PaddleOCR worker rejected a non-local asset.',
  'unsupported-runtime': 'PaddleOCR worker is not supported in this browser.',
  'not-initialized': 'PaddleOCR worker is not ready.',
  'already-disposed': 'PaddleOCR worker has already been disposed.',
  'engine-failure': 'PaddleOCR worker operation failed.',
});

function resolveSameOriginAsset(relativePath) {
  const assetUrl = new URL(relativePath, import.meta.url);
  const currentOrigin = globalThis.location && globalThis.location.origin;
  if (currentOrigin && assetUrl.origin !== currentOrigin) {
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

function toSafeWorkerError(code) {
  return new Error(SAFE_WORKER_ERRORS[code] || SAFE_WORKER_ERRORS['engine-failure']);
}

function isTransferableImageBitmap(image) {
  return typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
}

function createWorkerClient() {
  if (typeof Worker !== 'function') {
    throw toSafeWorkerError('unsupported-runtime');
  }

  // The exact-pinned official Worker is copied verbatim by the build because
  // Vite tree-shakes its side-effect-only deep import. It remains relative to
  // this facade for GitHub Pages project paths.
  const workerUrl = new URL(/* @vite-ignore */ './assets/fundval-paddle-worker.js', import.meta.url);
  const currentOrigin = globalThis.location && globalThis.location.origin;
  if (currentOrigin && workerUrl.origin !== currentOrigin) {
    throw new Error('PaddleOCR worker must stay on the current origin.');
  }

  const worker = new Worker(workerUrl, {
    type: 'module',
    name: 'fundval-paddle-ocr',
  });
  const pending = new Map();
  let nextRequestId = 1;
  let terminated = false;

  const rejectPending = code => {
    const safeError = toSafeWorkerError(code);
    for (const request of pending.values()) request.reject(safeError);
    pending.clear();
  };

  const terminate = (code = 'engine-failure') => {
    if (terminated) return;
    terminated = true;
    rejectPending(code);
    worker.terminate();
  };

  worker.onmessage = event => {
    const response = event.data;
    if (!response || response.kind !== RESPONSE_KIND || !Number.isSafeInteger(response.requestId)) return;
    const request = pending.get(response.requestId);
    if (!request) return;
    pending.delete(response.requestId);
    if (response.status === 'success') request.resolve(response.payload);
    else request.reject(toSafeWorkerError(response.errorCode));
  };

  worker.onerror = event => {
    // Suppress browser-default logging of internal URLs/stacks. Callers get a
    // stable, data-free error instead.
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    terminate('engine-failure');
  };
  worker.onmessageerror = () => terminate('engine-failure');

  return Object.freeze({
    request(type, payload = {}, transferables = []) {
      if (terminated) return Promise.reject(toSafeWorkerError('already-disposed'));
      const requestId = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        try {
          worker.postMessage({ kind: REQUEST_KIND, requestId, type, payload }, transferables);
        } catch {
          pending.delete(requestId);
          reject(toSafeWorkerError('engine-failure'));
        }
      });
    },
    terminate,
  });
}

/**
 * Creates an isolated, same-origin PaddleOCR Worker for a user-selected
 * screenshot. The page-side module never imports PaddleOCR or OpenCV. Callers
 * own input validation and must dispose the returned facade.
 */
export async function createLocalPaddleOcr({ onProgress } = {}) {
  const assets = Object.freeze({
    detection: resolveSameOriginAsset(LOCAL_MODEL_PATHS.detection),
    recognition: resolveSameOriginAsset(LOCAL_MODEL_PATHS.recognition),
    ortDirectory: resolveSameOriginAsset(LOCAL_MODEL_PATHS.ortDirectory),
  });

  emitProgress(onProgress, 'initializing');
  const client = createWorkerClient();
  try {
    await client.request('init', {
      options: {
        pipelineConfig: {
          pipelineName: 'OCR',
          raw: {
            pipeline_name: 'OCR',
            text_type: 'general',
            use_doc_preprocessor: false,
            use_textline_orientation: false,
            SubPipelines: {
              DocPreprocessor: {
                pipeline_name: 'doc_preprocessor',
                use_doc_orientation_classify: false,
                use_doc_unwarping: false,
                SubModules: {
                  DocOrientationClassify: {
                    module_name: 'doc_text_orientation',
                    model_name: 'PP-LCNet_x1_0_doc_ori',
                    model_dir: null,
                  },
                  DocUnwarping: {
                    module_name: 'image_unwarping',
                    model_name: 'UVDoc',
                    model_dir: null,
                  },
                },
              },
            },
            SubModules: {
              TextDetection: {
                module_name: 'text_detection',
                model_name: 'PP-OCRv5_mobile_det',
                model_dir: null,
                limit_side_len: 64,
                limit_type: 'min',
                max_side_limit: 4000,
                thresh: 0.3,
                box_thresh: 0.6,
                unclip_ratio: 1.5,
              },
              TextLineOrientation: {
                module_name: 'textline_orientation',
                model_name: 'PP-LCNet_x1_0_textline_ori',
                model_dir: null,
                batch_size: 6,
              },
              TextRecognition: {
                module_name: 'text_recognition',
                model_name: 'PP-OCRv5_mobile_rec',
                model_dir: null,
                batch_size: 6,
                score_thresh: 0,
              },
            },
          },
          warnings: [
            'DocPreprocessor is not yet supported in PaddleOCR.js: config will be ignored for now.',
            'TextLineOrientation is not yet supported in PaddleOCR.js: config will be ignored for now.',
          ],
          unsupportedFeatures: ['DocPreprocessor', 'TextLineOrientation'],
          modelSelection: {
            textDetectionModelName: 'PP-OCRv6_tiny_det',
            textRecognitionModelName: 'PP-OCRv6_tiny_rec',
          },
          assets: {
            det: { url: assets.detection },
            rec: { url: assets.recognition },
          },
          runtimeDefaults: {
            text_det_limit_side_len: 64,
            text_det_limit_type: 'min',
            text_det_max_side_limit: 4000,
            text_det_thresh: 0.3,
            text_det_box_thresh: 0.6,
            text_det_unclip_ratio: 1.5,
            text_rec_score_thresh: 0,
          },
          pipelineBatchSize: 1,
          textDetectionBatchSize: 1,
          textRecognitionBatchSize: 1,
        },
        ortOptions: {
          backend: 'wasm',
          wasmPaths: assets.ortDirectory,
          numThreads: 1,
          simd: true,
          proxy: false,
          disableWasmProxy: true,
        },
      },
    });
  } catch (error) {
    client.terminate();
    throw error;
  }

  let disposed = false;
  emitProgress(onProgress, 'ready');

  return Object.freeze({
    async predict(image, options = {}) {
      if (disposed) throw toSafeWorkerError('already-disposed');
      if (typeof image === 'string') {
        throw new TypeError('PaddleOCR local import does not accept image URLs.');
      }
      emitProgress(onProgress, 'recognizing');
      try {
        // Transfer ImageBitmap ownership to avoid a structured clone and the
        // SDK's worker-mode createImageBitmap clone. A Blob is first decoded to
        // a local ImageBitmap, then that bitmap is transferred the same way.
        const imageBitmap = isTransferableImageBitmap(image)
          ? image
          : await createImageBitmap(image);
        return await client.request('predict', {
          sources: [{ kind: 'imageBitmap', imageBitmap }],
          params: { ...DEFAULT_PREDICT_OPTIONS, ...options },
        }, [imageBitmap]);
      } finally {
        emitProgress(onProgress, 'recognized');
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await client.request('dispose');
      } finally {
        client.terminate('already-disposed');
        emitProgress(onProgress, 'disposed');
      }
    },
  });
}

export const LOCAL_PADDLE_OCR_DEFAULT_PREDICT_OPTIONS = DEFAULT_PREDICT_OPTIONS;
