// Offline shell. Bump CACHE on every release; the page asks before switching versions.
const CACHE = 'rd-v2';
const SHELL = [
  './', 'index.html', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/caveat-500-latin.woff2',
  'js/app.js', 'js/config.js', 'js/derive.js', 'js/dom.js', 'js/drive.js', 'js/merge.js', 'js/notebook.js',
  'js/openlibrary.js', 'js/rank.js', 'js/rev.js', 'js/store.js', 'js/sync.js', 'js/syncer.js', 'js/validate.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google, Open Library: straight to network
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
