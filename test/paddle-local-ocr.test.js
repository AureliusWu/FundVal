import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PADDLE_ALIPAY_RECOGNITION_OPTIONS,
  PADDLE_LOCAL_OCR_ASSETS,
  PADDLE_ROW_OCR_REGION,
  PADDLE_SOURCE_OCR_REGION,
  createPaddleOcrOptions,
  isSupportedPaddleOcrImage,
  mapPaddlePolygonToImage,
  normalizePaddleOcrItems,
  paddleItemIsInTileCore,
  planPaddleRowOcrTiles,
  validatePaddleOcrImage,
  verifyPaddleOcrImageSignature,
} from '../js/paddle-local-ocr.js';

test('accepts only a local Blob with a supported screenshot type', () => {
  const png = new Blob(['image'], { type: 'image/png' });
  const json = new Blob(['{}'], { type: 'application/json' });
  assert.equal(isSupportedPaddleOcrImage(png), true);
  assert.equal(isSupportedPaddleOcrImage(json), false);
  assert.throws(() => validatePaddleOcrImage('https://example.com/screenshot.png'));
  assert.throws(() => validatePaddleOcrImage(json));
});

test('checks the local binary signature before image decoding', async () => {
  const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const valid = new Blob([pngHeader], { type: 'image/png' });
  const renamedSvg = new Blob(['<svg></svg>'], { type: 'image/png' });
  await assert.doesNotReject(() => verifyPaddleOcrImageSignature(valid));
  await assert.rejects(() => verifyPaddleOcrImageSignature(renamedSvg));
});

test('plans bounded whole-row tiles for the long holdings-list region', () => {
  const tiles = planPaddleRowOcrTiles(1440, 9317);
  assert.equal(tiles[0].x, 28);
  assert.equal(tiles[0].right, 1433);
  assert.equal(tiles[0].y, 1490);
  assert.equal(tiles.at(-1).bottom, 8386);
  assert.equal(tiles.at(-1).coreBottom, 8386);
  assert.equal(tiles.length, 6);
  assert.deepEqual(PADDLE_ROW_OCR_REGION, {
    left: 0.02,
    right: 0.995,
    top: 0.16,
    bottom: 0.90,
    tileHeight: 1500,
    overlap: 160,
  });
  for (const [index, tile] of tiles.entries()) {
    assert.ok(tile.height <= 1500);
    assert.ok(tile.width > 0);
    assert.ok(tile.coreTop < tile.coreBottom);
    if (index > 0) {
      assert.equal(tile.y - tiles[index - 1].y, 1340);
      assert.equal(tiles[index - 1].coreBottom, tile.coreTop);
    }
  }
});

test('plans a separate bounded header region for machine source evidence', () => {
  const tiles = planPaddleRowOcrTiles(1440, 9317, PADDLE_SOURCE_OCR_REGION);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].x, 0);
  assert.equal(tiles[0].y, 0);
  assert.equal(tiles[0].right, 1440);
  assert.equal(tiles[0].bottom, 1678);
});

test('maps Paddle polygon coordinates to original image coordinates and keeps one core owner', () => {
  const [, tile] = planPaddleRowOcrTiles(1440, 9317);
  const poly = [{ x: 12, y: 100 }, { x: 112, y: 100 }, { x: 112, y: 140 }, { x: 12, y: 140 }];
  assert.deepEqual(mapPaddlePolygonToImage(poly, tile), [
    { x: tile.x + 12, y: tile.y + 100 },
    { x: tile.x + 112, y: tile.y + 100 },
    { x: tile.x + 112, y: tile.y + 140 },
    { x: tile.x + 12, y: tile.y + 140 },
  ]);
  assert.equal(paddleItemIsInTileCore({ poly }, tile), true);
  const outsideCore = { poly: poly.map(point => ({ ...point, y: point.y - 90 })) };
  assert.equal(paddleItemIsInTileCore(outsideCore, tile), false);
});

test('normalizes only accepted positioned tokens without forming an OCR transcript', () => {
  const [, tile] = planPaddleRowOcrTiles(1440, 9317);
  const accepted = { text: '示例基金', score: 0.92, poly: [[8, 100], [108, 100], [108, 140], [8, 140]] };
  const rejected = { text: '重叠项', score: 0.91, poly: [[8, 0], [108, 0], [108, 30], [8, 30]] };
  const tokens = normalizePaddleOcrItems([accepted, rejected], tile);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].text, '示例基金');
  assert.equal(tokens[0].score, 0.92);
  assert.equal(tokens[0].x, tile.x + 8);
  assert.equal(tokens[0].y, tile.y + 100);
  assert.deepEqual(Object.keys(tokens[0]).sort(), ['bottom', 'height', 'poly', 'right', 'score', 'text', 'width', 'x', 'y']);
});

test('uses a same-origin static Paddle engine with local tiny models and single-threaded WASM', () => {
  const options = createPaddleOcrOptions();
  assert.equal(options.worker, true);
  assert.equal(options.textDetectionModelName, 'PP-OCRv6_tiny_det');
  assert.equal(options.textRecognitionModelName, 'PP-OCRv6_tiny_rec');
  assert.equal(options.ortOptions.numThreads, 1);
  assert.equal(options.ortOptions.simd, true);
  assert.equal(options.ortOptions.proxy, false);
  assert.equal(PADDLE_ALIPAY_RECOGNITION_OPTIONS.textDetLimitSideLen, 1600);
  for (const value of Object.values(PADDLE_LOCAL_OCR_ASSETS)) {
    assert.equal(new URL(value).protocol, 'file:');
  }
  assert.match(options.textDetectionModelAsset.url, /PP-OCRv6_tiny_det_onnx_infer\.tar$/);
  assert.match(options.textRecognitionModelAsset.url, /PP-OCRv6_tiny_rec_onnx_infer\.tar$/);
});
