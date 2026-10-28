import { expect, test } from '@playwright/test';

// Browser-created valid bitstreams, not real screenshots/OCR/device evidence.
test('bounded image preflight accepts actual browser PNG, JPEG and WebP bitstreams', async ({ page }) => {
  const origin = `http://127.0.0.1:${Number(process.env.FUNDVAL_E2E_PORT || 4173)}`;
  const blocked = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.includes('/__fundval_dev/') || url.pathname.includes('/assets/ocr/')) {
      blocked.push('unexpected_nonlocal_or_heavy_request'); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await page.goto('/ocr-import.html');
  const results = await page.evaluate(async () => {
    const { readLocalImageHeader } = await import('./js/ocr/image-header.js');
    const output = [];
    for (const [type, width, height] of [['image/png', 1440, 9317], ['image/jpeg', 256, 384], ['image/webp', 256, 384]]) {
      let canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#faf9f5'; context.fillRect(0, 0, width, height);
      context.fillStyle = '#205f97'; context.fillText('Synthetic local bitmap', 12, 24);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.8));
      if (!blob || blob.type !== type) throw new Error('Synthetic codec unsupported');
      canvas.width = 0; canvas.height = 0; canvas = null;
      const header = await readLocalImageHeader(blob);
      const bitmap = await createImageBitmap(blob);
      output.push({ type, header, decoded: { width: bitmap.width, height: bitmap.height } });
      bitmap.close();
    }
    return output;
  });
  expect(results).toEqual([
    { type: 'image/png', header: { format: 'png', width: 1440, height: 9317 }, decoded: { width: 1440, height: 9317 } },
    { type: 'image/jpeg', header: { format: 'jpeg', width: 256, height: 384 }, decoded: { width: 256, height: 384 } },
    { type: 'image/webp', header: { format: 'webp', width: 256, height: 384 }, decoded: { width: 256, height: 384 } },
  ]);
  expect(blocked).toEqual([]);
});
