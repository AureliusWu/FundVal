const CACHE = 'fuyu-v1';
const ASSETS = ['./', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // 估值接口不缓存，始终走网络
  if (url.hostname.includes('1234567.com.cn')) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request))
  );
});
