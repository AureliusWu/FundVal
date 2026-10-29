import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

// Native Chrome + current built shell, not an installed mobile PWA or a
// v15-to-v16 migration. Only a fresh, synthetic browser context is used.
const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function staticSite() {
  const activity = { writes: [], devReads: 0, staticReads: 0 };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (!['GET', 'HEAD'].includes(request.method)) {
      activity.writes.push(request.method); response.writeHead(405).end(); return;
    }
    // Never delegate even a same-origin request to the development proxy.
    if (path.startsWith('/__fundval_dev/')) {
      activity.devReads++; response.writeHead(503).end(); return;
    }
    if (!path.startsWith('/FundVal/')) { response.writeHead(404).end(); return; }
    let child;
    try { child = decodeURIComponent(path.slice('/FundVal/'.length)) || 'index.html'; }
    catch { response.writeHead(400).end(); return; }
    const target = resolve(SITE, child), contained = relative(SITE, target);
    if (isAbsolute(child) || win32.parse(child).root || contained.startsWith('..') || isAbsolute(contained)) {
      response.writeHead(403).end(); return;
    }
    try {
      const body = await readFile(target); activity.staticReads++;
      response.writeHead(200, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  return { origin: `http://127.0.0.1:${server.address().port}`, activity,
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); } };
}

async function ready(page) {
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.locator('#fund-list .skeleton')).toHaveCount(0);
}

for (let sample = 1; sample <= 3; sample++) test(`offline shell sample ${sample}: visible stale notice and usable holdings within 3 seconds`, async ({ browser }, testInfo) => {
  const host = await staticSite();
  let context;
  const evidence = { synthetic: true, sample, viewport: '390x844', sameVersionNativeShell: true,
    installedPwaClaim: false, physicalDeviceClaim: false, versionMigrationClaim: false,
    requestsBlocked: 0, pageErrors: [], externalWrites: 0 };
  try {
    const chunkManifest = JSON.parse(await readFile(resolve(SITE, 'js/app-chunks.json'), 'utf8'));
    evidence.chunks = {};
    for (const chunk of chunkManifest.chunks) {
      const actual = sha(await readFile(resolve(SITE, chunk.path)));
      expect(actual).toBe(chunk.sha256); evidence.chunks[chunk.path] = actual;
    }
    context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === host.origin && ['GET', 'HEAD'].includes(request.method())) return route.continue();
      evidence.requestsBlocked++;
      if (!['GET', 'HEAD'].includes(request.method())) evidence.externalWrites++;
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    let mainFrameNavigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) mainFrameNavigations++; });
    page.on('pageerror', error => evidence.pageErrors.push(error.name));
    await page.goto(`${host.origin}/FundVal/`);
    // The real first-install controllerchange intentionally reloads once.
    // Finish this warm-up transition before measuring an offline navigation.
    await expect.poll(() => mainFrameNavigations).toBe(2);
    await ready(page);
    await page.locator('#nav-edit').click();
    await page.locator('#i-code').fill('005844');
    await page.locator('#i-name').fill('合成离线壳验证基金');
    await page.locator('#i-shares').fill('100');
    await page.locator('#i-cost').fill('0');
    await page.locator('#add-btn').click();
    await expect(page.locator('#holdings-list .holding-item').filter({ hasText: '005844' })).toBeVisible();
    const before = await page.evaluate(() => localStorage.getItem('fuyu_holdings_v3'));
    expect(before).not.toBeNull(); evidence.beforeHoldingsSha256 = sha(before);
    await expect(page.locator('html')).toHaveAttribute('data-network', 'online');
    await expect(page.locator('#offline-banner')).toBeHidden();
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-network', 'offline');
    await expect(page.locator('#offline-banner')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#offline-banner')).toContainText('行情可能过期');
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    await page.locator('#nav-edit').click();
    await expect(page.locator('#page-edit')).toHaveClass(/\bactive\b/);
    const holding = page.locator('#holdings-list .holding-item').filter({ hasText: '005844' });
    await expect(holding).toBeVisible();
    await holding.click();
    await expect(page.locator('#i-shares')).toHaveValue('100');
    await expect(page.locator('#i-cost')).toHaveValue('0');
    evidence.offlineNavigationToEditableHoldingsMs = await page.evaluate(() => performance.now());
    expect(evidence.offlineNavigationToEditableHoldingsMs).toBeLessThanOrEqual(3000);
    const after = await page.evaluate(() => localStorage.getItem('fuyu_holdings_v3'));
    evidence.afterHoldingsSha256 = sha(after);
    expect(after).toBe(before);
    await page.screenshot({ path: testInfo.outputPath('offline-shell-390.png') });
    await context.setOffline(false);
    await expect(page.locator('html')).toHaveAttribute('data-network', 'online');
    await expect(page.locator('#offline-banner')).toBeHidden();
    expect(host.activity.writes).toEqual([]); expect(evidence.externalWrites).toBe(0);
    expect(evidence.pageErrors).toEqual([]);
  } finally {
    try { if (context) await context.close(); } finally { await host.close(); }
    const path = testInfo.outputPath('offline-shell-evidence.json');
    await writeFile(path, JSON.stringify({ ...evidence, server: host.activity }, null, 2) + '\n', { flag: 'wx' });
    await testInfo.attach('offline-shell-evidence.json', { path, contentType: 'application/json' });
  }
});
