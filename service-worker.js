// Tên cache
const CACHE_NAME = 'camera-pwa-cache-v1';
// Các file cần lưu cache
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  // Thêm các file icon nếu có
  // '/icon-192x192.png',
  // '/icon-512x512.png'
];

// Sự kiện install: Cài đặt service worker và lưu cache các file cần thiết
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Cache đã được mở');
        return cache.addAll(urlsToCache);
      })
  );
});

// Sự kiện fetch: Phản hồi từ cache khi offline
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Trả về file từ cache nếu có
        if (response) {
          return response;
        }
        // Nếu không có, tải về từ mạng
        return fetch(event.request);
      })
  );
});

// Sự kiện activate: Dọn dẹp cache cũ
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
