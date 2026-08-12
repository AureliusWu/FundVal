// Local-only PaddleOCR runner for the long, three-column Alipay holdings
// screenshot. This module deliberately accepts a File/Blob only: it never
// accepts a URL, Base64 payload, or a decoded image supplied by another page.
// OCR output stays in memory and is returned as individual positioned tokens;
// it is never joined into a raw-text transcript.

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_IMAGE_PIXELS = 16 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const ACCEPTED_IMAGE_SUFFIXES = ['.png', '.jpg', '.jpeg', '.webp'];

export const PADDLE_ROW_OCR_REGION = Object.freeze({
  left: 0.02,
  right: 0.995,
  top: 0.16,
  bottom: 0.90,
  tileHeight: 1500,
  overlap: 160,
});

// The first crop is kept separate from the holdings-list tiles. It provides
// machine-readable Alipay / Ant Fortune page evidence without making the table
// recognizer depend on tiny header text for row reconstruction.
export const PADDLE_SOURCE_OCR_REGION = Object.freeze({
  left: 0,
  right: 1,
  top: 0,
  bottom: 0.18,
  tileHeight: 1700,
  overlap: 0,
});

// These resolve against this source file so the generated static assets stay
// same-origin in both local preview and GitHub Pages. The engine is intentionally
// imported only after a user has selected a verified local image.
const PADDLE_ENGINE_URL = new URL('../assets/ocr/paddle/engine/paddle-ocr-engine.mjs', import.meta.url).href;
const PADDLE_TINY_DET_MODEL_URL = new URL('../assets/ocr/paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar', import.meta.url).href;
const PADDLE_TINY_REC_MODEL_URL = new URL('../assets/ocr/paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar', import.meta.url).href;
const PADDLE_ORT_WASM_URL = new URL('../assets/ocr/paddle/ort/', import.meta.url).href;

export const PADDLE_LOCAL_OCR_ASSETS = Object.freeze({
  engine: PADDLE_ENGINE_URL,
  detectionModel: PADDLE_TINY_DET_MODEL_URL,
  recognitionModel: PADDLE_TINY_REC_MODEL_URL,
  ortWasm: PADDLE_ORT_WASM_URL,
});

export const PADDLE_ALIPAY_RECOGNITION_OPTIONS = Object.freeze({
  textDetLimitType: 'max',
  textDetLimitSideLen: 1600,
  textDetMaxSideLimit: 2048,
  textDetThresh: 0.3,
  textDetBoxThresh: 0.35,
  textDetUnclipRatio: 1.5,
  textRecScoreThresh: 0.15,
});

export class PaddleLocalOcrError extends Error {
  constructor(message = '本地识别暂时不可用，请更换清晰截图后重试。') {
    super(message);
    this.name = 'PaddleLocalOcrError';
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

export function isSupportedPaddleOcrImage(file) {
  if (!isBlob(file)) return false;
  return ACCEPTED_IMAGE_TYPES.has(String(file.type || '').toLowerCase())
    || ACCEPTED_IMAGE_SUFFIXES.includes(fileSuffix(file));
}

export function validatePaddleOcrImage(file) {
  if (!isBlob(file)) throw new PaddleLocalOcrError('请选择 PNG、JPG 或 WEBP 格式的本地截图。');
  if (!isSupportedPaddleOcrImage(file)) throw new PaddleLocalOcrError('仅支持 PNG、JPG 或 WEBP 格式的截图。');
  if (!Number.isFinite(file.size) || file.size <= 0) throw new PaddleLocalOcrError('截图文件为空，请重新选择。');
  if (file.size > MAX_IMAGE_BYTES) throw new PaddleLocalOcrError('截图超过 16MB，请裁剪或压缩后重试。');
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

// File names and MIME types are user controlled. Validate a small local header
// before the browser creates an ImageBitmap so renamed documents are rejected.
export async function verifyPaddleOcrImageSignature(file) {
  validatePaddleOcrImage(file);
  if (typeof file.slice !== 'function') throw new PaddleLocalOcrError('无法读取截图文件，请重新选择。');
  try {
    const header = await file.slice(0, 12).arrayBuffer();
    if (!hasImageSignature(new Uint8Array(header))) {
      throw new PaddleLocalOcrError('截图内容不是有效的 PNG、JPG 或 WEBP 图片。');
    }
    return true;
  } catch (error) {
    if (error instanceof PaddleLocalOcrError) throw error;
    throw new PaddleLocalOcrError('无法验证截图文件，请重新选择。');
  }
}

function positiveInteger(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function imageDimensionError() {
  return new PaddleLocalOcrError('无法读取截图尺寸，请更换图片后重试。');
}

/**
 * Plan overlapping, whole-row crops for the stable holdings-list area. The
 * retained core intervals meet exactly, so a detection in an overlap belongs
 * to one and only one tile.
 */
export function planPaddleRowOcrTiles(width, height, region = PADDLE_ROW_OCR_REGION) {
  const imageWidth = positiveInteger(width);
  const imageHeight = positiveInteger(height);
  if (!imageWidth || !imageHeight) throw imageDimensionError();

  const leftRatio = Number(region && region.left);
  const rightRatio = Number(region && region.right);
  const topRatio = Number(region && region.top);
  const bottomRatio = Number(region && region.bottom);
  const requestedTileHeight = positiveInteger(region && region.tileHeight);
  const requestedOverlap = Math.max(0, Math.round(Number(region && region.overlap)));
  if (![leftRatio, rightRatio, topRatio, bottomRatio].every(Number.isFinite)
    || leftRatio < 0 || rightRatio > 1 || topRatio < 0 || bottomRatio > 1
    || rightRatio <= leftRatio || bottomRatio <= topRatio || !requestedTileHeight
    || !Number.isFinite(requestedOverlap)) {
    throw imageDimensionError();
  }

  const x = Math.max(0, Math.floor(imageWidth * leftRatio));
  const right = Math.min(imageWidth, Math.ceil(imageWidth * rightRatio));
  const y = Math.max(0, Math.floor(imageHeight * topRatio));
  const bottom = Math.min(imageHeight, Math.ceil(imageHeight * bottomRatio));
  const regionWidth = right - x;
  const regionHeight = bottom - y;
  if (regionWidth <= 0 || regionHeight <= 0) throw imageDimensionError();

  const tileHeight = Math.min(requestedTileHeight, regionHeight);
  const overlap = Math.min(requestedOverlap, Math.max(0, tileHeight - 1));
  const step = Math.max(1, tileHeight - overlap);
  const tiles = [];

  for (let tileY = y; tileY < bottom; tileY += step) {
    const tileBottom = Math.min(bottom, tileY + tileHeight);
    tiles.push({
      x,
      y: tileY,
      width: regionWidth,
      height: tileBottom - tileY,
      right,
      bottom: tileBottom,
      coreTop: tileY,
      coreBottom: tileBottom,
    });
    if (tileBottom >= bottom) break;
  }

  return tiles.map((tile, index, all) => {
    const previous = all[index - 1];
    const next = all[index + 1];
    const coreTop = previous ? Math.ceil((previous.bottom + tile.y) / 2) : tile.y;
    const coreBottom = next ? Math.floor((tile.bottom + next.y) / 2) : tile.bottom;
    return { ...tile, coreTop, coreBottom };
  });
}

function finiteCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePoint(point) {
  const x = Array.isArray(point) ? finiteCoordinate(point[0]) : finiteCoordinate(point && point.x);
  const y = Array.isArray(point) ? finiteCoordinate(point[1]) : finiteCoordinate(point && point.y);
  return x == null || y == null ? null : { x, y };
}

/** Map Paddle's crop-local polygon to original image coordinates. */
export function mapPaddlePolygonToImage(poly, tile) {
  const offsetX = finiteCoordinate(tile && tile.x);
  const offsetY = finiteCoordinate(tile && tile.y);
  if (offsetX == null || offsetY == null || !Array.isArray(poly)) return [];
  return poly
    .map(normalizePoint)
    .filter(Boolean)
    .map(point => ({ x: point.x + offsetX, y: point.y + offsetY }));
}

function boundsFromPolygon(poly) {
  if (!Array.isArray(poly) || !poly.length) return null;
  const xs = poly.map(point => point.x).filter(Number.isFinite);
  const ys = poly.map(point => point.y).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const x = Math.min(...xs);
  const right = Math.max(...xs);
  const y = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { x, y, right, bottom, width: right - x, height: bottom - y };
}

export function paddleItemIsInTileCore(item, tile) {
  const poly = mapPaddlePolygonToImage(item && item.poly, tile);
  const bounds = boundsFromPolygon(poly);
  if (!bounds) return false;
  const centerY = bounds.y + bounds.height / 2;
  const coreTop = finiteCoordinate(tile && tile.coreTop);
  const coreBottom = finiteCoordinate(tile && tile.coreBottom);
  if (coreTop == null || coreBottom == null || coreBottom < coreTop) return false;
  // A following tile owns the shared boundary. The final tile includes the
  // bottom edge so no valid detection at the image end is dropped.
  const isLastTile = finiteCoordinate(tile && tile.bottom) === coreBottom;
  return centerY >= coreTop && (isLastTile ? centerY <= coreBottom : centerY < coreBottom);
}

function sanitizeTokenText(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u200b\ufeff]/g, '')
    .trim();
}

/**
 * Normalize and core-deduplicate Paddle items without building a combined OCR
 * transcript. Individual tokens remain available only to the immediate parser.
 */
export function normalizePaddleOcrItems(items, tile) {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    const text = sanitizeTokenText(item && item.text);
    const poly = mapPaddlePolygonToImage(item && item.poly, tile);
    const bounds = boundsFromPolygon(poly);
    if (!text || !bounds || !paddleItemIsInTileCore(item, tile)) return null;
    const score = finiteCoordinate(item && (item.score ?? item.confidence));
    return {
      text,
      score,
      poly,
      ...bounds,
    };
  }).filter(Boolean);
}

function report(onProgress, phase, progress) {
  if (typeof onProgress !== 'function') return;
  onProgress({ phase, progress: Number.isFinite(progress) ? progress : null });
}

function safeEngineFailureDetail(error) {
  const message = String(error && error.message || '')
    .replace(/https?:\/\/\S+/gi, '[本地资源]')
    .replace(/[A-Za-z]:[\\/][^\s]+/g, '[本地路径]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 180);
  return message ? `（${message}）` : '';
}

function resolveLocalPaddleFactory(module) {
  const candidates = [
    module && module.createLocalPaddleOcr,
    module && module.default && module.default.createLocalPaddleOcr,
  ];
  return candidates.find(candidate => typeof candidate === 'function') || null;
}

async function loadLocalPaddleFactory() {
  const module = await import(PADDLE_ENGINE_URL);
  const factory = resolveLocalPaddleFactory(module);
  if (!factory) throw new PaddleLocalOcrError('本地识别组件加载失败，请检查应用资源后重试。');
  return factory;
}

export function createPaddleOcrOptions() {
  return {
    worker: true,
    textDetectionModelName: 'PP-OCRv6_tiny_det',
    textRecognitionModelName: 'PP-OCRv6_tiny_rec',
    textDetectionModelAsset: { url: PADDLE_TINY_DET_MODEL_URL },
    textRecognitionModelAsset: { url: PADDLE_TINY_REC_MODEL_URL },
    textDetectionBatchSize: 1,
    textRecognitionBatchSize: 2,
    ortOptions: {
      backend: 'wasm',
      wasmPaths: PADDLE_ORT_WASM_URL,
      numThreads: 1,
      simd: true,
      proxy: false,
    },
  };
}

async function createLocalImageBitmap(file) {
  if (typeof createImageBitmap !== 'function') {
    throw new PaddleLocalOcrError('当前浏览器不支持本地截图预处理。');
  }
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    try {
      return await createImageBitmap(file);
    } catch (error) {
      throw new PaddleLocalOcrError('无法读取截图，请更换图片后重试。');
    }
  }
}

function predictionItems(prediction) {
  const first = Array.isArray(prediction) ? prediction[0] : prediction;
  return Array.isArray(first && first.items) ? first.items : [];
}

function sortTokensInReadingOrder(tokens) {
  return tokens.sort((left, right) => left.y - right.y || left.x - right.x);
}

/**
 * Recognize the holdings-list region of one verified local image. This does
 * not persist or concatenate OCR text; callers must parse then discard tokens
 * before leaving the dedicated import page.
 */
export async function recognizeAlipayPaddleImage(file, { onProgress } = {}) {
  await verifyPaddleOcrImageSignature(file);
  report(onProgress, 'preparing', 0.04);

  let source = null;
  let ocr = null;
  let failureStage = '读取图片';
  try {
    source = await createLocalImageBitmap(file);
    const imageWidth = positiveInteger(source.width);
    const imageHeight = positiveInteger(source.height);
    if (!imageWidth || !imageHeight || imageWidth * imageHeight > MAX_SOURCE_IMAGE_PIXELS) {
      throw new PaddleLocalOcrError('截图像素过大，请裁剪为较短的截图后重试。');
    }
    const sourceTiles = planPaddleRowOcrTiles(imageWidth, imageHeight, PADDLE_SOURCE_OCR_REGION)
      .map(tile => ({ ...tile, region: 'source' }));
    const rowTiles = planPaddleRowOcrTiles(imageWidth, imageHeight)
      .map(tile => ({ ...tile, region: 'holdings' }));
    const tiles = [...sourceTiles, ...rowTiles];
    report(onProgress, 'loading-engine', 0.10);
    failureStage = '加载识别引擎';
    const createLocalPaddleOcr = await loadLocalPaddleFactory();
    report(onProgress, 'loading-models', 0.18);
    failureStage = '加载本地模型';
    ocr = await createLocalPaddleOcr({
      onProgress(event) {
        if (event && event.phase === 'initializing') report(onProgress, 'initializing', 0.19);
      },
    });

    const tokens = [];
    failureStage = '识别图片';
    for (let index = 0; index < tiles.length; index += 1) {
      const tile = tiles[index];
      report(onProgress, 'recognizing', 0.20 + 0.78 * (index / tiles.length));
      const crop = await createImageBitmap(source, tile.x, tile.y, tile.width, tile.height);
      try {
        const prediction = await ocr.predict(crop, PADDLE_ALIPAY_RECOGNITION_OPTIONS);
        tokens.push(...normalizePaddleOcrItems(predictionItems(prediction), tile)
          .map(token => ({ ...token, region: tile.region })));
      } finally {
        if (crop && typeof crop.close === 'function') crop.close();
      }
    }
    report(onProgress, 'recognizing', 1);
    return {
      engine: 'paddle',
      imageWidth,
      imageHeight,
      tokens: sortTokensInReadingOrder(tokens),
      // Do not create a raw OCR transcript. The parser consumes `tokens` only.
      text: '',
    };
  } catch (error) {
    if (error instanceof PaddleLocalOcrError) throw error;
    throw new PaddleLocalOcrError(`${failureStage}失败，请检查应用资源后重试。${safeEngineFailureDetail(error)}`);
  } finally {
    if (ocr && typeof ocr.dispose === 'function') {
      try { await ocr.dispose(); } catch (_) { /* local cleanup must not mask OCR errors */ }
    }
    if (source && typeof source.close === 'function') source.close();
  }
}
