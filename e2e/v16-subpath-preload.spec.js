import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, extname } from 'node:path';

const SITE = resolve('site');
const sha = value => createHash('sha256').update(value).digest('hex');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function snapshot() {
  const manifest = JSON.parse(await readFile(resolve(SITE, 'js/app-chunks.json'), 'utf8'));
  const files = [...new Set(['index.html', 'manifest.json', 'css/style.css', 'js/app-chunks.json', ...manifest.chunks.map(chunk => chunk.path)])].sort();
  const hashes = {};
  for (const file of files) hashes[file] = sha(await readFile(resolve(SITE, file)));
  for (const chunk of manifest.chunks) expect(hashes[chunk.path]).toBe(chunk.sha256);
  return hashes;
}
async function staticSite() {
  const root = await realpath(SITE), activity = { reads: 0, writes: 0, devProxyReads: 0, expectedSwScriptBlock: 0, closed: false };
  const server = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { activity.writes++; response.writeHead(405).end(); return; }
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (path.startsWith('/__fundval_dev/')) { activity.devProxyReads++; response.writeHead(404).end(); return; }
      // Block the real SW script on this contained server. Playwright's block
      // init script reads a forbidden getter inside the opaque quote iframe.
      if (path === '/FundVal/sw.js') {
        activity.expectedSwScriptBlock++;
        response.writeHead(503, { 'Cache-Control': 'no-store' }).end(); return;
      }
      if (!path.startsWith('/FundVal/') || path.includes('\\') || path.includes('\0')) throw new Error('not_contained');
      const full = await realpath(resolve(root, path.slice('/FundVal/'.length) || 'index.html'));
      const child = relative(root, full);
      if (child.startsWith('..') || isAbsolute(child) || !(await stat(full)).isFile()) throw new Error('not_regular_contained');
      const bytes = await readFile(full); activity.reads++;
      response.writeHead(200, { 'Content-Type': TYPES[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { origin: `http://127.0.0.1:${server.address().port}`, activity,
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); activity.closed = true; } };
}

test('actual built /FundVal app stays interactive without root-absolute chunk preloads', async ({ browser }, testInfo) => {
  const host = await staticSite(); let context, phase = 'setup';
  const evidence = { scope: 'LOCAL_ACTUAL_CHROME_BUILT_SUBPATH_ONLY', syntheticInputOnly: true,
    installedPwaClaim: false, upgradeClaim: false, physicalDeviceClaim: false, holdingsSaved: false,
    ready: false, navEditInteractive: false, navMarketInteractive: false, contextClosed: false,
    rootChunkRequests: [], blockedCategories: {}, consoleCategories: {}, pageErrorCategories: [], forbiddenWrites: 0 };
  try {
    evidence.before = await snapshot();
    context = await browser.newContext({ serviceWorkers: 'allow' });
    context.on('close', () => { evidence.contextClosed = true; });
    expect(await context.cookies()).toEqual([]);
    await context.addInitScript(() => {
      // The production quote bridge deliberately has an opaque sandbox origin.
      // Fresh-storage observation belongs to the top page, never its frames.
      if (window !== window.top) return;
      globalThis.__subpathInitialState = { local: localStorage.length, session: sessionStorage.length };
    });
    const count = (map, key) => { map[key] = (map[key] || 0) + 1; };
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {
        evidence.forbiddenWrites++; count(evidence.blockedCategories, 'nonread_request'); return route.abort('blockedbyclient');
      }
      if (url.origin === host.origin && /^\/js\/chunks\//.test(url.pathname)) {
        evidence.rootChunkRequests.push({ path: url.pathname, method: request.method(), type: request.resourceType() });
        count(evidence.blockedCategories, 'root_chunk_preload'); return route.abort('blockedbyclient');
      }
      if (url.origin === host.origin && url.pathname.startsWith('/FundVal/')) return route.continue();
      count(evidence.blockedCategories, url.origin === host.origin ? 'outside_contained_base' : 'external_read');
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('pageerror', error => evidence.pageErrorCategories.push(error.name));
    page.on('console', message => {
      if (!['warning', 'error'].includes(message.type())) return;
      const text = message.text();
      const category = text.includes('503') ? 'expected_sw_script_http_503'
        : text.includes('ERR_BLOCKED_BY_CLIENT') ? 'blocked_request' : 'other_' + message.type();
      count(evidence.consoleCategories, category);
    });
    phase = 'real_app_ready';
    await page.goto(host.origin + '/FundVal/');
    expect(await page.evaluate(() => globalThis.__subpathInitialState)).toEqual({ local: 0, session: 0 });
    await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true'); evidence.ready = true;
    phase = 'real_nav_edit';
    await page.locator('#nav-edit').click();
    await expect(page.locator('#page-edit')).toHaveClass(/\bactive\b/);
    await page.locator('#i-code').fill('000001');
    await expect(page.locator('#i-code')).toHaveValue('000001'); evidence.navEditInteractive = true;
    phase = 'real_nav_market';
    await page.locator('#nav-market').click();
    await expect(page.locator('#page-market')).toHaveClass(/\bactive\b/); evidence.navMarketInteractive = true;
    phase = 'native_sw_denied_by_server';
    await expect.poll(() => host.activity.expectedSwScriptBlock).toBeGreaterThanOrEqual(1);
    evidence.serviceWorkerState = await page.evaluate(async () => ({
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      controlled: navigator.serviceWorker.controller !== null,
    }));
    expect(evidence.serviceWorkerState).toEqual({ registrations: 0, controlled: false });
    expect(evidence.pageErrorCategories).toEqual([]);
    expect(evidence.forbiddenWrites).toBe(0);
    expect(host.activity.writes).toBe(0); expect(host.activity.devProxyReads).toBe(0);
    phase = 'root_preload_exact_empty_gate';
    expect(evidence.rootChunkRequests).toEqual([]);
    evidence.gatePassed = true;
  } catch (error) { evidence.failurePhase = phase; evidence.failureName = error.name; throw error; }
  finally {
    if (context) await context.close(); await host.close();
    evidence.after = await snapshot();
    evidence.inputsUnchanged = JSON.stringify(evidence.before) === JSON.stringify(evidence.after);
    const path = testInfo.outputPath('subpath-preload-evidence.json');
    await writeFile(path, JSON.stringify({ ...evidence, server: host.activity }, null, 2) + '\n', { flag: 'wx' });
    await testInfo.attach('subpath-preload-evidence.json', { path, contentType: 'application/json' });
    expect(evidence.inputsUnchanged).toBe(true); expect(evidence.contextClosed).toBe(true); expect(host.activity.closed).toBe(true);
  }
});
