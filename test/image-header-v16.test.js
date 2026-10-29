import test from 'node:test';
import assert from 'node:assert/strict';
import { png, pngChunk, jpeg, jpegSegment, webpContainer, vp8, vp8l, vp8x, riffChunk, concat, uint } from './fixtures/image-headers.mjs';
import { recognizeAlipayPaddleImage } from '../js/paddle-local-ocr.js';
import { bitmapPreprocessor, handlerPreprocessor, HandlerBitmap, installHandlerBitmap, unexpectedPageBitmap } from './fixtures/image-preprocessor.mjs';

const LIMIT = 256 * 1024;
let api;
async function header(file, options) {
  api ||= await import('../js/ocr/image-header.js');
  return api.readLocalImageHeader(file, options);
}
const image = (bytes, type = 'image/png') => new Blob([bytes], { type });
function safe(error) {
  assert.equal(error.name, 'ImageHeaderError');
  assert.ok(['image_header_invalid', 'image_header_budget_exceeded', 'image_header_animated', 'image_header_read_failed', 'image_header_aborted'].includes(error.code));
  assert.doesNotMatch(error.message + JSON.stringify(error), /private|filename|rawbytes|http|secret/);
  return true;
}
for (const [name, bytes, format] of [
  ['PNG long screenshot', png(1440, 9317), 'png'],
  ['JPEG baseline', jpeg(1440, 9317), 'jpeg'],
  ['JPEG sequential', jpeg(1440, 9317, { marker: 0xc1 }), 'jpeg'],
  ['JPEG progressive', jpeg(1440, 9317, { marker: 0xc2 }), 'jpeg'],
  ['JPEG metadata and fill bytes', jpeg(1440, 9317, { prefix: [jpegSegment(0xe1, new Uint8Array(50)), [0xff]] }), 'jpeg'],
  ['WebP VP8', webpContainer([vp8(1440, 9317)]), 'webp'],
  ['WebP VP8L', webpContainer([vp8l(1440, 9317)]), 'webp'],
  ['WebP VP8X plus VP8', webpContainer([vp8x(1440, 9317), vp8(1440, 9317)]), 'webp'],
  ['WebP VP8X plus VP8L and unknown padded metadata', webpContainer([vp8x(1440, 9317), vp8l(1440, 9317), riffChunk('JUNK', [1, 2, 3])]), 'webp'],
]) test('bounded parser accepts ' + name + ' with a fixed dimensions-only DTO', async () => {
  assert.deepEqual(await header(image(bytes)), { format, width: 1440, height: 9317 });
});

test('PNG rejects invalid IHDR, CRC, order, chunk lengths, zero/overflow dimensions and animation', async () => {
  const crc = png(); crc[29] ^= 1;
  const length = png(); length.set(uint(0xffffffff), 8);
  const badType = png(); badType[12] = 0;
  for (const bytes of [png(0, 10), png(10, 0), png(0x80000000, 1), png(0x7fffffff, 0x7fffffff), crc, length, badType,
    png(1, 1, { depth: 3 }), png(1, 1, { color: 3 }),
    png(1, 1, { before: [pngChunk('IHDR', new Uint8Array(13))] }),
    png(1, 1, { before: [pngChunk('ABCD')] }),
    png(1, 1, { before: [pngChunk('acTL', new Uint8Array(8))] }),
    png(1, 1, { after: [pngChunk('fcTL', new Uint8Array(26))] }),
    png(1, 1).slice(0, -1), concat(png(), [0])]) {
    await assert.rejects(() => header(image(bytes)), safe);
  }
});
test('JPEG rejects truncated/unknown-size/invalid SOF segments and a scan before dimensions', async () => {
  const short = jpeg().slice(0, 10);
  const badLength = jpeg(); badLength[5] = 2;
  const badPrecision = jpeg(); badPrecision[6] = 3;
  for (const bytes of [short, badLength, badPrecision, jpeg(0, 10), jpeg(10, 0),
    jpeg(1, 1, { marker: 0xc3 }), new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]),
    new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), jpeg().slice(0, -1), jpeg().slice(0, 21)]) {
    await assert.rejects(() => header(image(bytes, 'image/jpeg')), safe);
  }
});
test('WebP rejects wrong RIFF/chunk declarations, frame signatures, reserved bits, padding, mismatched canvas and animation', async () => {
  const size = webpContainer([vp8(10, 10)]); size[4]++;
  const overrun = webpContainer([vp8(10, 10)]); overrun.set(uint(0xffffffff, 4, true), 16);
  const frame = vp8(10, 10); frame[11] = 0;
  const pad = riffChunk('JUNK', [1]); pad[9] = 1;
  for (const bytes of [size, overrun, webpContainer([frame]), webpContainer([vp8(0, 10)]),
    webpContainer([vp8l(10, 10, { version: 1 })]), webpContainer([vp8x(10, 10, 0x80), vp8(10, 10)]),
    webpContainer([vp8x(10, 10, 2), riffChunk('ANIM', new Uint8Array(6))]),
    webpContainer([vp8(10, 10), riffChunk('ANMF', [])]),
    webpContainer([vp8x(11, 10), vp8(10, 10)]),
    webpContainer([vp8x(0x1000000, 0x1000000), vp8(1, 1)]),
    webpContainer([vp8(10, 10), vp8l(10, 10)]), webpContainer([vp8x(10, 10)]),
    webpContainer([vp8(10, 10), pad]), webpContainer([vp8(10, 10)]).slice(0, -1)]) {
    await assert.rejects(() => header(image(bytes, 'image/webp')), safe);
  }
});
test('header IO is sliced, does not invoke file.arrayBuffer, and stays inside the hard total budget', async () => {
  const slices = [];
  class Observed extends Blob {
    arrayBuffer() { assert.fail('must not read entire file'); }
    slice(start, end) { slices.push([start, end]); return super.slice(start, end); }
  }
  const payload = new Uint8Array(1024 * 1024);
  const bytes = concat(png(10, 10).slice(0, 33), pngChunk('IDAT', payload), pngChunk('IEND'));
  assert.deepEqual(await header(new Observed([bytes])), { format: 'png', width: 10, height: 10 });
  assert.ok(slices.reduce((sum, [start, end]) => sum + end - start, 0) <= LIMIT - 12);
  assert.ok(slices.every(([start, end]) => end - start < 1024));
});
test('header byte and structural-record exhaustion fail closed without scanning unbounded metadata', async () => {
  const huge = png(1, 1, { before: [pngChunk('tEXt', new Uint8Array(LIMIT))] });
  const segments = Array.from({ length: 5 }, () => jpegSegment(0xe1, new Uint8Array(65533)));
  for (const bytes of [huge, jpeg(1, 1, { prefix: segments }),
    webpContainer([vp8(10, 10), ...Array.from({ length: 513 }, () => riffChunk('JUNK', []))])]) {
    await assert.rejects(() => header(image(bytes)), error => safe(error) && error.code === 'image_header_budget_exceeded');
  }
});
test('local read errors, non-Blob input and aborted late header reads have safe fixed errors', async () => {
  await assert.rejects(() => header('https://private.invalid/secret.png'), safe);
  class Failed extends Blob { slice() { throw new Error('private filename secret rawbytes'); } }
  await assert.rejects(() => header(new Failed([png()])), safe);
  const controller = new AbortController();
  class Late extends Blob {
    slice(start, end) { const part = super.slice(start, end); return { async arrayBuffer() { const data = await part.arrayBuffer(); controller.abort('private secret'); return data; } }; }
  }
  await assert.rejects(() => header(new Late([png()]), { signal: controller.signal }), error => safe(error) && error.code === 'image_header_aborted');
});

function runtime(createBitmap) {
  return { Worker() {}, createImageBitmap: unexpectedPageBitmap, OffscreenCanvas() {}, WebAssembly: {}, structuredClone() {} };
}
async function recognize(bytes, options = {}) {
  const counts = { bitmap: 0, manifest: 0, factory: 0, close: 0 };
  let preprocessors = 0;
  const source = { width: options.bitmapWidth ?? 100, height: options.bitmapHeight ?? 100, close() { counts.close++; } };
  const createBitmap = async () => { counts.bitmap++; if (options.abortBitmap) options.controller.abort('private secret'); return source; };
  const createPreprocessor = bitmapPreprocessor(createBitmap);
  const result = await recognizeAlipayPaddleImage(options.file || image(bytes), {
    runtime: runtime(createBitmap), createImagePreprocessor: value => { preprocessors++; return createPreprocessor(value); }, signal: options.controller?.signal,
    async loadAssetManifest() { counts.manifest++; throw new Error('synthetic manifest stop'); },
    async loadPaddleFactory() { counts.factory++; throw new Error('synthetic factory stop'); },
  }).catch(error => error);
  return { counts, result, preprocessors };
}
for (const [name, bytes] of [
  ['large PNG', png(4097, 4096)], ['large JPEG', jpeg(5000, 5000)],
  ['large WebP', webpContainer([vp8l(5000, 5000)])], ['unknown dimensions', jpeg(100, 0)],
  ['truncated signed image', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
]) test('predecode gate dispatches zero bitmap/manifest/engine work for ' + name, async () => {
  const observed = await recognize(bytes);
  assert.deepEqual(observed.counts, { bitmap: 0, manifest: 0, factory: 0, close: 0 });
  assert.equal(observed.result.stage, 'input');
  assert.equal(observed.preprocessors, 0, 'reject header geometry before constructing any preprocessing Worker');
});
test('accepted long geometry and exact original pixel boundary proceed only to the injected bitmap stage', async () => {
  for (const [width, height] of [[1440, 9317], [4096, 4096]]) {
    const observed = await recognize(png(width, height), { bitmapWidth: width, bitmapHeight: height });
    assert.deepEqual(observed.counts, { bitmap: 1, manifest: 1, factory: 0, close: 1 });
    assert.equal(observed.result.stage, 'manifest');
    assert.equal(observed.preprocessors, 1);
  }
});
test('real bitmap area is rechecked after decode; EXIF-style dimension swapping does not change area', async () => {
  const tooLarge = await recognize(png(), { bitmapWidth: 5000, bitmapHeight: 5000 });
  assert.deepEqual(tooLarge.counts, { bitmap: 1, manifest: 0, factory: 0, close: 1 });
  const rotated = await recognize(jpeg(100, 50), { bitmapWidth: 50, bitmapHeight: 100 });
  assert.deepEqual(rotated.counts, { bitmap: 1, manifest: 1, factory: 0, close: 1 });
});
test('signature/header await aborts cause zero bitmap calls; a late decoded source is still closed', async () => {
  for (const stopRead of [1, 2]) {
    const controller = new AbortController(); let reads = 0;
    class Late extends Blob {
      slice(start, end) { const part = super.slice(start, end); return { async arrayBuffer() { const buffer = await part.arrayBuffer(); if (++reads === stopRead) controller.abort('private secret'); return buffer; } }; }
    }
    const observed = await recognize(null, { file: new Late([png()], { type: 'image/png' }), controller });
    assert.deepEqual(observed.counts, { bitmap: 0, manifest: 0, factory: 0, close: 0 });
    assert.equal(observed.preprocessors, 0);
  }
  const controller = new AbortController();
  const late = await recognize(png(), { controller, abortBitmap: true });
  assert.deepEqual(late.counts, { bitmap: 1, manifest: 0, factory: 0, close: 1 });
});
test('an aborted failed bitmap attempt cannot start the actual preprocessing Worker compatibility decode fallback', async t => {
  installHandlerBitmap(t);
  const controller = new AbortController(); let calls = 0, manifests = 0;
  const createBitmap = async () => { calls++; controller.abort('private secret'); throw new Error('private decoder'); };
  await recognizeAlipayPaddleImage(image(png()), { runtime: runtime(createBitmap), createImagePreprocessor: handlerPreprocessor(createBitmap), signal: controller.signal,
    async loadAssetManifest() { manifests++; }, async loadPaddleFactory() { assert.fail('must not initialize'); },
  }).catch(error => assert.doesNotMatch(error.message, /private|secret/));
  assert.equal(calls, 1); assert.equal(manifests, 0);
});
test('a genuine bitmap-options incompatibility still uses the actual preprocessing Worker fallback and closes its source', async t => {
  installHandlerBitmap(t);
  let calls = 0, closed = 0;
  const createBitmap = async () => {
    if (++calls === 1) throw new Error('synthetic unsupported options');
    return new HandlerBitmap(100, 100, () => { closed++; });
  };
  await recognizeAlipayPaddleImage(image(png()), { runtime: runtime(createBitmap), createImagePreprocessor: handlerPreprocessor(createBitmap),
    async loadAssetManifest() { throw new Error('synthetic stop before engine'); },
  }).catch(() => {});
  assert.equal(calls, 2); assert.equal(closed, 1);
});
