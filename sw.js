const CACHE = 'fuyu-v11.0.1';
const CORE = [
  './', './index.html', './manifest.json', './icon-192.png', './icon-512.png',
  './js/bootstrap.js', './js/migrations.js', './js/resilience.js', './js/integrity.js',
  './js/app.js', './js/version.js', './js/config.js', './js/storage.js',
  './js/calculator.js', './js/overseas-model.js', './js/accuracy.js', './js/freshness.js',
  './js/eastmoney-estimate.js',
  './css/style.css', './data/overseas-models.json'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
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
  if (url.pathname.endsWith('/data/overseas-models.json')) {
    event.respondWith(staleWhileRevalidate(event.request));
  } else if (event.request.mode === 'navigate' || url.pathname.endsWith('/index.html')) {
    event.respondWith(networkFirst(event.request));
  } else if (/\.(?:png|json|webmanifest)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(event.request));
  } else {
    event.respondWith(networkFirst(event.request));
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

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  } catch (_) {
    return (await caches.match(request)) || caches.match('./index.html');
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const update = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => cached);
  return cached || update;
}
