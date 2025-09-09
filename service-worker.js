// Tên cache
const CACHE_NAME = 'camera-pwa-cache-v2';

// Các file cần cache
const urlsToCache = [
  'index.html',
  'manifest.json',
  'favicon-96x96.png',
  'web-app-manifest-192x192.png',
  'icon.png',
  'english.html',
  'vietnamese.html',
  'web-app-manifest-512x512.png'
];

// Install: cache các file cần thiết
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Cache opened');
      return cache.addAll(urlsToCache);
    })
  );
});

// Fetch: ưu tiên cache trước, mạng sau
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

// Activate: xóa cache cũ
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!cacheWhitelist.includes(cacheName)) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
