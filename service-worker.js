const CACHE = 'camera-v22';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'i18n.js', 'icons.js', 'gif-encoder.js', 'mp4-muxer.js', 'scanner.js', 'getting_started.html',
  'language/vi.lang', 'language/en.lang', 'vendor/mwc.js',
  'fonts/gsf-latin.woff2', 'fonts/gsf-vietnamese.woff2', 'fonts/symbols-subset.woff2',
  'manifest.json', 'icon.png', 'favicon-96x96.png', 'web-app-manifest-192x192.png', 'web-app-manifest-512x512.png'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Mạng trước (luôn lấy bản mới), mất mạng thì dùng cache */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
