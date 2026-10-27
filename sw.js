// Offline shell + reading reminders. A module worker, so it shares the app's day/streak logic.
// Bump CACHE on every release; the page asks before switching versions.
import { decideReminder, reminderText } from './js/reminder.js';

const CACHE = 'rd-v17';
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

// ---------- reading reminders (Periodic Background Sync: Chrome decides when it wakes us) ----------

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

// Opens the diary without a version, so it never migrates anything. If the database doesn't exist
// yet, opening would create an empty one the app can't use - abort that and do nothing.
function openDiary() {
  return new Promise((res) => {
    const r = indexedDB.open('reading-diary');
    r.onupgradeneeded = () => { r.transaction.abort(); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
    r.onblocked = () => res(null);
  });
}

async function maybeRemind() {
  const db = await openDiary();
  if (!db) return;
  let decision;
  try {
    if (![...db.objectStoreNames].includes('sessions')) return;
    // Decide and reserve today's reminder in one transaction, so two wake-ups can't both send one.
    const tx = db.transaction(['sessions', 'meta'], 'readwrite');
    const meta = tx.objectStore('meta');
    const [sessions, on, last] = await Promise.all([
      req(tx.objectStore('sessions').getAll()), req(meta.get('remindersOn')), req(meta.get('lastReminder')),
    ]);
    decision = decideReminder({ sessions, remindersOn: !!on?.value, lastReminder: last?.value || null });
    if (decision.send) meta.put({ key: 'lastReminder', value: decision.today });
    await done(tx);
  } finally {
    db.close();
  }
  if (!decision?.send) return;
  const { title, body } = reminderText(decision.streak);
  await self.registration.showNotification(title, { body, tag: 'read-reminder', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
}

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'read-reminder') e.waitUntil(maybeRemind());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow('./');
  })());
});
