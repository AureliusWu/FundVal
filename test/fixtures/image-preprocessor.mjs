import { createImagePreprocessWorker } from '../../js/ocr/preprocess-worker.js';
import { ImagePreprocessError } from '../../js/ocr/preprocess-client.js';

// Adapter test double only: preserve existing source/crop counters while the
// production adapter consumes only the new initialize/crop/dispose contract.
export function bitmapPreprocessor(createBitmap, onDispose = () => {}) {
  return () => {
    let source = null, disposed = false;
    return {
      async initialize(file) { source = await createBitmap(file); return { width: source.width, height: source.height }; },
      async crop(rect) { return createBitmap(source, rect.x, rect.y, rect.width, rect.height); },
      dispose() { if (disposed) return; disposed = true; onDispose(); source?.close(); source = null; },
    };
  };
}

export class HandlerBitmap {
  constructor(width = 100, height = 100, onClose = () => {}) {
    this.width = width; this.height = height; this.onClose = onClose;
  }
  close() { this.onClose(); }
}
export function installHandlerBitmap(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap');
  Object.defineProperty(globalThis, 'ImageBitmap', { configurable: true, value: HandlerBitmap });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'ImageBitmap', descriptor); else delete globalThis.ImageBitmap; });
}

// Compatibility-decode tests execute the ACTUAL lightweight Worker handler,
// not a new production fallback. Native Worker transport is covered separately.
export function handlerPreprocessor(createBitmap) {
  return ({ signal } = {}) => {
    let response, requestId = 0;
    const worker = createImagePreprocessWorker({ createBitmap, postMessage(message) { response = message; }, closeWorker() {} });
    const abort = () => worker.dispose();
    signal?.addEventListener('abort', abort, { once: true });
    async function send(type, payload) {
      response = null;
      await worker.handleMessage({ data: { kind: 'fundval-image-preprocess-request', requestId: ++requestId, type, payload } });
      if (signal?.aborted) throw new ImagePreprocessError('preprocess_aborted');
      if (!response || response.status !== 'success') throw new ImagePreprocessError(response?.errorCode);
      return response.payload;
    }
    return {
      initialize: file => send('initialize', { file }),
      crop: async rect => (await send('crop', { rect })).imageBitmap,
      dispose() { signal?.removeEventListener('abort', abort); worker.dispose(); },
    };
  };
}

// The capability probe remains available, but the adapter must not decode in
// the page realm. This detects an ignored createImagePreprocessor injection.
export function unexpectedPageBitmap() { throw new Error('synthetic unexpected page bitmap decode'); }
