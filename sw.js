// Offline shell + reading reminders.
// A CLASSIC worker on purpose: 2.0 registered sw.js as a classic script, and browser updates keep
// that type - a module worker (import ...) failed to evaluate there, so those phones never updated
// past 2.0. No import/export in this file, ever.
// Bump CACHE on every release.

// ---- BEGIN copy of js/derive.js + js/reminder.js (tests/sw.test.mjs checks they still agree) ----
const QUIET_FROM = 22.5, QUIET_UNTIL = 8;
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}
function readingDates(sessions) {
  return new Set(sessions.filter((r) => !r.deleted).filter((s) => s.read === true || (s.pages || 0) > 0 || (s.minutes || 0) > 0).map((s) => s.date));
}
function awayDates(sessions) {
  return new Set(sessions.filter((r) => !r.deleted).filter((s) => s.away === true).map((s) => s.date));
}
function streak(sessions, today = localDate()) {
  const dates = readingDates(sessions), away = awayDates(sessions);
  let day = dates.has(today) || away.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (dates.has(day) || away.has(day)) { if (dates.has(day)) n++; day = addDays(day, -1); }
  return n;
}
function decideReminder({ sessions, remindersOn, lastReminder, now = new Date() }) {
  const hour = now.getHours() + now.getMinutes() / 60;
  if (hour < QUIET_UNTIL || hour >= QUIET_FROM) return { send: false, why: 'night' };
  if (!remindersOn) return { send: false, why: 'off' };
  const today = localDate(now);
  if (lastReminder === today) return { send: false, why: 'already-today' };
  if (readingDates(sessions).has(today)) return { send: false, why: 'read-today' };
  if (awayDates(sessions).has(today)) return { send: false, why: 'away' };
  return { send: true, today, streak: streak(sessions, today) };
}
function reminderText(streakDays) {
  return streakDays
    ? { title: `🔥 Keep your ${streakDays}-day streak going`, body: "You haven't read today yet - a 5-minute reading session is enough." }
    : { title: '📖 Time to read', body: 'A 5-minute reading session today starts a streak.' };
}
// ---- END copy ----

const CACHE = 'rd-v19';
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
