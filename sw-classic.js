// Fallback for browsers without module service workers (older Safari/Firefox): the same offline
// shell as sw.js, without reading reminders (those need the module worker's shared logic).
// Keep the CACHE name and SHELL list in step with sw.js.
const CACHE = 'rd-v14';
const SHELL = [
  './', 'index.html', 'privacy.html', 'app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/caveat-500-latin.woff2',
  'js/app.js', 'js/config.js', 'js/derive.js', 'js/dom.js', 'js/drive.js', 'js/merge.js', 'js/notebook.js',
  'js/firebase.js', 'js/reviews.js', 'js/social.js', 'js/signout.js', 'js/dedupe.js', 'js/cloud.js', 'js/catalog.js', 'js/explore.js', 'js/friends.js', 'js/activity.js', 'js/session.js',
  'js/reminder.js', 'js/rank.js', 'js/rev.js', 'js/store.js', 'js/sync.js', 'js/syncer.js', 'js/validate.js',
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

