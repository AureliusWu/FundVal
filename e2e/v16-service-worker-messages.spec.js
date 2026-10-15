import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Native browser Client/origin/waiting-worker semantics against the actual
// worker source, with a minimal synthetic same-origin document/CORE server.
// This is not the production app UI, real notification permission, or deployment.
test('native SW messages allow the app client, reject sibling/OCR documents and authenticate an old-controlled waiting requester', async ({ browser }) => {
  const worker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  let revision = 1;
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (path === '/FundVal/sw.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(worker + '\n// Synthetic native-update revision: ' + revision + '\n');
    } else {
      // CORE is fetched/cached but never executes; no providers or user data.
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>Synthetic SW protocol client</title>');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  let context;
  async function version(client, deadline = 2000) {
    return client.evaluate(async timeoutMs => {
      const registration = await navigator.serviceWorker.getRegistration('/FundVal/');
      const worker = registration.waiting || registration.active;
      return new Promise(resolve => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, timeoutMs);
        channel.port1.onmessage = event => {
          clearTimeout(timer); channel.port1.close(); resolve(event.data);
        };
        worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
      });
    }, deadline);
  }
  try {
    context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    await page.goto(origin + '/FundVal/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    expect((await version(page)).cache).toMatch(/^fuyu-v\d+\.\d+\.\d+$/);
    await page.goto(origin + '/FundVal/index.html?from=legacy#edit');
    expect((await version(page)).cache).toMatch(/^fuyu-v\d+\.\d+\.\d+$/);

    const other = await context.newPage();
    for (const path of ['/other.html', '/FundVal/ocr-import.html']) {
      await other.goto(origin + path);
      expect(await version(other, 500)).toBeNull();
    }
    await other.close();

    // Keep a previous-version marker so the actual activate handler follows
    // its non-claiming upgrade branch rather than the first-install branch.
    await page.evaluate(() => caches.open('fuyu-v0.0.1'));
    revision++;
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/FundVal/');
      await registration.update();
    });
    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration('/FundVal/')).waiting))).toBe(true);
    expect(await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/FundVal/');
      return navigator.serviceWorker.controller !== registration.waiting;
    })).toBe(true);
    expect((await version(page)).cache).toMatch(/^fuyu-v\d+\.\d+\.\d+$/);

    const denied = await context.newPage();
    await denied.goto(origin + '/other.html');
    await denied.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/FundVal/');
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    });
    // The same waiting worker must still answer an authenticated request,
    // after processing the out-of-app attempt; it must not have activated.
    expect((await version(page)).cache).toMatch(/^fuyu-v\d+\.\d+\.\d+$/);
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/FundVal/')).waiting?.state)).toBe('installed');
    await denied.close();

    const activation = await page.evaluate(async () => {
      const requested = (await navigator.serviceWorker.getRegistration('/FundVal/')).waiting;
      return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('message', receive); reject(new Error('authenticated activation not acknowledged')); }, 5000);
      function receive(event) {
        if (event.data?.type !== 'UPDATE_ACTIVATED') return;
        clearTimeout(timer); navigator.serviceWorker.removeEventListener('message', receive);
        resolve({ origin: event.origin, cache: event.data.cache, sourceMatchesRequested: event.source === requested });
      }
      navigator.serviceWorker.addEventListener('message', receive);
      requested.postMessage({ type: 'SKIP_WAITING' });
      });
    });
    expect(activation.origin).toBe(origin);
    expect(activation.cache).toMatch(/^fuyu-v\d+\.\d+\.\d+$/);
    expect(activation.sourceMatchesRequested).toBe(true);
  } finally {
    try { if (context) await context.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});

