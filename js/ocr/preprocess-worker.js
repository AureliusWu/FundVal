// Light image-only module Worker: no SDK/model/wasm, fetch, storage or logging.
const REQUEST = 'fundval-image-preprocess-request';
const RESPONSE = 'fundval-image-preprocess-response';
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const validDimensions = bitmap => bitmap && positive(bitmap.width) && positive(bitmap.height)
  && Number.isSafeInteger(bitmap.width * bitmap.height) && bitmap.width * bitmap.height <= MAX_PIXELS;
const isBitmap = value => typeof ImageBitmap === 'function' && value instanceof ImageBitmap;
function closeBitmap(bitmap) { if (isBitmap(bitmap)) { try { bitmap.close(); } catch (_) { /* Cleanup stays private. */ } } }
function invalid(code) { const error = new Error('Local image preprocessing failed.'); error.code = code; return error; }

/** Exported for controlled handler tests; production installs it only inside
 * a WorkerGlobalScope. Dependencies are the native local bitmap operations. */
export function createImagePreprocessWorker({
  createBitmap = globalThis.createImageBitmap,
  postMessage = (message, transfer) => globalThis.postMessage(message, transfer),
  closeWorker = () => globalThis.close(),
} = {}) {
  let source = null, busy = false, disposed = false, generation = 0, nextId = 1;
  const current = epoch => !disposed && epoch === generation;
  function dispose() {
    if (disposed) return;
    disposed = true; generation++; busy = false;
    closeBitmap(source); source = null;
    try { closeWorker(); } catch (_) { /* No browser/internal text escapes. */ }
  }
  function failure(message, code, fatal = true) {
    try { postMessage({ kind: RESPONSE, requestId: message.requestId, type: message.type, status: 'error', errorCode: code }); }
    catch (_) { /* A failed transport still releases the realm's owned source. */ }
    if (fatal) dispose();
  }
  async function handleMessage(event) {
    const message = event?.data;
    if (disposed || message?.kind !== REQUEST) return;
    if (!exact(message, ['kind', 'requestId', 'type', 'payload']) || !positive(message.requestId)
      || !['initialize', 'crop', 'destroy'].includes(message.type) || !record(message.payload)) {
      dispose(); return;
    }
    if (message.requestId !== nextId) { failure(message, 'preprocess_invalid_input'); return; }
    nextId++;
    if (message.type === 'destroy') {
      if (!exact(message.payload, [])) failure(message, 'preprocess_invalid_input');
      else dispose();
      return;
    }
    if (busy) { failure(message, 'preprocess_busy', false); return; }
    busy = true;
    const epoch = generation;
    let bitmap = null;
    try {
      if (message.type === 'initialize') {
        const file = message.payload.file;
        if (source || !exact(message.payload, ['file']) || !(typeof Blob === 'function' && file instanceof Blob)
          || !positive(file.size) || file.size > MAX_FILE_BYTES) throw invalid('preprocess_invalid_input');
        if (typeof createBitmap !== 'function') throw invalid('preprocess_unsupported');
        try { bitmap = await createBitmap(file, { imageOrientation: 'from-image' }); }
        catch (_) {
          if (!current(epoch)) return;
          // Compatibility retry stays in this same terminable realm and is
          // forbidden after destroy; it never starts another Worker.
          try { bitmap = await createBitmap(file); }
          catch (_) { throw invalid('preprocess_decode_failed'); }
        }
        if (!current(epoch)) return;
        if (!isBitmap(bitmap) || !validDimensions(bitmap)) throw invalid('preprocess_image_too_large');
        source = bitmap; bitmap = null;
        postMessage({ kind: RESPONSE, requestId: message.requestId, type: message.type, status: 'success',
          payload: { width: source.width, height: source.height } });
      } else {
        const rect = message.payload.rect;
        if (!source || !exact(message.payload, ['rect']) || !exact(rect, ['x', 'y', 'width', 'height'])
          || !Number.isSafeInteger(rect.x) || rect.x < 0 || !Number.isSafeInteger(rect.y) || rect.y < 0
          || !positive(rect.width) || !positive(rect.height) || rect.x + rect.width > source.width
          || rect.y + rect.height > source.height) throw invalid('preprocess_invalid_input');
        try { bitmap = await createBitmap(source, rect.x, rect.y, rect.width, rect.height); }
        catch (_) { throw invalid('preprocess_crop_failed'); }
        if (!current(epoch)) return;
        if (!isBitmap(bitmap) || bitmap.width !== rect.width || bitmap.height !== rect.height) throw invalid('preprocess_crop_failed');
        postMessage({ kind: RESPONSE, requestId: message.requestId, type: message.type, status: 'success',
          payload: { imageBitmap: bitmap } }, [bitmap]);
        // A successful transfer hands ownership to the receiver. On a throw,
        // this assignment is not reached and finally closes our bitmap.
        bitmap = null;
      }
    } catch (error) {
      if (current(epoch)) {
        const allowed = ['preprocess_invalid_input', 'preprocess_unsupported', 'preprocess_decode_failed',
          'preprocess_image_too_large', 'preprocess_crop_failed'];
        failure(message, allowed.includes(error?.code) ? error.code : 'preprocess_worker_failed');
      }
    } finally {
      closeBitmap(bitmap);
      if (current(epoch)) busy = false;
    }
  }
  return Object.freeze({ handleMessage, dispose });
}

if (typeof WorkerGlobalScope === 'function' && globalThis instanceof WorkerGlobalScope) {
  const processor = createImagePreprocessWorker();
  globalThis.addEventListener('message', event => { void processor.handleMessage(event); });
  globalThis.addEventListener('messageerror', () => processor.dispose());
}
