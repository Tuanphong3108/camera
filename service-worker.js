// Tên cache
const CACHE_NAME = 'camera-pwa-cache-v2';

// Các file cần lưu cache
const urlsToCache = [
  '/camera/',
  '/camera/index.html',
  '/camera/manifest.json',
  '/camera/icon.png',
  // thêm js/css nếu có
];

// Sự kiện install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Cache đã được mở');
      return cache.addAll(urlsToCache);
    })
  );
});

// Sự kiện fetch
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

// Sự kiện activate: dọn cache cũ
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!cacheWhitelist.includes(cacheName)) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
