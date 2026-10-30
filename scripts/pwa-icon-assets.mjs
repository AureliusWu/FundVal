import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

export const MASKABLE_FILES = Object.freeze(['icon-maskable-192.png', 'icon-maskable-512.png']);
const signature = '89504e470d0a1a0a';
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// Bounded repository-asset inspector, not an application image-upload decoder.
export function inspectIconPng(bytes) {
  assert.ok(bytes.length >= 45 && bytes.length <= 8 * 1024 * 1024, 'PNG byte bounds');
  assert.equal(bytes.subarray(0, 8).toString('hex'), signature, 'PNG signature');
  const data = []; let width, height, channels, ended = false, transparency = false;
  for (let offset = 8; offset < bytes.length;) {
    assert.ok(offset + 12 <= bytes.length, 'PNG chunk header bounds');
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + 12 + length <= bytes.length, 'PNG chunk length bounds');
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (offset === 8) assert.equal(type, 'IHDR');
    if (type === 'IHDR') {
      assert.ok(!width && length === 13, 'single IHDR');
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      assert.ok(width > 0 && width <= 2048 && height > 0 && height <= 2048, 'PNG dimension bounds');
      assert.equal(chunk[8], 8, '8-bit PNG required');
      assert.ok([2, 6].includes(chunk[9]), 'RGB/RGBA PNG required');
      channels = chunk[9] === 2 ? 3 : 4;
      assert.deepEqual([...chunk.subarray(10)], [0, 0, 0], 'standard non-interlaced PNG required');
    } else if (type === 'IDAT') data.push(chunk);
    else if (type === 'tRNS') transparency = true;
    offset += 12 + length;
    if (type === 'IEND') { assert.equal(length, 0); assert.equal(offset, bytes.length); ended = true; break; }
  }
  assert.ok(ended && data.length && width && height, 'complete PNG required');
  const stride = width * channels, expected = height * (stride + 1);
  const raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
  assert.equal(raw.length, expected, 'PNG scanline size');
  let previous = Buffer.alloc(stride), minAlpha = 255, bluePixels = 0, blueRadius = 0;
  const bounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = raw[start];
    assert.ok(filter <= 4, 'valid PNG row filter');
    const row = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0, up = previous[i], upperLeft = i >= channels ? previous[i - channels] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upperLeft)][filter];
      row[i] = (row[i] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const i = x * channels, r = row[i], g = row[i + 1], b = row[i + 2];
      if (channels === 4) minAlpha = Math.min(minAlpha, row[i + 3]);
      if (b > r + 15 && b > g - 5 && Math.max(r, g, b) - Math.min(r, g, b) > 40) {
        bluePixels++; bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
        bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
        blueRadius = Math.max(blueRadius, Math.hypot(x - (width - 1) / 2, y - (height - 1) / 2));
      }
    }
    previous = row;
  }
  return { width, height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    opaque: !transparency && minAlpha === 255, bluePixels, blueBounds: bounds, blueRadiusRatio: blueRadius / width };
}

export async function verifyPwaIconAssets(directory) {
  const root = resolve(directory), manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const records = [];
  for (const [index, path] of MASKABLE_FILES.entries()) {
    const size = [192, 512][index], declarations = manifest.icons.filter(icon => icon.src === path);
    assert.equal(declarations.length, 1, 'one declaration per dedicated maskable asset');
    assert.deepEqual(declarations[0], { src: path, sizes: `${size}x${size}`, type: 'image/png', purpose: 'maskable' });
    const record = inspectIconPng(await readFile(resolve(root, path)));
    assert.equal(record.width, size); assert.equal(record.height, size); assert.equal(record.opaque, true);
    assert.ok(record.bluePixels > size * size * 0.05, 'blue brand subject must be present');
    assert.ok(record.blueRadiusRatio <= 0.36, 'blue subject retains margin within the 0.4 maskable safe circle');
    records.push({ path, ...record });
  }
  return { result: 'PASS', records, scope: 'PNG dimensions/opacity and blue-ink heuristic; full outline and platform crops require visual/device review.' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  verifyPwaIconAssets(process.argv[2] || '.').then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
