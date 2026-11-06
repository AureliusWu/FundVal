import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { APP_VERSION } from '../js/version.js';

const PREFIX = '/FundVal/';
const OLD_CACHE = 'fuyu-v16.0.1';
const OCR_MODULES = ['ocr-import-page', 'alipay-ocr-parser', 'fund-catalog', 'holding-import-plan', 'ocr-table-layout', 'ocr/import-transaction']
  .map(name => `${PREFIX}js/${name}.js`);

// A real Chrome controller uses the unchanged app SW policy with the old
// cache name and intentionally stale JS entries. No real image or holdings.
test('old active SW does not mix cached OCR module versions in the new document', async ({ browser }) => {
  const site = new URL('../site/', import.meta.url);
  const sw = await readFile(new URL('sw.js', site), 'utf8');
  const currentCache = `const CACHE = 'fuyu-v${APP_VERSION}';`;
  expect(sw).toContain(currentCache);
  const oldWorker = sw.replace(currentCache, `const CACHE = '${OLD_CACHE}';`);
  const seen = new Set();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    seen.add(url.pathname + url.search);
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === `${PREFIX}sw.js`) {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(oldWorker);
      return;
    }
    if (url.pathname === PREFIX) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Synthetic OCR cache test</title>');
      return;
    }
    if (!/^\/FundVal\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+\.(?:html|css|js|json|png)$/i.test(url.pathname)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(new URL(url.pathname.slice(PREFIX.length), site));
      const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css'
        : url.pathname.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context;
  try {
    context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin + PREFIX);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.evaluate(async ({ cacheName, paths }) => {
      const cache = await caches.open(cacheName);
      for (const path of paths) {
        await cache.put(path, new Response('throw new Error("stale unversioned OCR module executed");', {
          headers: { 'Content-Type': 'text/javascript' },
        }));
      }
    }, { cacheName: OLD_CACHE, paths: OCR_MODULES });

    await page.goto(`${origin}${PREFIX}ocr-import.html`);
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    expect(pageErrors).toEqual([]);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }), page.getByRole('button', { name: '选择本地截图' }).click(),
    ]);
    expect(await chooser.element().getAttribute('id')).toBe('ocr-image-input');
    expect(pageErrors).toEqual([]);
    for (const path of OCR_MODULES) {
      expect(seen.has(`${path}?v=${APP_VERSION}`), path).toBe(true);
      expect(seen.has(path), path).toBe(false);
    }
  } finally {
    try { await context?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
