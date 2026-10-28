import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';

// Actual built App/native Storage/Web Locks with synthetic HTTP only. This is
// not a live GitHub account, backend durability or global exactly-once proof.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TOKEN = 'synthetic_create_intent_reload_session';
const NOW = '2026-10-26T08:00:00.000Z';
const C = '0000000000000000000000000000000c', B = '0000000000000000000000000000000b';
const KEYS = { holdings: 'fuyu_holdings_v3', intent: 'fuyu_cloud_create_intent_v1', token: 'fuyu_gist_token',
  consent: 'fuyu_gist_token_persist', id: 'fuyu_gist_id', time: 'fuyu_gist_sync_time' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
async function staticSite() {
  const root = await realpath(resolve(ROOT, 'site'));
  const activity = { reads: 0, writes: 0, devProxyReads: 0, expectedSwScriptBlock: 0, closed: false };
  const server = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { activity.writes++; response.writeHead(405).end(); return; }
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (path.includes('/__fundval_dev/')) { activity.devProxyReads++; response.writeHead(404).end(); return; }
      // Native server refusal, not Playwright's block init script, keeps the
      // production opaque-origin quote iframe untouched and pageerrors visible.
      if (path === '/FundVal/sw.js') {
        activity.expectedSwScriptBlock++; response.writeHead(503, { 'Cache-Control': 'no-store' }).end(); return;
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
const sourcePaths = ['index.html', 'js/bootstrap.js', 'js/app.js', 'js/config.js', 'js/version.js',
  'js/resilience.js', 'js/integrity.js', 'js/storage.js', 'js/runtime/sync-status.js', 'js/runtime/sync-policy.js',
  'js/storage/holdings-schema.js', 'js/storage/holdings-migration.js', 'js/storage/holdings-repository.js',
  'js/storage/cloud-create-intent.js', 'js/storage/cloud-archive-ui.js', 'js/storage/cloud-sync.js',
  'js/storage/cloud-runtime.js', 'js/storage/gist-runtime.js', 'js/storage/gist-remote.js', 'js/storage/gist-http.js',
  'js/storage/gist-credentials.js'];
function bindApp() {
  const files = sourcePaths.map(path => {
    const source = readFileSync(resolve(ROOT, path)), site = readFileSync(resolve(ROOT, 'site', path));
    // index's bootstrap reference is deliberately rewritten by the real build.
    const expectedSite = path === 'index.html'
      ? Buffer.from(source.toString('utf8').replace('src="js/bootstrap.js"', 'src="js/app-shell.js"')) : source;
    if (sha256(expectedSite) !== sha256(site)) throw new Error('Source/site mismatch: ' + path);
    return { path, sourceSha256: sha256(source), siteSha256: sha256(site) };
  });
  const manifestRaw = readFileSync(resolve(ROOT, 'site/js/app-chunks.json')), manifest = JSON.parse(manifestRaw);
  const chunks = manifest.chunks.map(chunk => {
    const raw = readFileSync(resolve(ROOT, 'site', chunk.path));
    if (raw.length !== chunk.bytes || sha256(raw) !== chunk.sha256 || gzipSync(raw).length !== chunk.gzipBytes) throw new Error('Chunk mismatch');
    return { path: chunk.path, bytes: raw.length, gzipBytes: chunk.gzipBytes, sha256: chunk.sha256 };
  });
  const value = { scope: 'CURRENT_APP_SOURCE_SITE_AND_EMITTED_CHUNKS_NOT_FULL_WORKTREE_FREEZE',
    files, chunks, manifestSha256: sha256(manifestRaw), configSha256: sha256(readFileSync(resolve(ROOT, 'playwright.config.mjs'))) };
  return { ...value, fingerprint: sha256(JSON.stringify(value)) };
}
async function readState(page) {
  return page.evaluate(async keys => {
    const { canonicalHoldingsDocument } = await import('./js/storage/holdings-schema.js');
    const raw = localStorage.getItem(keys.holdings);
    return { holdingsRaw: raw, canonical: raw && canonicalHoldingsDocument(JSON.parse(raw)), intentRaw: localStorage.getItem(keys.intent),
      selectedId: localStorage.getItem(keys.id), syncTime: localStorage.getItem(keys.time),
      hasSessionToken: sessionStorage.getItem(keys.token) !== null, hasPersistentToken: localStorage.getItem(keys.token) !== null,
      consent: localStorage.getItem(keys.consent), timeOrigin: performance.timeOrigin,
      nativeStorage: localStorage instanceof Storage, nativeLocks: typeof navigator.locks?.request === 'function'
        && Function.prototype.toString.call(navigator.locks.request).includes('[native code]') };
  }, KEYS);
}
const safeSnapshot = value => ({ holdingsRawSha256: sha256(value.holdingsRaw || ''), canonicalSha256: sha256(value.canonical || ''),
  intentSha256: sha256(value.intentRaw || ''), intentBytes: value.intentRaw?.length ?? null, selectedId: value.selectedId,
  syncTime: value.syncTime, hasSessionToken: value.hasSessionToken, hasPersistentToken: value.hasPersistentToken,
  consent: value.consent, timeOrigin: value.timeOrigin, nativeStorage: value.nativeStorage, nativeLocks: value.nativeLocks });

async function upload(page) {
  await page.locator('#cloud-upload-btn').evaluate(button => {
    const observation = { started: false, finished: false };
    globalThis.__intentReloadButton = observation;
    const observer = new MutationObserver(records => {
      if (records.some(record => record.attributeName === 'disabled' && record.oldValue === null)) observation.started = true;
      if (observation.started && !button.disabled) { observation.finished = true; observer.disconnect(); }
    });
    observer.observe(button, { attributes: true, attributeFilter: ['disabled'], attributeOldValue: true });
  });
  await page.locator('#cloud-upload-btn').click();
  await page.waitForFunction(() => globalThis.__intentReloadButton?.finished === true);
  await expect(page.locator('#cloud-upload-btn')).toBeEnabled();
}

for (const failure of ['503', 'network-abort']) test(`native create intent survives ${failure} apply, real reload and empty discovery without replay`, async ({ browser }, testInfo) => {
  const record = { scope: 'HERMETIC_BUILT_APP_NATIVE_STORAGE_LOCKS_NOT_LIVE_GIST_NOT_RELEASE', failure,
    startedAt: new Date().toISOString(), browser: browser.version(), testTimeoutMs: testInfo.timeout, retry: testInfo.retry,
    context: 'fresh_nonpersistent', dialogs: { create: 0, select: 0, unexpected: 0 }, requests: [],
    appliedPost: 0, patch: 0, protocolErrors: [], blockedProvider: 0, blockedExternal: 0,
    nativePageErrors: 0, consoleErrors: 0, snapshots: {}, unknownStage: null, knownStage: null, contextClosed: false };
  const archives = new Map(); let showKnown = false, before, completed = false, postIntentRaw = null;
  let host, context, page;
  const emptyKnown = { schema: 3, deviceId: 'synthetic:known-b', updatedAt: NOW, holdings: [] };
  archives.set(B, { revision: 1, files: {
    'fuyu-holdings-v3.json': { content: JSON.stringify(emptyKnown) },
    'fuyu-holdings.json': { content: JSON.stringify({ schema: 2, device_id: 'synthetic:known-b-legacy', updated_at: NOW, holdings: [] }) },
  } });
  const legacyB = archives.get(B).files['fuyu-holdings.json'].content;
  try {
    expect(testInfo.timeout).toBe(30_000); expect(testInfo.retry).toBe(0);
    before = bindApp(); record.appBindingBefore = before;
    host = await staticSite(); const origin = host.origin;
    context = await browser.newContext({ serviceWorkers: 'allow' });
    context.on('close', () => { record.contextClosed = true; });
    expect(await context.cookies()).toEqual([]);
    await context.addInitScript(origin => {
      if (window === window.top && location.origin === origin && !localStorage.getItem('fuyu_device_id_v1')) {
        localStorage.setItem('fuyu_device_id_v1', 'synthetic:native-intent-reload');
      }
    }, origin);
    page = await context.newPage();
    page.on('pageerror', () => { record.nativePageErrors++; });
    page.on('console', message => { if (message.type() === 'error') record.consoleErrors++; });
    page.on('dialog', async dialog => {
      if (dialog.type() === 'confirm' && dialog.message().includes('创建独立的 Schema 3')) record.dialogs.create++;
      else if (dialog.type() === 'confirm' && dialog.message().includes('切换到所选云端档案')) record.dialogs.select++;
      else record.dialogs.unexpected++;
      await dialog.accept();
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin === 'https://api.github.com' && /^\/gists(?:\/[a-f\d]{1,64})?$/.test(url.pathname)) {
        const headers = { 'access-control-allow-origin': origin,
          'access-control-allow-headers': 'authorization,content-type,accept,cache-control',
          'access-control-allow-methods': 'GET,PATCH,POST,OPTIONS', 'cache-control': 'no-store' };
        const reply = (status, body, extra = {}) => route.fulfill({ status, contentType: 'application/json', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
        if (method === 'OPTIONS') { await reply(204, null); return; }
        if (request.headers().authorization !== 'token ' + TOKEN) { record.protocolErrors.push('unexpected_synthetic_credential'); await reply(401, {}); return; }
        const id = url.pathname === '/gists' ? null : url.pathname.slice(7);
        if (method === 'GET' && id === null) {
          const valid = url.searchParams.get('per_page') === '100' && url.searchParams.get('page') === '1';
          record.requests.push({ method, kind: 'complete-list', knownVisible: showKnown, returned: showKnown ? 1 : 0 });
          if (!valid) { record.protocolErrors.push('unexpected_discovery_page'); await reply(400, {}); return; }
          await reply(200, showKnown ? [{ id: B, updated_at: NOW, files: Object.fromEntries(Object.keys(archives.get(B).files)
            .map(filename => [filename, { filename, truncated: false }])) }] : []); return;
        }
        if (method === 'POST' && id === null) {
          const body = request.postDataJSON(), entries = Object.entries(body.files || {});
          if (body.public !== false || entries.length !== 1 || !/^fuyu-holdings-v3-[a-f\d]{16}\.json$/.test(entries[0][0])
            || typeof entries[0][1]?.content !== 'string' || JSON.parse(entries[0][1].content).schema !== 3) {
            record.protocolErrors.push('invalid_create_shape'); await reply(400, {}); return;
          }
          // Actual native Storage must already contain the prepared barrier
          // before this synthetic server applies the submitted archive.
          const observed = await readState(page);
          expect(observed.intentRaw).not.toBeNull(); expect(observed.nativeStorage).toBe(true); expect(observed.nativeLocks).toBe(true);
          const intent = JSON.parse(observed.intentRaw);
          expect(Object.keys(intent).sort()).toEqual(['createdAt', 'nonce', 'version']); expect(intent.version).toBe(1);
          expect(intent.nonce).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i);
          const nativeLockState = await page.evaluate(() => navigator.locks.query());
          record.preApplyNativeRepositoryLocksHeld = nativeLockState.held.filter(lock => lock.name === 'fuyu_holdings_repository_v1').length;
          expect(record.preApplyNativeRepositoryLocksHeld).toBe(0);
          postIntentRaw = observed.intentRaw; record.snapshots.beforeSyntheticApply = safeSnapshot(observed);
          archives.set(C, { revision: 1, files: structuredClone(body.files) });
          record.appliedPost++; record.requests.push({ method, kind: 'create', applied: true, failure });
          if (failure === '503') await reply(503, {}); else await route.abort('failed');
          return;
        }
        const remote = archives.get(id);
        record.requests.push({ method, kind: 'known-archive', id });
        if (id !== B || !showKnown || !remote) { record.protocolErrors.push('unexpected_archive_access'); await reply(404, {}); return; }
        if (method === 'GET') {
          await reply(200, { id, updated_at: NOW, truncated: false, files: structuredClone(remote.files) }, { etag: `"synthetic-${remote.revision}"` }); return;
        }
        if (method === 'PATCH') {
          const body = request.postDataJSON(), entries = Object.entries(body.files || {});
          if (entries.length !== 1 || !/^fuyu-holdings-v3-[a-f\d]{16}\.json$/.test(entries[0][0]) || JSON.parse(entries[0][1].content).schema !== 3) {
            record.protocolErrors.push('invalid_known_patch'); await reply(400, {}); return;
          }
          remote.files[entries[0][0]] = structuredClone(entries[0][1]); remote.revision++; record.patch++;
          await reply(200, {}); return;
        }
        record.protocolErrors.push('unexpected_gist_method'); await reply(400, {}); return;
      }
      if (url.origin === origin && url.pathname.includes('/__fundval_dev/')) {
        record.blockedProvider++; await route.abort('blockedbyclient'); return;
      }
      if (url.origin === origin && url.pathname.startsWith('/FundVal/') && ['GET', 'HEAD'].includes(method)) { await route.continue(); return; }
      record.blockedExternal++; await route.abort('blockedbyclient');
    });

    await page.goto(origin + '/FundVal/'); await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    await page.locator('#nav-edit').click(); await expect(page.locator('#gist-token')).toBeVisible();
    await page.locator('#i-code').fill('000001'); await page.locator('#i-name').fill('合成刷新安全基金');
    await page.locator('#i-shares').fill('10'); await page.locator('#i-cost').fill('1');
    await page.locator('#add-btn').click();
    await expect(page.locator('#holdings-list [data-action="edit-fund"][data-code="000001"]')).toBeVisible();
    const baseline = await readState(page); record.snapshots.baseline = safeSnapshot(baseline);
    expect(baseline.intentRaw).toBeNull(); expect(baseline.nativeStorage).toBe(true); expect(baseline.nativeLocks).toBe(true);
    await page.locator('#gist-token').fill(TOKEN); await expect(page.locator('#gist-remember-token')).not.toBeChecked();
    await upload(page);
    expect(record.appliedPost).toBe(1); expect(archives.has(C)).toBe(true); expect(record.dialogs.create).toBe(1);
    const failed = await readState(page); record.snapshots.afterAppliedFailure = safeSnapshot(failed);
    expect(failed.intentRaw).toBe(postIntentRaw); expect(failed.canonical).toBe(baseline.canonical); expect(failed.holdingsRaw).toBe(baseline.holdingsRaw);
    expect(failed.hasSessionToken).toBe(true); expect(failed.hasPersistentToken).toBe(false); expect(failed.syncTime).toBeNull(); expect(failed.selectedId).toBeNull();
    await expect(page.locator('#cloud-status')).not.toContainText('远端读回验证一致');

    const listsBeforeReload = record.requests.filter(request => request.kind === 'complete-list').length;
    await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true');
    await page.locator('#nav-edit').click(); await expect(page.locator('#gist-token')).toHaveValue(TOKEN);
    await expect.poll(() => record.requests.filter(request => request.kind === 'complete-list').length).toBeGreaterThan(listsBeforeReload);
    await expect(page.locator('#cloud-status')).toContainText('没有兼容档案');
    const reloaded = await readState(page); record.snapshots.afterRealReload = safeSnapshot(reloaded);
    expect(reloaded.timeOrigin).not.toBe(failed.timeOrigin); expect(reloaded.intentRaw).toBe(postIntentRaw);
    expect(reloaded.canonical).toBe(baseline.canonical); expect(reloaded.holdingsRaw).toBe(baseline.holdingsRaw); expect(reloaded.selectedId).toBeNull();
    await upload(page); await expect(page.locator('#toast')).toContainText('已阻止重复创建');
    const blocked = await readState(page); record.snapshots.afterBlockedReplay = safeSnapshot(blocked);
    expect(record.appliedPost).toBe(1); expect(record.patch).toBe(0); expect(record.dialogs.create).toBe(1);
    expect(blocked.intentRaw).toBe(postIntentRaw); expect(blocked.canonical).toBe(baseline.canonical); expect(blocked.holdingsRaw).toBe(baseline.holdingsRaw);
    expect(blocked.syncTime).toBeNull(); expect(blocked.selectedId).toBeNull();
    await expect(page.locator('#cloud-status')).not.toContainText('远端读回验证一致');
    record.unknownStage = { totalPost: record.appliedPost, patch: record.patch, creationConfirmations: record.dialogs.create,
      intentBytesIdentical: blocked.intentRaw === postIntentRaw, canonicalBytesIdentical: blocked.canonical === baseline.canonical,
      noSyncTime: blocked.syncTime === null, noSelectedId: blocked.selectedId === null, completeEmptyLists: record.requests.filter(row => row.kind === 'complete-list' && row.returned === 0).length };

    // A different explicitly selected known archive is usable; it cannot
    // retroactively resolve/remove the unknown, applied C creation barrier.
    showKnown = true;
    await page.locator('[data-action="cloud-discover"]').click();
    await expect(page.locator('#gist-archive option[value="' + B + '"]')).toHaveCount(1);
    await page.locator('#gist-archive').selectOption(B);
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), KEYS.id)).toBe(B);
    await upload(page); await expect(page.locator('#cloud-status')).toContainText('远端读回验证一致');
    const known = await readState(page); record.snapshots.afterKnownB = safeSnapshot(known);
    expect(known.selectedId).toBe(B); expect(known.syncTime).not.toBeNull(); expect(known.intentRaw).toBe(postIntentRaw);
    expect(record.appliedPost).toBe(1); expect(record.patch).toBe(1); expect(record.dialogs.create).toBe(1); expect(record.dialogs.select).toBe(1);
    expect(known.canonical).toBe(baseline.canonical); expect(known.holdingsRaw).toBe(baseline.holdingsRaw);
    expect(archives.get(B).files['fuyu-holdings.json'].content).toBe(legacyB);
    expect(record.requests.filter(row => row.kind === 'known-archive' && row.id === B && row.method === 'GET').length).toBeGreaterThanOrEqual(2);
    record.knownStage = { id: B, verifiedOnlyAfterExplicitBSelection: true, patch: record.patch,
      unknownCIntentBytesUnchanged: known.intentRaw === postIntentRaw, totalPost: record.appliedPost };
    await expect.poll(() => host.activity.expectedSwScriptBlock).toBeGreaterThanOrEqual(1);
    record.nativeServiceWorkerState = await page.evaluate(async () => ({ registrations: (await navigator.serviceWorker.getRegistrations()).length,
      controlled: navigator.serviceWorker.controller !== null }));
    expect(record.nativeServiceWorkerState).toEqual({ registrations: 0, controlled: false });
    expect(host.activity.writes).toBe(0); expect(host.activity.devProxyReads).toBe(0);
    expect(record.protocolErrors).toEqual([]); expect(record.dialogs.unexpected).toBe(0); expect(record.nativePageErrors).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('known-b-with-unknown-c-barrier.png') });
    completed = true;
  } catch (error) {
    record.failureKind = error?.name === 'TimeoutError' || /timeout/i.test(error?.message || '') ? 'timeout' : 'assertion_or_execution';
    throw error;
  } finally {
    if (context) await context.close();
    if (host) { await host.close(); record.server = host.activity; }
    try { const after = bindApp(); record.appBindingAfter = after; record.appSourceUnchanged = before?.fingerprint === after.fingerprint; }
    catch (_) { record.appSourceUnchanged = false; }
    record.finishedAt = new Date().toISOString(); record.result = completed && !testInfo.errors.length && record.appSourceUnchanged && record.contextClosed && host?.activity.closed ? 'PASS' : 'FAIL';
    const path = testInfo.outputPath('native-create-intent-reload-receipt.json'); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    await testInfo.attach('native-create-intent-reload', { contentType: 'application/json', body: JSON.stringify(record) });
    expect(record.appSourceUnchanged).toBe(true);
    expect(record.contextClosed).toBe(true); expect(host?.activity.closed).toBe(true);
  }
});
