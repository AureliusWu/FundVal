import test from 'node:test';
import assert from 'node:assert/strict';
import { ALIPAY_OCR_RECOGNITION_PARAMETERS, configureAlipayOcrWorker, fitOcrImageSize, isSupportedOcrImage, mergeOcrTileRecognitionResults, planOcrImageTiles, validateOcrImage, verifyOcrImageSignature } from '../js/local-ocr.js';

test('accepts only local image Blob inputs and supported image formats', () => {
  const png = new Blob(['image'], { type: 'image/png' });
  const json = new Blob(['{}'], { type: 'application/json' });
  assert.equal(isSupportedOcrImage(png), true);
  assert.equal(isSupportedOcrImage(json), false);
  assert.throws(() => validateOcrImage('https://example.com/screenshot.png'));
  assert.throws(() => validateOcrImage(json));
});

test('fits large OCR images without enlarging small screenshots', () => {
  assert.deepEqual(fitOcrImageSize(1200, 800), { width: 1200, height: 800, scaled: false });
  assert.deepEqual(fitOcrImageSize(4400, 2200), { width: 2200, height: 1100, scaled: true });
  assert.throws(() => fitOcrImageSize(0, 200));
});

test('keeps long narrow screenshots readable and plans bounded vertical OCR tiles', () => {
  assert.deepEqual(fitOcrImageSize(1440, 9317), { width: 1440, height: 9317, scaled: false });
  const tiles = planOcrImageTiles(1440, 9317);
  assert.equal(tiles.length, 5);
  assert.equal(tiles[0].width, 1440);
  assert.equal(tiles[0].y, 0);
  assert.equal(tiles.at(-1).contentBottom, 9317);
  for (const [index, tile] of tiles.entries()) {
    assert.ok(tile.height <= 2200);
    assert.ok(tile.width * tile.height <= 4 * 1024 * 1024);
    if (index > 0) assert.equal(tiles[index - 1].contentBottom, tile.contentTop);
  }
});

test('configures the local worker with PSM 4 while retaining vertical tile recognition', async () => {
  const parameterCalls = [];
  const worker = {
    async setParameters(parameters) {
      parameterCalls.push(parameters);
    },
  };
  const configured = await configureAlipayOcrWorker(worker);
  const tiles = planOcrImageTiles(1440, 9317);

  assert.equal(configured, worker);
  assert.deepEqual(ALIPAY_OCR_RECOGNITION_PARAMETERS, { tessedit_pageseg_mode: '4' });
  assert.deepEqual(parameterCalls, [{ tessedit_pageseg_mode: '4' }]);
  assert.equal(tiles.length, 5);
  assert.equal(tiles[0].y, 0);
  assert.ok(tiles.slice(1).every((tile, index) => tile.y > tiles[index].y));
});

test('rejects decoded image dimensions that exceed local OCR safety limits', () => {
  assert.throws(() => fitOcrImageSize(1440, 12000));
  assert.throws(() => planOcrImageTiles(1000, 30000));
});

test('merges vertical tile OCR in reading order without duplicate overlap blocks', () => {
  const [first, second] = planOcrImageTiles(1440, 3000);
  const merged = mergeOcrTileRecognitionResults([
    {
      tile: first,
      result: { data: { text: '首片', blocks: [{ text: '边界行', bbox: { x0: 0, y0: 2130, x1: 100, y1: 2170 } }] } },
    },
    {
      tile: second,
      result: {
        data: {
          text: '次片',
          blocks: [
            { text: '边界行', bbox: { x0: 0, y0: 26, x1: 100, y1: 66 } },
            { text: '第二片内容', bbox: { x0: 0, y0: 100, x1: 160, y1: 140 } },
          ],
        },
      },
    },
  ]);
  assert.equal(merged.text, '首片\n次片');
  assert.deepEqual(merged.blocks.map(block => block.text), ['边界行', '第二片内容']);
  assert.deepEqual(merged.blocks.map(block => block.bbox.y0), [2130, second.y + 100]);
});

test('rejects a renamed non-image Blob before canvas or OCR receives it', async () => {
  const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const valid = new Blob([pngHeader], { type: 'image/png' });
  const renamedSvg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/png' });
  await assert.doesNotReject(() => verifyOcrImageSignature(valid));
  await assert.rejects(() => verifyOcrImageSignature(renamedSvg));
});
