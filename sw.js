const CACHE = 'fuyu-v15.0.2';
const CACHE_PREFIX = 'fuyu-v';
let updateRequester = null;
const CORE = [
  './', './index.html', './quote-bridge.html', './manifest.json', './icon-192.png', './icon-512.png',
  './js/sandbox/quote-bridge-runtime.js', './js/update-compat.js',
  // BUILD_APP_SHELL_CORE_START
  './js/bootstrap.js', './js/migrations.js', './js/resilience.js', './js/integrity.js',
  './js/app.js', './js/version.js', './js/config.js', './js/storage.js',
  './js/calculator.js', './js/overseas-model.js', './js/accuracy.js', './js/freshness.js',
  './js/eastmoney-estimate.js', './js/fund-holdings.js', './js/holdings-estimate.js',
  './js/runtime/quote-contract.js', './js/runtime/quote-presentation.js', './js/runtime/quote-normalizer.js',
  './js/runtime/market-session.js', './js/runtime/source-registry.js',
  './js/runtime/market-clock.js', './js/runtime/valuation-period.js', './js/runtime/worker-contract.js',
  './js/runtime/cache-envelope.js',
  './js/runtime/quote-diagnostics.js',
  './js/runtime/holding-set-contract.js',
  './js/runtime/holding-quote-amounts.js',
  './js/runtime/fund-model-enrichment.js',
  './js/runtime/business-features.js',
  './js/runtime/refresh-generation.js', './js/runtime/refresh-coordinator.js',
  './js/runtime/request-signal.js',
  './js/storage/holdings-schema.js', './js/storage/holdings-migration.js',
  './js/storage/holdings-repository.js', './js/storage/cloud-sync.js', './js/storage/gist-remote.js',
  './js/storage/cloud-archive-ui.js',
  // BUILD_APP_SHELL_CORE_END
  './css/style.css', './data/overseas-models.json'
];

function compareCacheVersions(left, right) {
  const parts = value => {
    const match = String(value).match(/^fuyu-v(\d+)\.(\d+)\.(\d+)$/);
    return match ? match.slice(1).map(Number) : [0, 0, 0];
  };
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

self.addEventListener('install', event => {
  // A new Cache Storage version must be filled from the deployed origin, not
  // from a still-fresh HTTP cache containing the previous release under the
  // same asset URLs (notably js/app-shell.js in production builds).
  const freshCore = CORE.map(path => new Request(new URL(path, self.location.href), { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(freshCore)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const previous = keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).sort(compareCacheVersions);
    // Keep the immediately previous app shell while an old tab may still be
    // using its worker. Older shells are bounded away on the next upgrade.
    await Promise.all(previous.slice(1).map(key => caches.delete(key)));
    if (!previous.length) {
      await self.clients.claim();
      return;
    }
    // Never claim every old tab during an upgrade: that could silently reload
    // another tab with unsaved form input. Ask only the tab that explicitly
    // requested this update to perform its own final dirty-state check. A
    // worker-side navigate() would bypass that last guard and could lose input
    // typed during activation.
    if (updateRequester && updateRequester.id) {
      const client = await self.clients.get(updateRequester.id);
      if (client && typeof client.postMessage === 'function') {
        client.postMessage({ type: 'UPDATE_ACTIVATED', cache: CACHE });
      }
    }
  })());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    updateRequester = event.source && event.source.id
      ? { id: event.source.id, url: event.source.url || './' }
      : null;
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ cache: CACHE });
    return;
  }
  if (data.type === 'notify') {
    event.waitUntil(self.registration.showNotification(data.title || '蜉蝣基金', {
      body: data.body || '', icon: './icon-192.png', badge: './icon-192.png',
      tag: data.tag || 'fuyu-notify', renotify: true, data: { url: data.url || './' }
    }));
  }
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) {
    // API responses may contain time-sensitive or user-specific state. Never
    // replay them from Cache Storage when the network is unavailable.
    event.respondWith(networkOnly(event.request));
  } else if (url.pathname.endsWith('/assets/ocr/asset-manifest.json')) {
    // The small manifest is safe to retain as an offline capability hint. The
    // large OCR binaries themselves remain network-only below. Force origin
    // revalidation so a new release cannot pair new code with an old manifest
    // still present in the browser HTTP cache.
    event.respondWith(networkFirst(event.request, event, null, { cache: 'reload' }));
  } else if (url.pathname.includes('/assets/ocr/') && /\.(?:js|mjs)$/.test(url.pathname)) {
    // OCR code is version-sensitive and intentionally stays out of Cache
    // Storage. Some generated Workers are large, so conditionally revalidate
    // them (allowing a 304) instead of forcing a full reload on every engine.
    event.respondWith(networkOnly(event.request, { cache: 'no-cache' }));
  } else if (url.pathname.includes('/assets/ocr/')) {
    // OCR binaries are very large and already use normal HTTP caching. Keeping
    // another copy in Cache Storage can exhaust mobile PWA quota and evict CORE.
    event.respondWith(networkOnly(event.request));
  } else if (event.request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    const fallback = url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')
      ? './index.html'
      : null;
    event.respondWith(networkFirst(event.request, event, fallback));
  } else if (url.pathname.endsWith('/manifest.json')) {
    event.respondWith(networkFirst(event.request, event));
  } else if (url.pathname.endsWith('/data/fund-catalog.json') || url.pathname.endsWith('/data/overseas-models.json')) {
    event.respondWith(staleWhileRevalidate(event.request, event));
  } else if (/\.(?:js|mjs|css)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event.request, event));
  } else if (/\/icon-(?:192|512)\.png$/.test(url.pathname)) {
    event.respondWith(cacheFirst(event.request, event));
  } else {
    event.respondWith(networkFirst(event.request, event));
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url || './';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const client = list[0];
    return client ? client.focus() : clients.openWindow(target);
  }));
});

async function networkFirst(request, event, navigationFallback = null, fetchOptions = undefined) {
  try {
    const response = await fetch(request, fetchOptions);
    if (response.ok) extendLifetime(event, cacheResponseBestEffort(request, response));
    return response;
  } catch (_) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate' && navigationFallback) {
      return (await cache.match(navigationFallback)) || Response.error();
    }
    return Response.error();
  }
}

async function networkOnly(request, fetchOptions = undefined) {
  try {
    return await fetch(request, fetchOptions);
  } catch (_) {
    return Response.error();
  }
}

async function cacheFirst(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) extendLifetime(event, cachePutBestEffort(cache, request, response));
    return response;
  } catch (_) {
    return Response.error();
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  // A newly versioned Cache Storage bucket must not be seeded from the
  // browser's still-fresh HTTP cache for an older deployment. Existing cache
  // entries keep normal stale-while-revalidate behavior; a current-version
  // miss forces revalidation against the origin before the response is stored.
  const fetchOptions = cached ? undefined : { cache: 'reload' };
  const update = fetch(request, fetchOptions).then(response => {
    if (response.ok) return cachePutBestEffort(cache, request, response).then(() => response);
    return response;
  }).catch(() => null);
  extendLifetime(event, update.then(() => undefined));
  return cached || (await update) || Response.error();
}

function extendLifetime(event, promise) {
  if (event && typeof event.waitUntil === 'function') event.waitUntil(Promise.resolve(promise));
}

async function cacheResponseBestEffort(request, response) {
  try {
    return await cachePutBestEffort(await caches.open(CACHE), request, response);
  } catch (_) {
    return false;
  }
}

async function cachePutBestEffort(cache, request, response) {
  try {
    await cache.put(request, response.clone());
    return true;
  } catch (_) {
    // Large on-demand OCR assets may exceed a mobile browser's cache quota.
    // A successful network response must remain usable even when persistence fails.
    return false;
  }
}
