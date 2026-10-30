// The reading session: today only counts once a 5-minute timer runs down with the app open.
// With the screen kept awake (Wake Lock), leaving the app ends the session; on phones without
// it the screen may sleep by itself, so leaving only pauses the timer.

import { h, toast, confetti } from './dom.js';

export const SESSION_MS = 5 * 60 * 1000;
const MAX_MS = 1440 * 60 * 1000; // the most minutes a session record may hold

// Pure timer, driven by a monotonic clock so wall-clock changes can't add or remove time.
export function createTimer({ now = () => performance.now() } = {}) {
  let banked = 0, since = null;
  return {
    running: () => since !== null,
    start() { if (since === null) since = now(); },
    pause() { if (since !== null) { banked += now() - since; since = null; } },
    elapsed: () => banked + (since === null ? 0 : now() - since),
  };
}

export const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000)); // 0:00 only once the time is really up
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let open = false;
export const sessionOpen = () => open;

// complete(): saves the session, returns { id, streak, note? }.
// durationMs: length of the countdown. stopped: what stopping early costs, in one sentence.
// addMinutes(id, minutes): records how long "Keep going" ran. Both are owned by app.js.
// onClose(finished): finished is false when he stopped or left before 0:00.
export function readingSession(book, { cover, complete, addMinutes, openNotebook, onClose, durationMs = SESSION_MS, stopped = 'Today isn\'t counted yet.' }) {
  if (open) return;
  open = true;
  const timer = createTimer();
  let phase = 'counting'; // counting -> done -> extra -> closed
  let locked = false, lock = null, epoch = 0, tick = null, savedId = null;

  const time = h('div', { class: 'session-time', role: 'timer' }, clock(durationMs));
  const note = h('p', { class: 'muted small session-note' }, 'Read until the timer ends. Leaving the app stops the session.');
  const stopBtn = h('button', { class: 'btn wide big-btn', onclick: stop }, 'Stop');
  const card = h('div', { class: 'checkin-card' },
    cover(book), h('div', { class: 'eyebrow' }, 'Reading session'), h('h1', null, book.title), time, note, stopBtn);
  const wrap = h('div', { class: 'checkin-screen session-screen', role: 'dialog', 'aria-label': 'Reading session' }, card);
  document.body.append(wrap);

  async function takeLock() {
    const mine = ++epoch;
    let s = null;
    try { s = await navigator.wakeLock?.request('screen'); } catch { s = null; }
    if (mine !== epoch || phase === 'closed' || document.visibilityState !== 'visible') { s?.release().catch(() => {}); return; }
    lock = s; locked = !!s;
    // The system can drop the lock (battery saver) without him leaving: from then on, pause instead.
    // (The browser also drops it when the page hides; that must still count as leaving.)
    s?.addEventListener('release', () => {
      if (lock !== s) return;
      lock = null;
      if (document.visibilityState === 'visible') locked = false;
    });
    if (!locked) note.textContent = 'Read until the timer ends. If you leave the app, the timer pauses.';
  }
  function dropLock() { epoch++; const s = lock; lock = null; s?.release().catch(() => {}); }

  function paint() {
    if (phase === 'counting') {
      const left = durationMs - timer.elapsed();
      time.textContent = clock(left);
      if (left <= 0) finish();
    } else if (phase === 'extra') {
      const ms = Math.min(timer.elapsed(), MAX_MS);
      time.textContent = clock(ms);
      if (ms >= MAX_MS) endExtra();
    }
  }

  function close() {
    if (phase === 'closed') return;
    const finished = phase !== 'counting';
    phase = 'closed';
    clearInterval(tick);
    dropLock();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onHide);
    wrap.remove();
    open = false;
    onClose?.(finished);
  }

  function stop() {
    if (phase !== 'counting') return;
    if (!confirm(`Stop now? ${stopped}`)) return;
    if (phase !== 'counting') return; // the timer ran out while he was deciding
    close();
    toast(`Session stopped. ${stopped}`);
  }

  async function finish() {
    phase = 'done';
    timer.pause();
    clearInterval(tick);
    let st = null, extraNote = '';
    try { const r = await complete(); savedId = r?.id || null; st = r?.streak ?? null; extraNote = r?.note || ''; }
    catch (e) { close(); toast(`Couldn't save (${e.message})`); return; }
    if (phase === 'closed') return;
    time.textContent = st ? `🔥 ${st}` : '✓';
    note.textContent = extraNote || (st ? `${st} day${st === 1 ? '' : 's'} in a row! Today counts.` : 'Today is already counted.');
    stopBtn.replaceWith(h('div', { class: 'stack wide' },
      h('button', { class: 'btn primary wide big-btn', onclick: () => { close(); openNotebook(); } }, '📓 Open notebook'),
      h('button', { class: 'btn wide big-btn', onclick: keepGoing }, 'Keep going')));
    confetti();
  }

  function keepGoing() {
    phase = 'extra';
    note.textContent = 'Every extra minute is saved. Tap Done when you stop.';
    card.querySelector('.stack.wide').replaceWith(h('button', { class: 'btn primary wide big-btn', onclick: endExtra }, 'Done'));
    timer.start();
    tick = setInterval(paint, 500);
    paint();
  }

  async function endExtra() {
    if (phase !== 'extra') return;
    timer.pause();
    const minutes = Math.min(1440, Math.floor(timer.elapsed() / 60000));
    close();
    if (savedId && minutes > durationMs / 60000) {
      try { await addMinutes(savedId, minutes); toast(`${minutes} minutes today 📚`); } catch { /* the day already counts */ }
    }
  }

  function leave() {
    if (phase === 'counting' && locked) { close(); toastWhenBack(`Session stopped: you left the app. ${stopped}`); }
    else if (phase === 'counting') timer.pause();
    else if (phase === 'extra' && locked) endExtra();
    else if (phase === 'extra') timer.pause();
    else if (phase === 'done') dropLock();
  }
  function onVisibility() {
    if (document.visibilityState === 'hidden') return leave();
    if (phase === 'counting' || phase === 'extra') { timer.start(); paint(); takeLock(); }
  }
  function onHide() { leave(); }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onHide);

  // The clock starts only once we know whether the screen will stay awake, so the rule is settled.
  takeLock().then(() => {
    if (phase !== 'counting') return;
    if (document.visibilityState === 'visible') timer.start();
    tick = setInterval(paint, 500);
  });
}

// A toast shown while the app is hidden would be gone before he sees it.
function toastWhenBack(msg) {
  if (document.visibilityState === 'visible') return toast(msg);
  const show = () => { if (document.visibilityState !== 'visible') return; document.removeEventListener('visibilitychange', show); toast(msg); };
  document.addEventListener('visibilitychange', show);
}

