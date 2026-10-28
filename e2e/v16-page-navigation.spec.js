import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { serveStaticApp } from './helpers/static-app.mjs';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
async function snapshot() {
  const raw = await readFile(resolve(SITE, 'js/app-chunks.json')), manifest = JSON.parse(raw), hashes = {};
  for (const chunk of manifest.chunks) {
    const digest = sha(await readFile(resolve(SITE, chunk.path))); expect(digest).toBe(chunk.sha256); hashes[chunk.path] = digest;
  }
  return { manifest: sha(raw), index: sha(await readFile(resolve(SITE, 'index.html'))), hashes };
}
for (const scenario of ['draft-back', 'edit-deep-link']) test(`panel history ${scenario} stays in the actual App`, async ({ browser }, info) => {
  const server = await serveStaticApp(SITE), before = await snapshot();
  const context = await browser.newContext({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });
  const record = { scope: 'LOCAL_NATIVE_HISTORY_NOT_PHYSICAL_ANDROID_OR_INSTALLED_PWA', scenario,
    pageErrors: [], dialogs: 0, writes: 0, blockedReads: 0, contextClosed: false };
  context.on('close', () => { record.contextClosed = true; });
  const page = await context.newPage();
  try {
    await context.addInitScript(() => { if (window === window.top) globalThis.__navigationDocument = crypto.randomUUID(); });
    await context.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url());
      if (['GET', 'HEAD'].includes(request.method()) && target.origin === server.origin
        && target.pathname.startsWith('/FundVal/')) return route.continue();
      if (!['GET', 'HEAD'].includes(request.method())) record.writes++; else record.blockedReads++;
      return route.abort('blockedbyclient');
    });
    page.on('pageerror', error => record.pageErrors.push(error.name));
    page.on('dialog', async dialog => { record.dialogs++; await dialog.accept(); });
    await page.goto(server.origin + '/FundVal/?navigation=synthetic' + (scenario === 'edit-deep-link' ? '#edit' : ''));
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    let documentId = await page.evaluate(() => __navigationDocument);
    const rawHoldings = await page.evaluate(() => localStorage.getItem('fuyu_holdings_v3'));
    record.holdingsBeforeSha256 = sha(rawHoldings || '');
    if (scenario === 'draft-back') {
      await page.locator('#nav-edit').click();
      await page.locator('#i-code').fill('000001'); await page.locator('#i-name').fill('合成导航草稿');
      await page.locator('#i-shares').fill('10'); await page.locator('#i-cost').fill('0');
      await page.goBack();
      await expect(page.locator('#page-market')).toHaveClass(/\bactive\b/);
      expect(await page.evaluate(() => __navigationDocument)).toBe(documentId);
      expect(new URL(page.url()).search).toBe('?navigation=synthetic');
      await page.locator('#nav-edit').click();
      await expect(page.locator('#i-code')).toHaveValue('000001');
      await expect(page.locator('#i-name')).toHaveValue('合成导航草稿');
      await expect(page.locator('#i-shares')).toHaveValue('10'); await expect(page.locator('#i-cost')).toHaveValue('0');
      await page.evaluate(() => {
        // Native history traversal is asynchronous: both real click handlers
        // run before popstate, but must not queue a second traversal outside.
        document.getElementById('nav-market').click();
        document.getElementById('nav-market').click();
      });
      await expect(page.locator('#page-market')).toHaveClass(/\bactive\b/);
      await page.locator('#nav-edit').click();
      await expect(page.locator('#i-name')).toHaveValue('合成导航草稿');
    } else {
      await expect(page.locator('#page-edit')).toHaveClass(/\bactive\b/);
      const historyLength = await page.evaluate(() => history.length);
      await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
      await expect(page.locator('#page-edit')).toHaveClass(/\bactive\b/);
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      documentId = await page.evaluate(() => __navigationDocument);
      await page.goBack(); await expect(page.locator('#page-market')).toHaveClass(/\bactive\b/);
      expect(await page.evaluate(() => __navigationDocument)).toBe(documentId);
    }
    record.holdingsAfterSha256 = sha(await page.evaluate(() => localStorage.getItem('fuyu_holdings_v3')) || '');
    expect(record.holdingsAfterSha256).toBe(record.holdingsBeforeSha256);
    expect(record.pageErrors).toEqual([]); expect(record.dialogs).toBe(0); expect(record.writes).toBe(0);
    expect(server.activity.writes).toBe(0);
    record.result = 'ASSERTIONS_COMPLETED';
  } finally {
    try { await context.close(); } finally { await server.close(); }
    const after = await snapshot(); record.inputsUnchanged = JSON.stringify(before) === JSON.stringify(after);
    record.server = server.activity;
    const path = info.outputPath('native-panel-navigation-receipt.json');
    await writeFile(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    await info.attach('native-panel-navigation-receipt', { path, contentType: 'application/json' });
    expect(record.inputsUnchanged).toBe(true); expect(record.contextClosed).toBe(true); expect(server.activity.closed).toBe(true);
  }
});
