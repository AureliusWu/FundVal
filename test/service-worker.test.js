import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

function functionBody(source, name) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

function currentCacheVersion(source) {
  const match = source.match(/const CACHE = '([^']+)'/);
  assert.ok(match, 'service worker cache version must be declared');
  return match[1];
}

function createServiceWorkerHarness(source, {
  cacheKeys = [], cached = new Map(), fetchImpl = async () => { throw new Error('offline'); },
} = {}) {
  const listeners = new Map();
  const deleted = [];
  const clientMessages = [];
  const cacheMatches = [];
  const cacheAdds = [];
  let claimed = 0;
  let skipped = 0;
  const client = {
    id: 'client-1',
    url: 'https://example.test/FundVal/',
    postMessage(message) { clientMessages.push(message); },
  };
  const cache = {
    async addAll(requests) { cacheAdds.push(...requests); },
    async match(request) {
      const key = typeof request === 'string' ? request : request.url;
      cacheMatches.push(key);
      return cached.get(key) || null;
    },
    async put() {},
  };
  const clientApi = {
    async claim() { claimed += 1; },
    async get(id) { return id === client.id ? client : null; },
    async matchAll() { return [client]; },
    async openWindow() { return null; },
  };
  const sandbox = {
    caches: {
      async keys() { return [...cacheKeys]; },
      async delete(key) { deleted.push(key); return true; },
      async open() { return cache; },
    },
    clients: clientApi,
    fetch: fetchImpl,
    Request,
    URL,
    Response,
    self: {
      location: { origin: 'https://example.test', href: 'https://example.test/FundVal/sw.js' },
      registration: { async showNotification() {} },
      clients: clientApi,
      async skipWaiting() { skipped += 1; },
      addEventListener(type, listener) { listeners.set(type, listener); },
    },
  };
  runInNewContext(source, sandbox, { filename: 'sw.js' });

  async function dispatchWithLifetime(type, event = {}) {
    let lifetime = Promise.resolve();
    listeners.get(type)({
      ...event,
      waitUntil(promise) { lifetime = Promise.resolve(promise); },
    });
    await lifetime;
  }

  async function dispatchFetch(request) {
    let responsePromise;
    listeners.get('fetch')({
      request,
      waitUntil() {},
      respondWith(promise) { responsePromise = Promise.resolve(promise); },
    });
    return responsePromise ? responsePromise : null;
  }

  return {
    cacheAdds,
    cacheMatches,
    client,
    clientMessages,
    deleted,
    dispatchFetch,
    dispatchWithLifetime,
    get claimed() { return claimed; },
    get skipped() { return skipped; },
  };
}

test('service worker isolates version caches, preserves old tabs during upgrades, and returns errors offline', async () => {
  const [source, app] = await Promise.all([
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
  ]);

  assert.match(source, /const CACHE_PREFIX = 'fuyu-v';/);
  assert.match(source, /BUILD_APP_SHELL_CORE_START[\s\S]*js\/storage\/gist-remote\.js[\s\S]*BUILD_APP_SHELL_CORE_END/);
  assert.match(source, /\.\/quote-bridge\.html/);
  assert.match(source, /\.\/js\/sandbox\/quote-bridge-runtime\.js/);
  assert.match(source, /key\.startsWith\(CACHE_PREFIX\) && key !== CACHE/);
  assert.doesNotMatch(source, /keys\.filter\(key => key !== CACHE\)/);
  assert.match(source, /if \(!previous\.length\)[\s\S]*await self\.clients\.claim\(\)/);
  assert.match(source, /\.sort\(compareCacheVersions\)/);
  assert.match(source, /previous\.slice\(1\)/);
  assert.match(source, /updateRequester[\s\S]*self\.clients\.get\(updateRequester\.id\)[\s\S]*client\.postMessage\(\{ type: 'UPDATE_ACTIVATED'/);
  assert.doesNotMatch(source, /client\.navigate\(/);
  assert.match(source, /event\.source\.id[\s\S]*event\.source\.url/);
  assert.match(source, /event\.waitUntil\(\(async \(\) => \{/);
  for (const name of ['networkFirst', 'cacheFirst', 'staleWhileRevalidate']) {
    assert.match(functionBody(source, name), /Response\.error\(\)/, `${name} must return a Response when offline without a cache`);
  }
  assert.match(source, /async function cachePutBestEffort/);
  assert.match(functionBody(source, 'cachePutBestEffort'), /catch \(_\)[\s\S]*return false;/);
  assert.doesNotMatch(source, /if \(response\.ok\) \(await caches\.open\(CACHE\)\)\.put/);
  assert.match(source, /url\.pathname\.includes\('\/api\/'\)[\s\S]*networkOnly\(event\.request\)/);
  assert.match(source, /assets\/ocr\/asset-manifest\.json'[\s\S]*networkFirst\(event\.request, event, null, \{ cache: 'reload' \}\)/);
  assert.match(source, /assets\/ocr\/[\s\S]*\.\(\?:js\|mjs\)[\s\S]*networkOnly\(event\.request, \{ cache: 'no-cache' \}\)/);
  assert.match(source, /url\.pathname\.includes\('\/assets\/ocr\/'\)[\s\S]*networkOnly\(event\.request\)/);
  assert.match(source, /event\.request\.mode === 'navigate'[\s\S]*networkFirst\(event\.request, event, fallback\)/);
  assert.match(source, /manifest\.json'[\s\S]*networkFirst\(event\.request, event\)/);
  assert.match(source, /fund-catalog\.json'[\s\S]*overseas-models\.json'[\s\S]*staleWhileRevalidate\(event\.request, event\)/);
  assert.match(source, /\(\?:js\|mjs\|css\)[\s\S]*staleWhileRevalidate\(event\.request, event\)/);
  assert.match(source, /icon-.*192\|512[\s\S]*cacheFirst\(event\.request, event\)/);
  assert.match(functionBody(source, 'networkOnly'), /return await fetch\(request, fetchOptions\)/);
  assert.doesNotMatch(functionBody(source, 'networkFirst'), /caches\.match\(/);
  assert.doesNotMatch(functionBody(source, 'cacheFirst'), /caches\.match\(/);
  assert.match(source, /extendLifetime\(event, update\.then/);
  assert.match(source, /GET_VERSION[\s\S]*event\.ports\[0\]\.postMessage\(\{ cache: CACHE \}\)/);
  assert.match(source, /SKIP_WAITING'[\s\S]*event\.waitUntil\(self\.skipWaiting\(\)\)/);
  for (const runtimeModule of [
    'quote-contract.js', 'quote-presentation.js', 'quote-normalizer.js', 'market-session.js', 'source-registry.js',
    'refresh-generation.js', 'refresh-coordinator.js', 'request-signal.js',
  ]) {
    assert.match(source, new RegExp(`js/runtime/${runtimeModule.replace('.', '\\.')}`));
  }
  assert.match(app, /hasServiceWorkerUpdateBlocker\(\)[\s\S]*refreshCoordinator\.stopAndDrain\('service-worker-update'\)[\s\S]*hasServiceWorkerUpdateBlocker\(\)[\s\S]*SKIP_WAITING/);
  assert.match(app, /reg\.waiting[\s\S]*showServiceWorkerUpdate\(reg\.waiting\)/);
  assert.match(app, /BroadcastChannel\('fuyu_sw_update_v1'\)/);
  assert.match(app, /function handleActivatedServiceWorker[\s\S]*hasServiceWorkerUpdateBlocker\(\)[\s\S]*serviceWorkerReloadPending = true/);
  assert.match(app, /controllerchange[\s\S]*handleActivatedServiceWorker/);
  assert.match(app, /addEventListener\('message'[\s\S]*UPDATE_ACTIVATED[\s\S]*handleActivatedServiceWorker/);
  assert.match(app, /beforeunload[\s\S]*hasServiceWorkerUpdateBlocker/);
  const beforeUnloadBody = app.slice(app.indexOf("window.addEventListener('beforeunload'"), app.indexOf("window.addEventListener('online'"));
  assert.doesNotMatch(beforeUnloadBody, /serviceWorkerUpdateApplying/);
  assert.match(app, /serviceWorkerUpdateApplying[\s\S]*status: 'skipped', reason: 'service_worker_update_pending'/);
  assert.match(app, /serviceWorkerUpdateApplying = true;[\s\S]*clearTimeout\(autoRefreshTimer\)[\s\S]*stopAndDrain/);
  assert.match(app, /hasServiceWorkerUpdateBlocker\(\)[\s\S]*isSyncing/);
});

test('install reloads every versioned core asset instead of seeding from an older HTTP cache', async () => {
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const harness = createServiceWorkerHarness(source);
  await harness.dispatchWithLifetime('install');
  assert.ok(harness.cacheAdds.length > 0);
  assert.ok(harness.cacheAdds.every(request => request instanceof Request && request.cache === 'reload'));
  assert.ok(harness.cacheAdds.some(request => request.url === 'https://example.test/FundVal/js/app.js'));
  assert.ok(harness.cacheAdds.some(request => request.url === 'https://example.test/FundVal/quote-bridge.html'));
  assert.ok(harness.cacheAdds.some(request => request.url === 'https://example.test/FundVal/js/sandbox/quote-bridge-runtime.js'));
});

test('service worker activation keeps the newest previous shell and delegates reload to the requesting page', async () => {
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const currentCache = currentCacheVersion(source);
  const harness = createServiceWorkerHarness(source, {
    cacheKeys: ['other-cache', 'fuyu-v0.0.1', 'fuyu-v0.0.2', currentCache],
  });

  await harness.dispatchWithLifetime('message', {
    data: { type: 'SKIP_WAITING' },
    source: harness.client,
  });
  await harness.dispatchWithLifetime('activate');

  assert.equal(harness.skipped, 1);
  assert.equal(harness.claimed, 0, 'upgrades must not claim every existing tab');
  assert.deepEqual(harness.deleted, ['fuyu-v0.0.1']);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.clientMessages)), [
    { type: 'UPDATE_ACTIVATED', cache: currentCache },
  ]);
});

test('first install claims the current page because no older app shell exists', async () => {
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const harness = createServiceWorkerHarness(source, { cacheKeys: ['other-cache', currentCacheVersion(source)] });

  await harness.dispatchWithLifetime('activate');

  assert.equal(harness.claimed, 1);
  assert.deepEqual(harness.deleted, []);
  assert.deepEqual(harness.clientMessages, []);
});

test('offline navigation falls back only for the app root and never substitutes the home page for unknown routes', async () => {
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const cachedShell = new Response('offline shell', { status: 200 });
  const rootHarness = createServiceWorkerHarness(source, {
    cached: new Map([['./index.html', cachedShell]]),
  });
  const rootResponse = await rootHarness.dispatchFetch({
    method: 'GET', mode: 'navigate', url: 'https://example.test/FundVal/',
  });
  assert.equal(await rootResponse.text(), 'offline shell');

  const unknownHarness = createServiceWorkerHarness(source, {
    cached: new Map([['./index.html', new Response('must not leak into unknown route')]]),
  });
  const unknownResponse = await unknownHarness.dispatchFetch({
    method: 'GET', mode: 'navigate', url: 'https://example.test/FundVal/not-a-real-page',
  });
  assert.equal(unknownResponse.type, 'error');
  assert.doesNotMatch(unknownHarness.cacheMatches.join('\n'), /\.\/index\.html/);
});

test('API and large OCR requests stay network-only while offline', async () => {
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const harness = createServiceWorkerHarness(source, {
    cached: new Map([
      ['https://example.test/FundVal/api/quote', new Response('stale API')],
      ['https://example.test/FundVal/assets/ocr/model.onnx', new Response('stale OCR')],
    ]),
  });

  for (const url of [
    'https://example.test/FundVal/api/quote',
    'https://example.test/FundVal/assets/ocr/model.onnx',
  ]) {
    const response = await harness.dispatchFetch({ method: 'GET', mode: 'cors', url });
    assert.equal(response.type, 'error');
  }
  assert.deepEqual(harness.cacheMatches, []);
});

test('OCR code and manifest revalidate HTTP cache while large immutable assets keep normal HTTP caching', async () => {
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const fetchCalls = [];
  const fetchImpl = async (request, options) => {
    fetchCalls.push({ url: request.url, cache: options?.cache || 'default' });
    return new Response('network', { status: 200 });
  };
  const harness = createServiceWorkerHarness(source, { fetchImpl });
  const urls = [
    'https://example.test/FundVal/assets/ocr/asset-manifest.json',
    'https://example.test/FundVal/assets/ocr/paddle/engine/paddle-ocr-engine.mjs',
    'https://example.test/FundVal/assets/ocr/paddle/engine/assets/fundval-paddle-worker.js',
    'https://example.test/FundVal/assets/ocr/paddle/models/model.tar',
    'https://example.test/FundVal/assets/ocr/paddle/ort/runtime.wasm',
  ];
  for (const url of urls) {
    const response = await harness.dispatchFetch({ method: 'GET', mode: 'cors', url });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(fetchCalls, [
    { url: urls[0], cache: 'reload' },
    { url: urls[1], cache: 'no-cache' },
    { url: urls[2], cache: 'no-cache' },
    { url: urls[3], cache: 'default' },
    { url: urls[4], cache: 'default' },
  ]);
});

test('a new version cache miss revalidates JS against origin before seeding stale-while-revalidate', async () => {
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const fetchCalls = [];
  const fetchImpl = async (request, options) => {
    fetchCalls.push({ url: request.url, cache: options?.cache || 'default' });
    return new Response('network-new', { status: 200 });
  };
  const request = { method: 'GET', mode: 'cors', url: 'https://example.test/FundVal/js/ocr-import-page.js' };
  const missHarness = createServiceWorkerHarness(source, { fetchImpl });
  const missResponse = await missHarness.dispatchFetch(request);
  assert.equal(await missResponse.text(), 'network-new');
  assert.deepEqual(fetchCalls, [{ url: request.url, cache: 'reload' }]);

  fetchCalls.length = 0;
  const hitHarness = createServiceWorkerHarness(source, {
    fetchImpl,
    cached: new Map([[request.url, new Response('cached-current', { status: 200 })]]),
  });
  const hitResponse = await hitHarness.dispatchFetch(request);
  assert.equal(await hitResponse.text(), 'cached-current');
  assert.deepEqual(fetchCalls, [{ url: request.url, cache: 'default' }]);
});
