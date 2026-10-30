import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { inspectIconPng } from './pwa-icon-assets.mjs';

// Mechanical size export only: creative layout comes from the preserved imagegen source.
const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'docs/design/pwa-maskable-source.png'));
assert.equal(createHash('sha256').update(source).digest('hex'), '81e3d82463c47652332e74b9a72f4954963ccfd29503f37a7b051df9d2126a60');
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort('blockedbyclient'));
  for (const size of [192, 512]) {
    const encoded = await page.evaluate(async ({ base64, size }) => {
      const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      try {
        const canvas = new OffscreenCanvas(size, size), context = canvas.getContext('2d', { alpha: false });
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, size, size);
        const png = await canvas.convertToBlob({ type: 'image/png' });
        return Array.from(new Uint8Array(await png.arrayBuffer()));
      } finally { image.close(); }
    }, { base64: source.toString('base64'), size });
    const bytes = Buffer.from(encoded), record = inspectIconPng(bytes);
    assert.equal(record.width, size); assert.equal(record.height, size); assert.equal(record.opaque, true);
    assert.ok(record.blueRadiusRatio < 0.36);
    await writeFile(resolve(root, `icon-maskable-${size}.png`), bytes, { flag: 'wx' });
    console.log(JSON.stringify({ path: `icon-maskable-${size}.png`, ...record, renderer: browser.version() }));
  }
} finally { await browser?.close(); }
