import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Actual built bootstrap/app and native Chrome SW, not a minimal page or a
// copied update helper. Only the worker's trailing revision comment changes.
// An old cache marker selects the real non-claiming activation branch. This
// same-version experiment is NOT evidence of a v15 -> v16 data migration.
const SITE = fileURLToPath(new URL('../site/', import.meta.url));
const FIXED_TIME = '2026-09-29T06:30:00.000Z';
const FUND = { code: '005844', name: '合成更新门禁基金', shares: 100, cost: 1.2,
  deleted: false, ts: 1790640000000 };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm' };

function siteAssetTarget(path) {
  if (isAbsolute(path)) return null;
  const target = resolve(SITE, path), child = relative(SITE, target);
  return child.startsWith('..') || isAbsolute(child) ? null : target;
}

function estimate(code, value = 1.21) {
  return { code, name: FUND.name, type: '混合型', last_nav: 1.2, est_nav: value,
    est_change: (value / 1.2 - 1) * 100, nav_date: '2026-09-28',
    est_time: '2026-09-29 14:30:00', source_time: '2026-09-29 14:30:00',
    est_kind: 'estimate', est_realtime: true, status: 'ok', source: 'sinan-estimate-proxy' };
}

async function harness(browser) {
  for (const path of ['../package.json', 'C:/Windows/win.ini', 'C:Windows/win.ini', '//remote.example/share/file']) {
    expect(siteAssetTarget(path), 'Only contained relative synthetic site assets may be served').toBeNull();
  }
  const manifest = JSON.parse(await readFile(resolve(SITE, 'js/app-chunks.json'), 'utf8'));
  expect(manifest.entry).toBe('js/app-shell.js');
  const assets = {};
  for (const chunk of manifest.chunks) {
    const hash = createHash('sha256').update(await readFile(resolve(SITE, chunk.path))).digest('hex');
    expect(hash, `Use the existing, unmodified emitted chunk ${chunk.path}`).toBe(chunk.sha256);
    assets[chunk.path] = hash;
  }
  const state = { revision: 1, served: new Set(), events: [], blocked: [], gistWrites: [],
    serverWrites: [], estimateRequests: 0, holdNext: false, held: null, closed: false };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      state.serverWrites.push(request.method);
      response.writeHead(405).end();
      return;
    }
    if (url.pathname === '/__fundval_dev/estimates') {
      state.estimateRequests++;
      const codes = (url.searchParams.get('codes') || '').split(',').filter(code => /^\d{6}$/.test(code));
      const send = (value = 1.21) => {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ fetched_at: FIXED_TIME, items: codes.map(code => estimate(code, value)) }));
      };
      if (state.holdNext) {
        state.holdNext = false;
        state.held = { released: false, release() {
          if (this.released) return;
          this.released = true;
          // A late, deliberately different real Response still travels through
          // the actual fetch/normalizer/generation code, never a fake app hook.
          send(9.99);
        } };
      } else send();
      return;
    }
    if (url.pathname.startsWith('/__fundval_dev/')) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{"error":"synthetic_unavailable"}');
      return;
    }
    if (!url.pathname.startsWith('/FundVal/')) { response.writeHead(404).end(); return; }
    let path;
    try { path = decodeURIComponent(url.pathname.slice('/FundVal/'.length)) || 'index.html'; }
    catch (_) { response.writeHead(400).end(); return; }
    const target = siteAssetTarget(path);
    if (!target) { response.writeHead(403).end(); return; }
    try {
      const body = await readFile(target);
      state.served.add(path);
      response.writeHead(200, { 'Content-Type': `${TYPES[extname(path)] || 'application/octet-stream'}; charset=utf-8` });
      response.end(path === 'sw.js' ? Buffer.concat([body,
        Buffer.from(`\n// Synthetic same-version app-update revision: ${state.revision}\n`)]) : body);
    } catch (_) { response.writeHead(404).end(); }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context;
  const names = new WeakMap(), navigations = new Map();
  async function close() {
    state.held?.release();
    try { if (context) await context.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      state.closed = !server.listening;
    }
  }
  try {
    context = await browser.newContext({ serviceWorkers: 'allow' });
    await context.exposeBinding('__recordUpdateGuardEvidence', ({ page }, event) => {
      state.events.push({ page: names.get(page), ...event });
    });
    await context.addInitScript(({ origin, time, fund }) => {
      if (window !== window.top || location.origin !== origin) return;
      const NativeDate = Date, epoch = NativeDate.parse(time);
      globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [Math.floor(epoch + performance.now())])); }
        static now() { return Math.floor(epoch + performance.now()); }
      };
      if (!localStorage.getItem('fuyu_e2e_update_seeded_v1')) {
        localStorage.setItem('fuyu_holdings_v1', JSON.stringify([fund]));
        localStorage.setItem('fuyu_e2e_update_seeded_v1', '1');
      }
      const documentId = crypto.randomUUID();
      globalThis.__updateGuardDocumentId = documentId;
      const record = kind => globalThis.__recordUpdateGuardEvidence({ documentId, kind }).catch(() => {});
      // Passive platform observers: invoke the original native method, never
      // inject an app function, alter worker messages, or decide update policy.
      const post = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function(message, ...args) {
        if (message?.type === 'SKIP_WAITING') record('skip-waiting');
        return post.call(this, message, ...args);
      };
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type === 'UPDATE_ACTIVATED') record('update-activated');
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => record('controllerchange'));
      const observer = new BroadcastChannel('fuyu_sw_update_v1');
      observer.addEventListener('message', event => {
        if (['prepare', 'blocked'].includes(event.data?.type)) record(`channel-${event.data.type}`);
      });
      // Only an explicitly armed, synthetic /estimates call ignores abort.
      // Its original fetch Response, headers, body and every later call survive.
      const nativeFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = function(input, init) {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (!globalThis.__holdNextUpdateEstimate || url.pathname !== '/__fundval_dev/estimates') return nativeFetch(input, init);
        globalThis.__holdNextUpdateEstimate = false;
        record('held-estimate-start');
        init?.signal?.addEventListener('abort', () => record('held-estimate-aborted'), { once: true });
        const uncooperative = { ...init };
        delete uncooperative.signal;
        return nativeFetch(input, uncooperative);
      };
    }, { origin, time: FIXED_TIME, fund: FUND });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.hostname === 'api.github.com' && !['GET', 'HEAD'].includes(request.method())) state.gistWrites.push(request.method());
      state.blocked.push({ host: url.hostname, method: request.method() });
      return route.abort('blockedbyclient');
    });
    async function page(name, firstInstall = false) {
      const value = await context.newPage();
      names.set(value, name); navigations.set(name, 0);
      value.on('framenavigated', frame => {
        if (frame === value.mainFrame()) navigations.set(name, navigations.get(name) + 1);
      });
      await value.goto(`${origin}/FundVal/`);
      // The actual first-install controllerchange handler reloads the app.
      // Wait for that real main-frame transition before freezing baselines.
      if (firstInstall) await expect.poll(() => navigations.get(name)).toBe(2);
      await ready(value);
      await expect.poll(() => value.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
      await expect.poll(() => value.evaluate(() => Boolean(JSON.parse(localStorage.getItem('fuyu_funds_cache_v1'))?.data?.length))).toBe(true);
      return value;
    }
    async function waiting(value) {
      await value.evaluate(() => caches.open('fuyu-v0.0.1'));
      state.revision++;
      await value.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      await expect.poll(() => value.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting?.state)).toBe('installed');
      await value.evaluate(async () => {
        globalThis.__updateGuardWaiting = (await navigator.serviceWorker.getRegistration()).waiting;
        globalThis.__updateGuardController = navigator.serviceWorker.controller;
      });
      await expect(value.locator('#update-banner')).toBeVisible();
      expect(await value.evaluate(() => __updateGuardWaiting !== navigator.serviceWorker.controller)).toBe(true);
    }
    return { state, context, origin, page, waiting, close, navigations, assets,
      events: (name, kind) => state.events.filter(event => event.page === name && event.kind === kind) };
  } catch (error) { await close(); throw error; }
}

async function ready(page) {
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
  await expect.poll(() => page.evaluate(() => window.__FUNDVAL_BOOTSTRAP_STATUS__?.migration)).toBe('ok');
  await expect(page.locator('#fund-list .skeleton')).toHaveCount(0);
}

async function holdingsHash(page) {
  return page.evaluate(async () => {
    const raw = localStorage.getItem('fuyu_holdings_v3');
    if (!raw || localStorage.getItem('fuyu_gist_token') || localStorage.getItem('fuyu_gist_id')) throw new Error('Synthetic clean holding context required');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
  });
}

async function snapshot(page, navigationCount) {
  return { documentId: await page.evaluate(() => __updateGuardDocumentId), url: page.url(), navigationCount,
    holdingsHash: await holdingsHash(page), inputs: await page.locator('#i-code, #i-name, #i-shares, #i-cost').evaluateAll(inputs => inputs.map(input => input.value)) };
}

async function attachEvidence(testInfo, h, details) {
  expect(h.state.closed, 'The native context and owned HTTP server must be closed').toBe(true);
  expect(h.state.gistWrites).toEqual([]);
  expect(h.state.serverWrites).toEqual([]);
  expect(h.state.served.has('js/app-shell.js')).toBe(true);
  expect([...h.state.served].some(path => /^js\/chunks\/post-integrity-/.test(path))).toBe(true);
  await testInfo.attach('native-built-app-update-guards.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    synthetic: true, sameVersionRevisionOnly: true, versionMigrationClaim: false,
    assets: h.assets, navigationCounts: Object.fromEntries(h.navigations), events: h.state.events,
    providerRequestsBlocked: h.state.blocked.length, gistWrites: h.state.gistWrites,
    ownedServerClosed: h.state.closed, ...details,
  }, null, 2)) });
}

async function finishEvidence(testInfo, h, details, failure) {
  const errors = [];
  for (const action of [() => h.close(), () => attachEvidence(testInfo, h, details)]) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (!errors.length) return;
  if (!failure) throw new AggregateError(errors, 'Update-guard cleanup/evidence failed');
  // Preserve the original assertion and independently expose cleanup failures.
  for (const error of errors) testInfo.annotations.push({ type: 'cleanup-evidence-failure', description: String(error.stack || error) });
}

test('real built app blocks a clean tab update for a dirty peer, then reloads only its requester after the draft is cleared', async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const h = await harness(browser);
  const evidence = {};
  let failure;
  try {
    const requester = await h.page('requester', true);
    const peer = await h.page('peer');
    await peer.locator('#nav-edit').click();
    await peer.locator(`.holding-item[data-code="${FUND.code}"]`).click();
    await peer.locator('#i-shares').fill('999');
    await h.waiting(requester);
    await expect(peer.locator('#update-banner')).toBeVisible();
    await peer.evaluate(() => { globalThis.__updateGuardController = navigator.serviceWorker.controller; });
    const before = { requester: await snapshot(requester, h.navigations.get('requester')),
      peer: await snapshot(peer, h.navigations.get('peer')) };
    evidence.before = before;
    await requester.locator('#update-now-btn').click();
    await expect(requester.locator('#update-banner-text')).toHaveText('其他已打开页面有未保存输入，更新已暂停');
    await expect.poll(() => h.events('requester', 'channel-blocked').length).toBeGreaterThan(0);
    expect(await snapshot(peer, h.navigations.get('peer'))).toEqual(before.peer);
    expect(await snapshot(requester, h.navigations.get('requester'))).toEqual(before.requester);
    expect(h.events('requester', 'skip-waiting')).toHaveLength(0);
    expect(await requester.evaluate(() => __updateGuardWaiting.state)).toBe('installed');
    await expect(peer.locator('#page-edit')).toHaveClass(/\bactive\b/);
    await peer.locator('#cancel-edit-btn').click();
    await expect(peer.locator('#i-shares')).toHaveValue('');
    const peerClean = await snapshot(peer, h.navigations.get('peer'));
    await requester.locator('#update-now-btn').click();
    await expect.poll(() => h.navigations.get('requester')).toBe(before.requester.navigationCount + 1);
    await ready(requester);
    await expect.poll(() => h.events('requester', 'update-activated').length).toBe(1);
    expect(h.events('requester', 'skip-waiting')).toHaveLength(1);
    expect(h.events('peer', 'skip-waiting')).toHaveLength(0);
    expect(h.events('peer', 'update-activated')).toHaveLength(0);
    expect(await holdingsHash(requester)).toBe(before.requester.holdingsHash);
    expect(await snapshot(peer, h.navigations.get('peer'))).toEqual(peerClean);
    await expect(peer.locator('#page-edit')).toHaveClass(/\bactive\b/);
    expect(await requester.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return !registration.waiting && registration.active === navigator.serviceWorker.controller;
    })).toBe(true);
    expect(await peer.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      // A native same-registration activation replaces controlled clients'
      // controllers even without clients.claim(). The app must preserve their
      // documents, not deny the browser's own controllerchange transition.
      return registration.active === navigator.serviceWorker.controller
        && navigator.serviceWorker.controller !== __updateGuardController;
    })).toBe(true);
    await expect(peer.locator('#update-banner')).toBeVisible();
    await expect(peer.locator('#update-now-btn')).toHaveText('重新载入');
    evidence.afterAutomatic = { requester: await snapshot(requester, h.navigations.get('requester')),
      peer: await snapshot(peer, h.navigations.get('peer')) };

    // The peer may explicitly adopt its already-activated controller. Ignoring
    // controllerchange must not leave its old waiting-worker button stuck.
    await peer.locator('#update-now-btn').click();
    await expect.poll(() => h.navigations.get('peer')).toBe(peerClean.navigationCount + 1);
    await ready(peer);
    expect(await snapshot(requester, h.navigations.get('requester'))).toEqual(evidence.afterAutomatic.requester);
    expect(await holdingsHash(peer)).toBe(before.peer.holdingsHash);
    expect(h.events('requester', 'skip-waiting')).toHaveLength(1);
    expect(h.events('peer', 'skip-waiting')).toHaveLength(0);
    expect(h.events('requester', 'update-activated')).toHaveLength(1);
    expect(h.events('peer', 'update-activated')).toHaveLength(0);
    await expect(peer.locator('#update-banner')).toBeHidden();
    expect(await peer.evaluate(async () => (await navigator.serviceWorker.getRegistration()).active
      === navigator.serviceWorker.controller)).toBe(true);
    evidence.afterManual = { requester: await snapshot(requester, h.navigations.get('requester')),
      peer: await snapshot(peer, h.navigations.get('peer')) };
  } catch (error) { failure = error; throw error; }
  finally { await finishEvidence(testInfo, h, evidence, failure); }
});

test('real stopAndDrain rechecks newly dirty input before sending SKIP_WAITING', async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const h = await harness(browser);
  const evidence = {};
  let failure;
  try {
    const page = await h.page('requester', true);
    await h.waiting(page);
    await page.locator('#nav-edit').click();
    const baseline = await snapshot(page, h.navigations.get('requester'));
    const cacheBefore = await page.evaluate(() => localStorage.getItem('fuyu_funds_cache_v1'));
    h.state.holdNext = true;
    await page.evaluate(() => {
      globalThis.__holdNextUpdateEstimate = true;
      window.scrollTo(0, 0);
      const start = new Event('touchstart');
      Object.defineProperty(start, 'touches', { value: [{ clientY: 0 }] });
      window.dispatchEvent(start);
      const end = new Event('touchend');
      Object.defineProperty(end, 'changedTouches', { value: [{ clientY: 100 }] });
      window.dispatchEvent(end);
    });
    await expect.poll(() => Boolean(h.state.held)).toBe(true);
    await expect.poll(() => h.events('requester', 'held-estimate-start').length).toBe(1);
    await page.locator('#update-now-btn').click();
    await expect(page.locator('#update-banner-text')).toHaveText('正在停止旧刷新任务并更新…');
    await expect.poll(() => h.events('requester', 'held-estimate-aborted').length).toBe(1);
    expect(h.state.held.released).toBe(false);
    await page.locator('#i-name').fill('排空期间尚未保存的合成草稿');
    await page.locator('#i-shares').fill('456');
    const dirty = await snapshot(page, h.navigations.get('requester'));
    h.state.held.release();
    await expect(page.locator('#update-banner-text')).toHaveText('检测到未保存编辑，更新仍已暂停');
    await expect(page.locator('#update-now-btn')).toBeEnabled();
    expect(await snapshot(page, h.navigations.get('requester'))).toEqual(dirty);
    expect(dirty.documentId).toBe(baseline.documentId);
    expect(dirty.holdingsHash).toBe(baseline.holdingsHash);
    expect(h.events('requester', 'skip-waiting')).toHaveLength(0);
    expect(h.events('requester', 'update-activated')).toHaveLength(0);
    expect(await page.evaluate(() => __updateGuardWaiting.state)).toBe('installed');
    expect(await page.evaluate(() => navigator.serviceWorker.controller === __updateGuardController)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('fuyu_funds_cache_v1'))).toBe(cacheBefore);
    await expect(page.locator(`#fund-toggle-${FUND.code} .nav-cur`)).not.toHaveText('9.9900');
    evidence.before = baseline;
    evidence.after = dirty;
    evidence.lateSyntheticEstimate = 9.99;
    evidence.lateEstimateDidNotPersistToFundAggregate = true;
    evidence.lateEstimateDidNotReplaceVisibleNav = true;
  } catch (error) { failure = error; throw error; }
  finally { await finishEvidence(testInfo, h, evidence, failure); }
});
