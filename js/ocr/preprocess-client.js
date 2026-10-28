// User-triggered, lightweight image ownership only. No OCR SDK/models, network,
// storage or background preload belongs in this module or its Worker.
const REQUEST = 'fundval-image-preprocess-request';
const RESPONSE = 'fundval-image-preprocess-response';
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const IMAGE_PREPROCESS_TIMEOUTS = Object.freeze({ initialize: 30_000, crop: 15_000 });
const MESSAGES = Object.freeze({
  preprocess_aborted: '截图预处理已取消。',
  preprocess_disposed: '截图预处理已结束，请重新选择截图。',
  preprocess_busy: '正在处理截图，请稍候。',
  preprocess_invalid_input: '请选择有效的本地截图或裁剪区域。',
  preprocess_invalid_state: '截图尚未准备完成，请重新选择。',
  preprocess_invalid_response: '截图预处理结果无效，请重试。',
  preprocess_unsupported: '当前浏览器不支持隔离截图预处理。',
  preprocess_decode_failed: '无法解码本地截图，请更换图片。',
  preprocess_image_too_large: '截图像素过大，请裁剪后重试。',
  preprocess_crop_failed: '无法裁剪本地截图，请重试。',
  preprocess_timeout: '截图预处理超时，请重试。',
  preprocess_worker_failed: '截图预处理失败，请重试。',
});

export class ImagePreprocessError extends Error {
  constructor(code) {
    const safeCode = typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? code : 'preprocess_worker_failed';
    super(MESSAGES[safeCode]); this.name = 'ImagePreprocessError'; this.code = safeCode;
  }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && Object.keys(value).every(key => keys.includes(key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const dimensions = (width, height) => positive(width) && positive(height) && Number.isSafeInteger(width * height) && width * height <= MAX_PIXELS;
const isBitmap = value => typeof ImageBitmap === 'function' && value instanceof ImageBitmap;
function closeBitmap(value) { if (isBitmap(value)) { try { value.close(); } catch (_) { /* No user data in cleanup errors. */ } } }
// A queued transfer may already belong to the main realm when terminate runs.
// Keep only this stateless receiver, not the session handler's closure, so a
// delivered late bitmap is closed rather than relying solely on eventual GC.
function discardLateResponse(event) { closeBitmap(event?.data?.payload?.imageBitmap); }
function validRect(rect, source) {
  return exact(rect, ['x', 'y', 'width', 'height']) && Number.isSafeInteger(rect.x) && rect.x >= 0
    && Number.isSafeInteger(rect.y) && rect.y >= 0 && positive(rect.width) && positive(rect.height)
    && rect.x + rect.width <= source.width && rect.y + rect.height <= source.height;
}

/** Owns one terminable light Worker and at most one pending request. The caller
 * must run the bounded image-header gate before initialize(). Successful crops
 * transfer ownership to the caller, who must close them after its OCR request. */
export function createLocalImagePreprocessor({ signal } = {}) {
  if (signal?.aborted) throw new ImagePreprocessError('preprocess_aborted');
  if (typeof Worker !== 'function') throw new ImagePreprocessError('preprocess_unsupported');
  const url = new URL('./preprocess-worker.js', import.meta.url);
  if (globalThis.location?.origin && url.origin !== globalThis.location.origin) {
    throw new ImagePreprocessError('preprocess_unsupported');
  }
  let worker;
  try { worker = new Worker(url, { type: 'module', name: 'fundval-image-preprocess' }); }
  catch (_) { throw new ImagePreprocessError('preprocess_unsupported'); }
  let state = 'empty', pending = null, nextId = 1, source = null, disposed = false;
  const onAbort = () => stop('preprocess_aborted');

  function stop(code) {
    if (disposed) return;
    disposed = true; state = 'disposed'; source = null;
    const active = pending; pending = null;
    if (active) clearTimeout(active.timer);
    signal?.removeEventListener('abort', onAbort);
    worker.onmessage = discardLateResponse;
    worker.onerror = worker.onmessageerror = null;
    try { worker.terminate(); } catch (_) { /* Never expose browser/internal error text. */ }
    active?.reject(new ImagePreprocessError(code));
  }
  worker.onmessage = event => {
    const message = event?.data, bitmap = message?.payload?.imageBitmap;
    if (disposed || message?.kind !== RESPONSE || !pending || message.requestId !== pending.id) {
      closeBitmap(bitmap); return;
    }
    const active = pending;
    if (message.type !== active.type || !['success', 'error'].includes(message.status)) {
      closeBitmap(bitmap); stop('preprocess_invalid_response'); return;
    }
    if (message.status === 'error') {
      closeBitmap(bitmap);
      const valid = exact(message, ['kind', 'requestId', 'type', 'status', 'errorCode'])
        && typeof message.errorCode === 'string' && Object.hasOwn(MESSAGES, message.errorCode);
      stop(valid ? message.errorCode : 'preprocess_invalid_response'); return;
    }
    const validFrame = exact(message, ['kind', 'requestId', 'type', 'status', 'payload']);
    let value;
    if (active.type === 'initialize' && validFrame && exact(message.payload, ['width', 'height'])
      && dimensions(message.payload.width, message.payload.height)) {
      source = Object.freeze({ width: message.payload.width, height: message.payload.height }); value = source;
    } else if (active.type === 'crop' && validFrame && exact(message.payload, ['imageBitmap'])
      && isBitmap(bitmap) && bitmap.width === active.rect.width && bitmap.height === active.rect.height) {
      value = bitmap;
    } else { closeBitmap(bitmap); stop('preprocess_invalid_response'); return; }
    pending = null; clearTimeout(active.timer); state = 'ready'; active.resolve(value);
  };
  worker.onerror = event => { event?.preventDefault?.(); stop('preprocess_worker_failed'); };
  worker.onmessageerror = () => stop('preprocess_worker_failed');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  function request(type, payload, rect) {
    if (disposed) return Promise.reject(new ImagePreprocessError('preprocess_disposed'));
    if (pending) return Promise.reject(new ImagePreprocessError('preprocess_busy'));
    if (!Number.isSafeInteger(nextId)) { stop('preprocess_worker_failed'); return Promise.reject(new ImagePreprocessError('preprocess_worker_failed')); }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop('preprocess_timeout'), IMAGE_PREPROCESS_TIMEOUTS[type]);
      pending = { id, type, rect, resolve, reject, timer }; state = type === 'initialize' ? 'initializing' : 'cropping';
      try { worker.postMessage({ kind: REQUEST, requestId: id, type, payload }); }
      catch (_) { stop('preprocess_worker_failed'); }
    });
  }
  return Object.freeze({
    async initialize(file) {
      if (disposed) throw new ImagePreprocessError('preprocess_disposed');
      if (pending) throw new ImagePreprocessError('preprocess_busy');
      if (!(typeof Blob === 'function' && file instanceof Blob) || !positive(file.size) || file.size > MAX_FILE_BYTES) {
        throw new ImagePreprocessError('preprocess_invalid_input');
      }
      if (state !== 'empty') throw new ImagePreprocessError('preprocess_invalid_state');
      return request('initialize', { file });
    },
    async crop(rect) {
      if (disposed) throw new ImagePreprocessError('preprocess_disposed');
      if (pending) throw new ImagePreprocessError('preprocess_busy');
      if (state !== 'ready' || !source) throw new ImagePreprocessError('preprocess_invalid_state');
      if (!validRect(rect, source)) throw new ImagePreprocessError('preprocess_invalid_input');
      const safeRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      return request('crop', { rect: safeRect }, safeRect);
    },
    dispose() { stop('preprocess_disposed'); },
  });
}
