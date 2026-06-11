const CACHE = 'fuyu-v6';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// JS/CSS 不预缓存，由 network-first 在首次请求时从网络获取最新版

// 安装：预缓存核心静态资源
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting(); // 新 SW 立即接管，不等待旧 SW 释放
});

// 激活：清理旧版本缓存
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // 立即控制所有页面
});

// 请求拦截
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 估值接口不缓存，始终走网络
  if (url.hostname.includes('1234567.com.cn')) return;

  // 东方财富 API 不缓存（基金备源 + 指数行情）
  if (url.hostname.includes('eastmoney.com')) return;

  // 核心代码文件：network-first，确保拿到最新版
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  // 其他静态资源：stale-while-revalidate（先给缓存，后台更新）
  e.respondWith(staleWhileRevalidate(e.request));
});

// network-first：先走网络，失败才用缓存
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    return cached || caches.match('./index.html');
  }
}

// stale-while-revalidate：立即返回缓存，后台拉取最新版
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response && response.ok && request.method === 'GET') {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => cached);
  return cached || fetchPromise;
}
