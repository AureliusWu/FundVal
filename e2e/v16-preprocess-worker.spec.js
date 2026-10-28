import { expect, test } from '@playwright/test';

// Actual Chrome module Worker and transferable bitmaps, no OCR SDK/models or
// personal screenshots. Desktop evidence does not qualify a physical phone.
const ORIGIN = `http://127.0.0.1:${Number(process.env.FUNDVAL_E2E_PORT || 4173)}`;
async function localPage(page) {
  const blocked = [], workers = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN || !['GET', 'HEAD'].includes(route.request().method())
      || url.pathname.includes('/__fundval_dev/') || url.pathname.includes('/assets/ocr/')) {
      blocked.push('unexpected_nonlocal_or_heavy_request'); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  page.on('worker', worker => workers.push(new URL(worker.url()).pathname));
  await page.goto('/ocr-import.html');
  return { blocked, workers };
}

test('light preprocessing Worker decodes browser codecs and transfers caller-owned serial crops', async ({ page }) => {
  const evidence = await localPage(page);
  const results = await page.evaluate(async () => {
    const { createLocalImagePreprocessor } = await import('./js/ocr/preprocess-client.js');
    const { readLocalImageHeader } = await import('./js/ocr/image-header.js');
    const results = [];
    for (const [type, width, height] of [['image/png', 1440, 9317], ['image/jpeg', 256, 384], ['image/webp', 256, 384]]) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); context.fillStyle = '#175f97'; context.fillRect(0, 0, width, height);
      const file = await new Promise(resolve => canvas.toBlob(resolve, type, 0.8));
      canvas.width = canvas.height = 0;
      const header = await readLocalImageHeader(file);
      const processor = createLocalImagePreprocessor();
      const dimensions = await processor.initialize(file);
      const crop = await processor.crop({ x: 0, y: 0, width: 32, height: 40 });
      const image = new OffscreenCanvas(32, 40), pixels = image.getContext('2d');
      pixels.drawImage(crop, 0, 0);
      const [r, g, b, a] = pixels.getImageData(0, 0, 1, 1).data;
      const beforeClose = { width: crop.width, height: crop.height }; crop.close();
      results.push({ type, header, dimensions, beforeClose, afterClose: crop.width,
        bluePixel: b > g && g > r && a === 255 });
      image.width = image.height = 0;
      processor.dispose();
    }
    return results;
  });
  for (const [index, [type, width, height]] of [['image/png', 1440, 9317], ['image/jpeg', 256, 384], ['image/webp', 256, 384]].entries()) {
    expect(results[index]).toEqual({ type, header: { format: type.split('/')[1], width, height }, dimensions: { width, height },
      beforeClose: { width: 32, height: 40 }, afterClose: 0, bluePixel: true });
  }
  expect(evidence.workers).toHaveLength(3);
  expect(evidence.workers.every(path => path.endsWith('/js/ocr/preprocess-worker.js'))).toBe(true);
  expect(evidence.blocked).toEqual([]);
});

test('aborting a held decode terminates its actual light Worker before allowing a fresh retry', async ({ page }) => {
  const evidence = await localPage(page);
  // Controlled native-decode boundary only: no real decoder hang or busy loop.
  // The rest of the production Worker module and client run unmodified.
  await page.route('**/js/ocr/preprocess-worker.js', async route => {
    const response = await route.fetch();
    const original = await response.text();
    await route.fulfill({ response, body: `const originalDecode = globalThis.createImageBitmap;
      globalThis.createImageBitmap = (...args) => args[0] instanceof Blob
        ? new Promise(() => { postMessage({kind:'synthetic-decode-started'}); }) : originalDecode(...args);
      ${original}` });
  });
  const workerStarted = page.waitForEvent('worker');
  const readyPromise = page.evaluate(async () => {
    const { createLocalImagePreprocessor } = await import('./js/ocr/preprocess-client.js');
    const NativeWorker = globalThis.Worker;
    let decodeStarted;
    const started = new Promise(resolve => { decodeStarted = resolve; });
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); this.addEventListener('message', event => {
        if (event.data?.kind === 'synthetic-decode-started') decodeStarted();
      }); }
    };
    const controller = new AbortController(), processor = createLocalImagePreprocessor({ signal: controller.signal });
    globalThis.Worker = NativeWorker;
    const pending = processor.initialize(new Blob(['synthetic-held-decode'], { type: 'image/png' }))
      .then(() => 'unexpected_success', error => error.code);
    window.__syntheticPreprocess = { controller, processor, pending };
    await started;
  });
  const worker = await workerStarted;
  const closed = worker.waitForEvent('close');
  await readyPromise;
  const cancelStartedAt = performance.now();
  const result = await page.evaluate(async () => {
    const task = window.__syntheticPreprocess;
    task.controller.abort();
    const code = await task.pending;
    task.processor.dispose(); delete window.__syntheticPreprocess;
    return { code };
  });
  await closed;
  expect(result.code).toBe('preprocess_aborted');
  // Includes browser-command transport, and waits for the actual native Worker
  // close event, not merely a rejected Promise. Controlled desktop probe only.
  expect(performance.now() - cancelStartedAt).toBeLessThan(2000);
  await page.unroute('**/js/ocr/preprocess-worker.js');
  const retry = await page.evaluate(async () => {
    const { createLocalImagePreprocessor } = await import('./js/ocr/preprocess-client.js');
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 24;
    const file = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    canvas.width = canvas.height = 0;
    const processor = createLocalImagePreprocessor();
    try { return await processor.initialize(file); } finally { processor.dispose(); }
  });
  expect(retry).toEqual({ width: 16, height: 24 });
  expect(evidence.workers).toHaveLength(2);
  expect(evidence.blocked).toEqual([]);
});

test('production image adapter uses the light Worker and never decodes on the page', async ({ page }) => {
  const evidence = await localPage(page);
  const result = await page.evaluate(async () => {
    const { recognizeAlipayPaddleImage, planPaddleRowOcrTiles, PADDLE_SOURCE_OCR_REGION } = await import('./js/paddle-local-ocr.js');
    const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 9317;
    const file = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    canvas.width = canvas.height = 0;
    let pageDecodeCalls = 0, crops = 0, engineDisposed = 0;
    const nativeDecode = globalThis.createImageBitmap;
    globalThis.createImageBitmap = () => { pageDecodeCalls++; throw new Error('Page decode forbidden in this integration test'); };
    try {
      const result = await recognizeAlipayPaddleImage(file, {
        loadAssetManifest: async () => {},
        loadPaddleFactory: async () => async () => ({
          async predict(bitmap) {
            if (!(bitmap instanceof ImageBitmap) || bitmap.width <= 0 || bitmap.height <= 0) throw new Error('Invalid transferred crop');
            crops++; return [{ items: [] }];
          },
          async dispose() { engineDisposed++; },
        }),
      });
      return { width: result.imageWidth, height: result.imageHeight, pageDecodeCalls, crops, engineDisposed,
        expectedCrops: planPaddleRowOcrTiles(1440, 9317, PADDLE_SOURCE_OCR_REGION).length + planPaddleRowOcrTiles(1440, 9317).length,
        tokenCount: result.tokens.length };
    } finally { globalThis.createImageBitmap = nativeDecode; }
  });
  // One 1677px source tile plus seven overlapping holdings tiles at step1340.
  expect(result).toEqual({ width: 1440, height: 9317, pageDecodeCalls: 0, crops: 8, expectedCrops: 8, engineDisposed: 1, tokenCount: 0 });
  expect(evidence.workers).toHaveLength(1);
  expect(evidence.blocked).toEqual([]);
});

test('actual OCR page cancel terminates the default adapter preprocessing Worker before heavy loading', async ({ page }) => {
  const evidence = await localPage(page);
  await page.route('**/js/ocr/preprocess-worker.js', async route => {
    const response = await route.fetch();
    const original = await response.text();
    await route.fulfill({ response, body: `globalThis.createImageBitmap = () => new Promise(() => {
      postMessage({kind:'synthetic-page-decode-started'}); });\n${original}` });
  });
  const image = await page.evaluate(async () => {
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); this.addEventListener('message', event => {
        if (event.data?.kind === 'synthetic-page-decode-started') window.__syntheticPageDecodeStarted = true;
      }); }
    };
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    canvas.width = canvas.height = 0;
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const workerStarted = page.waitForEvent('worker');
  await page.locator('#ocr-image-input').setInputFiles({ name: 'synthetic-held-page.png', mimeType: 'image/png', buffer: Buffer.from(image) });
  const worker = await workerStarted, closed = worker.waitForEvent('close');
  await page.waitForFunction(() => window.__syntheticPageDecodeStarted === true);
  const cancelStartedAt = performance.now();
  await page.locator('#ocr-import-cancel').click();
  await closed;
  expect(performance.now() - cancelStartedAt).toBeLessThan(2000);
  await expect(page.locator('#ocr-import-pick')).toBeEnabled();
  await expect(page.locator('#ocr-import-status')).toContainText('已取消');
  await expect(page.locator('.ocr-candidate')).toHaveCount(0);
  expect(evidence.workers).toHaveLength(1);
  expect(evidence.blocked).toEqual([]);
});
