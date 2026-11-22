const CACHE_NAME = 'sylobeam-p2p-v20';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css?v=20',
  './app.js?v=20',
  './assets/logo.svg?v=20',
  './assets/space-grotesk-600.woff2',
  './assets/earth-blue-marble.jpg?v=20',
  './assets/earth-clouds.jpg?v=20',
  './assets/earth-topology.jpg?v=20',
  './assets/earth-night.jpg?v=20',
  './vendor/peerjs.min.js',
  './vendor/qrcode.min.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.endsWith('host-info.json') ||
    url.pathname.endsWith('.zip') ||
    url.pathname.endsWith('.exe')
  ) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(request).then((cachedResponse) => {
          return cachedResponse || caches.match('./index.html');
        });
      })
  );
});
