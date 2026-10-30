import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { inspectIconPng } from '../scripts/pwa-icon-assets.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); output.write(type, 4, 'ascii'); data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.length)), 8 + data.length);
  return output;
}
function fixture({ alpha = 255, edge = false, filter = 0 } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc(16 * (16 * 4 + 1));
  let previous = Buffer.alloc(64);
  for (let y = 0; y < 16; y++) {
    const row = Buffer.alloc(64);
    for (let x = 0; x < 16; x++) {
      const blue = edge ? x === 0 : x >= 5 && x <= 10 && y >= 5 && y <= 10;
      row.set(blue ? [10, 80, 200, alpha] : [250, 235, 200, alpha], x * 4);
    }
    const offset = y * 65; scanlines[offset] = filter;
    for (let i = 0; i < 64; i++) {
      const left = i >= 4 ? row[i - 4] : 0, up = previous[i], upperLeft = i >= 4 ? previous[i - 4] : 0;
      const p = left + up - upperLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
      const predictor = [0, left, up, Math.floor((left + up) / 2), a <= b && a <= c ? left : b <= c ? up : upperLeft][filter];
      scanlines[offset + 1 + i] = (row[i] - predictor) & 255;
    }
    previous = row;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

for (const filter of [0, 1, 2, 3, 4]) {
  test(`PNG row filter ${filter} preserves opaque centered brand geometry`, () => {
    const result = inspectIconPng(fixture({ filter }));
    assert.equal(result.opaque, true); assert.equal(result.bluePixels, 36);
    assert.deepEqual(result.blueBounds, { minX: 5, minY: 5, maxX: 10, maxY: 10 });
    assert.ok(result.blueRadiusRatio < 0.36);
  });
}
test('transparent pixels and unsafe blue geometry remain observable, never silently accepted', () => {
  assert.equal(inspectIconPng(fixture({ alpha: 0 })).opaque, false);
  assert.ok(inspectIconPng(fixture({ edge: true })).blueRadiusRatio > 0.4);
});
test('malformed or unbounded PNG metadata is rejected before inflating', () => {
  assert.throws(() => inspectIconPng(Buffer.alloc(48)), /signature/);
  const huge = fixture(); huge.writeUInt32BE(0xffffffff, 16);
  assert.throws(() => inspectIconPng(huge), /dimension/);
  assert.throws(() => inspectIconPng(fixture().subarray(0, 45)), /chunk|complete/);
});
test('legacy any icons remain byte-identical while maskable files are separate assets', async () => {
  const expected = { 'icon-192.png': 'bf6f935338019fb521f4db9723812bb9687ef7f342ef84290ad275491ebf45cb',
    'icon-512.png': '3799f5f0d1aa171029e2d936a3a90beae9433126c66add16ed90ab0a7b203b59' };
  for (const [path, digest] of Object.entries(expected)) {
    assert.equal(inspectIconPng(await readFile(new URL('../' + path, import.meta.url))).sha256, digest);
  }
});
