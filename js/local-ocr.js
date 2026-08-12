const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2200;
const MAX_SOURCE_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_OCR_TILE_PIXELS = 4 * 1024 * 1024;
const MAX_OCR_TILE_COUNT = 12;
const OCR_TILE_OVERLAP = 96;
const LONG_SCREENSHOT_ASPECT_RATIO = 2;
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ACCEPTED_IMAGE_SUFFIXES = ['.png', '.jpg', '.jpeg', '.webp'];

const OCR_ENGINE_URL = new URL('../assets/ocr/tesseract/tesseract.esm.min.js', import.meta.url).href;
const OCR_WORKER_URL = new URL('../assets/ocr/tesseract/worker.min.js', import.meta.url).href;
const OCR_CORE_URL = new URL('../assets/ocr/tesseract-core/tesseract-core-lstm.wasm.js', import.meta.url).href;
const OCR_LANG_URL = new URL('../assets/ocr/tessdata/', import.meta.url).href;

// PSM 4 treats each prepared vertical tile as a single-column list/page. The
// Tesseract.js PSM enum uses string values, and a worker retains this setting
// for every subsequent recognize() call (including all screenshot tiles).
export const ALIPAY_OCR_RECOGNITION_PARAMETERS = Object.freeze({
  tessedit_pageseg_mode: '4',
});

let workerPromise = null;

export class LocalOcrError extends Error {
  constructor(message = '本地识别暂时不可用，请更换清晰截图后重试。') {
    super(message);
    this.name = 'LocalOcrError';
  }
}

function isBlob(value) {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function fileSuffix(file) {
  const name = String(file && file.name || '').trim().toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}

export function isSupportedOcrImage(file) {
  if (!isBlob(file)) return false;
  return ACCEPTED_IMAGE_TYPES.has(String(file.type || '').toLowerCase())
    || ACCEPTED_IMAGE_SUFFIXES.includes(fileSuffix(file));
}

export function validateOcrImage(file) {
  if (!isBlob(file)) throw new LocalOcrError('请选择 PNG、JPG 或 WEBP 格式的本地截图。');
  if (!isSupportedOcrImage(file)) throw new LocalOcrError('仅支持 PNG、JPG 或 WEBP 格式的截图。');
  if (!Number.isFinite(file.size) || file.size <= 0) throw new LocalOcrError('截图文件为空，请重新选择。');
  if (file.size > MAX_IMAGE_BYTES) throw new LocalOcrError('截图超过 16MB，请裁剪或压缩后重试。');
  return true;
}

function hasImageSignature(bytes) {
  const startsWith = values => values.every((value, index) => bytes[index] === value);
  const isPng = bytes.length >= 8 && startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isJpeg = bytes.length >= 3 && startsWith([0xff, 0xd8, 0xff]);
  const isWebp = bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  return isPng || isJpeg || isWebp;
}

// MIME types and extensions are user-controlled. Check the small image header
// before passing a local Blob to canvas/OCR so an SVG or arbitrary document
// renamed to .png is never decoded in this flow.
export async function verifyOcrImageSignature(file) {
  validateOcrImage(file);
  if (typeof file.slice !== 'function') throw new LocalOcrError('无法读取截图文件，请重新选择。');
  try {
    const header = await file.slice(0, 12).arrayBuffer();
    if (!hasImageSignature(new Uint8Array(header))) {
      throw new LocalOcrError('截图内容不是有效的 PNG、JPG 或 WEBP 图片。');
    }
    return true;
  } catch (error) {
    if (error instanceof LocalOcrError) throw error;
    throw new LocalOcrError('无法验证截图文件，请重新选择。');
  }
}

export function fitOcrImageSize(width, height, maxSide = MAX_IMAGE_SIDE) {
  const sourceWidth = Number(width);
  const sourceHeight = Number(height);
  const maximumSide = Number(maxSide);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0
    || !Number.isFinite(maximumSide) || maximumSide <= 0) {
    throw new LocalOcrError('无法读取截图尺寸，请更换图片后重试。');
  }
  if (sourceWidth * sourceHeight > MAX_SOURCE_IMAGE_PIXELS) {
    throw new LocalOcrError('截图像素过大，请裁剪为较短的截图后重试。');
  }
  // A long mobile screenshot is processed as small vertical tiles below. Its
  // width is the limiting factor for Chinese OCR, so do not shrink it merely
  // because its scroll height exceeds one tile.
  const isLongScreenshot = sourceHeight / sourceWidth >= LONG_SCREENSHOT_ASPECT_RATIO;
  const ratio = isLongScreenshot
    ? Math.min(1, maximumSide / sourceWidth)
    : Math.min(1, maximumSide / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * ratio)),
    height: Math.max(1, Math.round(sourceHeight * ratio)),
    scaled: ratio < 1,
  };
}

/**
 * Split a prepared image into overlapping vertical OCR tiles. Keeping every
 * canvas below both a dimension and pixel budget avoids materializing a very
 * tall screenshot as one large intermediate bitmap.
 */
export function planOcrImageTiles(width, height) {
  const targetWidth = Number(width);
  const targetHeight = Number(height);
  if (!Number.isFinite(targetWidth) || !Number.isFinite(targetHeight) || targetWidth <= 0 || targetHeight <= 0) {
    throw new LocalOcrError('无法读取截图尺寸，请更换图片后重试。');
  }
  const tileWidth = Math.max(1, Math.round(targetWidth));
  const fullHeight = Math.max(1, Math.round(targetHeight));
  const maxTileHeight = Math.max(1, Math.min(
    MAX_IMAGE_SIDE,
    Math.floor(MAX_OCR_TILE_PIXELS / tileWidth),
  ));
  const overlap = Math.min(OCR_TILE_OVERLAP, Math.max(0, maxTileHeight - 1));
  const step = Math.max(1, maxTileHeight - overlap);
  const tiles = [];
  let y = 0;

  while (y < fullHeight) {
    const tileHeight = Math.min(maxTileHeight, fullHeight - y);
    const isFirst = y === 0;
    const isLast = y + tileHeight >= fullHeight;
    tiles.push({
      x: 0,
      y,
      width: tileWidth,
      height: tileHeight,
      // Only one tile owns each point in the overlap when block coordinates
      // are merged. This prevents duplicate holdings at tile boundaries.
      contentTop: isFirst ? y : y + Math.floor(overlap / 2),
      contentBottom: isLast ? y + tileHeight : y + tileHeight - Math.ceil(overlap / 2),
    });
    if (isLast) break;
    if (tiles.length >= MAX_OCR_TILE_COUNT) {
      throw new LocalOcrError('截图过长，请裁剪为较短的截图后重试。');
    }
    y += step;
  }
  return tiles;
}

function report(onProgress, phase, progress) {
  if (typeof onProgress !== 'function') return;
  onProgress({ phase, progress: Number.isFinite(progress) ? progress : null });
}

async function loadImageForCanvas(file) {
  if (typeof createImageBitmap === 'function') {
    // Some Safari versions expose createImageBitmap but reject the orientation
    // option. Fall back to the basic bitmap form, then to the local Image path.
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) {
      try { bitmap = await createImageBitmap(file); } catch (_) { bitmap = null; }
    }
    if (bitmap) {
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap,
        dispose() { bitmap.close(); },
      };
    }
  }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new LocalOcrError('当前浏览器不支持本地截图预处理。');
  }
  const objectUrl = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      source: image,
      dispose() { URL.revokeObjectURL(objectUrl); },
    });
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new LocalOcrError('无法读取截图，请更换图片后重试。'));
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new LocalOcrError('截图预处理失败，请更换清晰的截图后重试。'));
    }, 'image/png');
  });
}

async function prepareOcrImageTile(canvas, image, size, tile) {
  canvas.width = tile.width;
  canvas.height = tile.height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new LocalOcrError('当前浏览器不支持截图预处理。');
  const sourceTop = Math.floor(tile.y * image.height / size.height);
  const sourceBottom = Math.min(image.height, Math.ceil((tile.y + tile.height) * image.height / size.height));
  const sourceHeight = Math.max(1, sourceBottom - sourceTop);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, tile.width, tile.height);
  context.filter = 'contrast(1.08)';
  context.drawImage(image.source, 0, sourceTop, image.width, sourceHeight, 0, 0, tile.width, tile.height);
  context.filter = 'none';
  return { ...tile, blob: await canvasToBlob(canvas) };
}

async function forEachPreparedOcrTile(file, { onProgress, onTile } = {}) {
  await verifyOcrImageSignature(file);
  report(onProgress, 'preparing', 0.04);
  let image;
  try {
    image = await loadImageForCanvas(file);
    const size = fitOcrImageSize(image.width, image.height);
    const tiles = planOcrImageTiles(size.width, size.height);
    // Reuse exactly one canvas and wait for each consumer before producing the
    // next tile, so tall screenshots do not accumulate bitmap or OCR work.
    const canvas = document.createElement('canvas');
    try {
      for (let index = 0; index < tiles.length; index += 1) {
        const tile = await prepareOcrImageTile(canvas, image, size, tiles[index]);
        report(onProgress, 'preparing', 0.04 + 0.14 * ((index + 1) / tiles.length));
        if (typeof onTile === 'function') await onTile(tile, index, tiles.length);
      }
    } finally {
      canvas.width = 1;
      canvas.height = 1;
    }
    return size;
  } catch (error) {
    if (error instanceof LocalOcrError) throw error;
    throw new LocalOcrError('截图预处理失败，请更换清晰的截图后重试。');
  } finally {
    if (image) image.dispose();
  }
}

function progressFromWorker(message) {
  const status = String(message && message.status || 'recognizing');
  const progress = Number(message && message.progress);
  if (status.includes('loading tesseract core')) return { phase: 'loading-core', progress };
  if (status.includes('loading language')) return { phase: 'loading-language', progress };
  if (status.includes('initializing')) return { phase: 'initializing', progress };
  return { phase: 'recognizing', progress };
}

export async function configureAlipayOcrWorker(worker) {
  if (!worker || typeof worker.setParameters !== 'function') throw new LocalOcrError();
  await worker.setParameters(ALIPAY_OCR_RECOGNITION_PARAMETERS);
  return worker;
}

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      report(onProgress, 'loading-engine', 0.2);
      const module = await import(OCR_ENGINE_URL);
      const Tesseract = module && (module.default || module);
      if (!Tesseract || typeof Tesseract.createWorker !== 'function') throw new LocalOcrError();
      const worker = await Tesseract.createWorker('chi_sim', 1, {
        workerPath: OCR_WORKER_URL,
        corePath: OCR_CORE_URL,
        langPath: OCR_LANG_URL,
        gzip: true,
        workerBlobURL: false,
        cacheMethod: 'none',
        logger(message) {
          const next = progressFromWorker(message);
          report(onProgress, next.phase, next.progress);
        },
      });
      return configureAlipayOcrWorker(worker);
    })().catch(() => {
      workerPromise = null;
      throw new LocalOcrError('本地识别组件加载失败，请检查网络后重试。');
    });
  }
  return workerPromise;
}

function sanitizeRecognitionResult(result) {
  const data = result && result.data || {};
  return {
    text: typeof data.text === 'string' ? data.text : '',
    blocks: Array.isArray(data.blocks) ? data.blocks : [],
  };
}

function offsetY(value, amount) {
  const number = Number(value);
  return Number.isFinite(number) ? number + amount : value;
}

function offsetOcrBoxY(box, amount) {
  if (!box || typeof box !== 'object') return box;
  const shifted = { ...box };
  for (const key of ['y', 'top', 'bottom', 'y0', 'y1']) {
    if (Number.isFinite(Number(shifted[key]))) shifted[key] = offsetY(shifted[key], amount);
  }
  return shifted;
}

function offsetOcrBlockY(block, amount) {
  if (!block || typeof block !== 'object') return block;
  const shifted = { ...block };
  for (const key of ['y', 'top', 'bottom']) {
    if (Number.isFinite(Number(shifted[key]))) shifted[key] = offsetY(shifted[key], amount);
  }
  for (const key of ['bbox', 'boundingBox', 'rect', 'box']) {
    if (shifted[key]) shifted[key] = offsetOcrBoxY(shifted[key], amount);
  }
  return shifted;
}

function ocrBlockCenterY(block) {
  const box = block && (block.bbox || block.boundingBox || block.rect || block.box) || {};
  const top = [block?.y, block?.top, box.y0, box.top, box.y]
    .map(Number)
    .find(Number.isFinite);
  const bottom = [block?.bottom, box.y1, box.bottom]
    .map(Number)
    .find(Number.isFinite);
  const height = [block?.height, box.height].map(Number).find(Number.isFinite);
  if (Number.isFinite(top) && Number.isFinite(bottom)) return (top + bottom) / 2;
  if (Number.isFinite(top) && Number.isFinite(height)) return top + height / 2;
  return Number.isFinite(top) ? top : null;
}

function mergeTileRecognitionResult(merged, result, tile) {
  const sanitized = sanitizeRecognitionResult(result);
  if (sanitized.text) merged.text.push(sanitized.text);
  const yOffset = Number.isFinite(Number(tile?.y)) ? Number(tile.y) : 0;
  const contentTop = Number.isFinite(Number(tile?.contentTop)) ? Number(tile.contentTop) : Number(tile?.y) || 0;
  const contentBottom = Number.isFinite(Number(tile?.contentBottom)) ? Number(tile.contentBottom) : Infinity;
  for (const block of sanitized.blocks) {
    const shifted = offsetOcrBlockY(block, yOffset);
    const center = ocrBlockCenterY(shifted);
    if (center == null || (center >= contentTop && center < contentBottom)) {
      merged.blocks.push(shifted);
    }
  }
}

export function mergeOcrTileRecognitionResults(tileResults) {
  const merged = { text: [], blocks: [] };
  for (const entry of Array.isArray(tileResults) ? tileResults : []) {
    if (!entry || !entry.tile) continue;
    mergeTileRecognitionResult(merged, entry.result, entry.tile);
  }
  return { text: merged.text.join('\n'), blocks: merged.blocks };
}

export async function recognizeAlipayImage(file, { onProgress } = {}) {
  validateOcrImage(file);
  try {
    let worker;
    let singleResult = null;
    const merged = { text: [], blocks: [] };
    await forEachPreparedOcrTile(file, {
      onProgress,
      async onTile(tile, index, total) {
        worker ||= await getWorker(onProgress);
        report(onProgress, 'recognizing', 0.45 + 0.55 * (index / total));
        const result = await worker.recognize(tile.blob, {}, { text: true, blocks: true });
        if (total === 1) singleResult = result;
        else mergeTileRecognitionResult(merged, result, tile);
      },
    });
    report(onProgress, 'recognizing', 1);
    if (singleResult) return sanitizeRecognitionResult(singleResult);
    return { text: merged.text.join('\n'), blocks: merged.blocks };
  } catch (error) {
    if (error instanceof LocalOcrError) throw error;
    throw new LocalOcrError('本地识别失败，请更换清晰截图后重试。');
  }
}

export async function releaseLocalOcr() {
  const current = workerPromise;
  workerPromise = null;
  if (!current) return;
  try {
    const worker = await current;
    if (worker && typeof worker.terminate === 'function') await worker.terminate();
  } catch (_) {
    // Worker shutdown must never affect the main application.
  }
}

export const LOCAL_OCR_ASSETS = Object.freeze({
  engine: OCR_ENGINE_URL,
  worker: OCR_WORKER_URL,
  core: OCR_CORE_URL,
  language: OCR_LANG_URL,
});
