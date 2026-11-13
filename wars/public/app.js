// Food Wars / Beer Wars - client. Plain modules, no build step.
import { h, clear, toast, timeAgo, clock, countdown, colorFor, initials } from './ui.js';
import { scores, ranking, categoryWinners } from './score.js';
import { shrinkPhoto } from './photo.js';

const main = document.getElementById('main');
const sheetRoot = document.getElementById('sheet');
const fx = document.getElementById('fx');
const photoInput = document.getElementById('photo-input');

const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: play on without memory */ } },
};

const app = {
  name: store.get('fw.name', ''),
  sessions: store.get('fw.sessions', {}), // code -> { token, gameName, lastSeen }
  game: null, // latest state from the server
  code: null,
  tab: 'play',
  boardCat: 'all',
  galleryCat: 'all',
  galleryPlayer: 'all',
  stream: null,
  clockSkew: 0,
  pendingCat: null,
  busy: false,
};

// Node.append() would print a null as the text "null"; optional sections are simply skipped.
function mount(...nodes) { main.append(...nodes.filter(Boolean)); }

// ----- API -----

async function api(method, path, { body, raw, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) { payload = raw; headers['Content-Type'] = raw.type || 'image/jpeg'; }
  else if (body) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(`/api${path}`, { method, headers, body: payload }); }
  catch { throw Object.assign(new Error('אין חיבור לשרת. בדקו את האינטרנט ונסו שוב'), { code: 'offline' }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || 'משהו השתבש'), { code: data.error, status: res.status });
  return data;
}

const session = () => app.sessions[app.code];
const gameApi = (method, action = '', opts = {}) => api(method, `/games/${app.code}${action}`, { ...opts, token: session()?.token });

function saveSessions() { store.set('fw.sessions', app.sessions); }
function forgetSession(code) { delete app.sessions[code]; saveSessions(); }

// Run a server action from a button: one at a time, errors land in a toast.
async function act(fn, button) {
  if (app.busy) return;
  app.busy = true;
  if (button) button.disabled = true;
  try { await fn(); }
  catch (e) { toast(e.message, 'bad'); }
  finally { app.busy = false; if (button) button.disabled = false; }
}

// ----- routing -----

function route() {
  const [, kind, rawCode] = location.hash.split('/');
  const code = (rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  closeSheet();
  if (kind === 'g' && code && app.sessions[code]) return openGame(code);
  disconnect();
  app.game = null; app.code = null;
  renderHome(kind === 'join' || kind === 'g' ? code : '');
}

function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function disconnect() {
  if (app.stream) { app.stream.close(); app.stream = null; }
}

function openGame(code) {
  if (app.code === code && app.stream) return render();
  disconnect();
  app.code = code; app.game = null; app.tab = 'play';
  app.boardCat = 'all'; app.galleryCat = 'all'; app.galleryPlayer = 'all';
  render();
  connect();
}

function connect() {
  const code = app.code;
  const stream = new EventSource(`/api/games/${code}/events?token=${encodeURIComponent(session().token)}`);
  app.stream = stream;
  stream.onmessage = (ev) => { if (app.code === code) onState(JSON.parse(ev.data)); };
  // EventSource retries by itself; this only finds out whether retrying is pointless.
  stream.onerror = async () => {
    if (app.code !== code) return;
    try { onState(await gameApi('GET')); }
    catch (e) {
      if (e.status === 401 || e.status === 404) {
        forgetSession(code);
        toast(e.status === 404 ? 'המשחק הזה כבר לא קיים' : e.message, 'bad');
        go('#/');
      }
    }
  };
}

function onState(game) {
  const before = app.game;
  app.game = game;
  app.clockSkew = game.serverTime - Date.now();
  const s = session();
  if (s) { s.gameName = game.name; s.lastSeen = Date.now(); s.status = game.status; saveSessions(); }
  if (before) announce(before, game);
  // The final whistle pulls everyone to the results, whatever they were looking at.
  if (game.status === 'ended' && (app.tab !== 'gallery' || before?.status === 'active')) app.tab = 'results';
  if (game.status !== 'ended' && app.tab === 'results') app.tab = 'play';
  render();
}

// Toasts for things that happened while you were looking.
function announce(before, game) {
  if (before.me.status === 'waiting' && game.me.status === 'in') { toast('הבוס הכניס אותך! 🎉', 'good'); burst('🎉'); }
  if (before.status === 'lobby' && game.status === 'active') { toast('המשחק התחיל! 🚀', 'good'); burst('🚀'); }
  if (before.status === 'active' && game.status === 'ended') { toast('המשחק נגמר! 🏁', 'good'); burst('🏆'); }
  if (game.me.status !== 'in' || game.status !== 'active') return;
  const known = new Set(before.entries.map((e) => e.id));
  const fresh = game.entries.filter((e) => !known.has(e.id) && e.playerId !== game.me.id);
  if (fresh.length === 1) {
    const e = fresh[0];
    const who = game.players.find((p) => p.id === e.playerId);
    const cat = game.categories.find((c) => c.id === e.cat);
    if (who && cat) toast(`${who.name}: \u200E+1 ${cat.emoji}`);
  }
  if (game.me.isHost && (game.waitingCount || 0) > (before.waitingCount || 0)) toast('מישהו מחכה שתכניס אותו 👀');
}

// ----- home -----

function renderHome(joinCode = '') {
  clear(main);
  const nameInput = h('input', { class: 'input', id: 'name', maxLength: 20, placeholder: 'השם שלך', value: app.name, autocomplete: 'nickname', enterKeyHint: 'done' });
  const codeInput = h('input', { class: 'input code-input', id: 'code', maxLength: 5, placeholder: 'קוד משחק', value: joinCode, autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, dir: 'ltr', enterKeyHint: 'go' });
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  const needName = () => {
    const name = nameInput.value.trim();
    if (!name) { toast('קודם כל, איך קוראים לך?', 'bad'); nameInput.focus(); return null; }
    app.name = name; store.set('fw.name', name);
    return name;
  };

  const joinBtn = h('button', { class: 'btn primary', type: 'button' }, 'להצטרף למשחק');
  const join = () => act(async () => {
    const name = needName(); if (!name) return;
    const code = codeInput.value.trim();
    if (code.length < 4) { toast('צריך קוד משחק', 'bad'); codeInput.focus(); return; }
    if (app.sessions[code]) return go(`#/g/${code}`);
    const out = await api('POST', `/games/${code}/join`, { body: { playerName: name } });
    app.sessions[out.code] = { token: out.token, lastSeen: Date.now() };
    saveSessions();
    go(`#/g/${out.code}`);
  }, joinBtn);
  joinBtn.addEventListener('click', join);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  const createBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => { if (needName()) openCreateSheet(); } }, 'להקים משחק חדש');

  const recent = Object.entries(app.sessions).sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0));

  mount(
    h('section', { class: 'hero' },
      h('div', { class: 'hero-emoji' }, '🍺', h('span', { class: 'vs' }, 'VS'), '🍔'),
      h('h1', {}, 'Food Wars'),
      h('p', { class: 'tagline' }, 'מי אוכל, שותה וחוגג יותר? בלי תמונה זה לא נחשב.'),
    ),
    h('section', { class: 'card' },
      h('label', { class: 'label', for: 'name' }, 'מי משחק?'),
      nameInput,
    ),
    h('section', { class: 'card' },
      h('label', { class: 'label', for: 'code' }, joinCode ? 'הוזמנת למשחק' : 'יש לך קוד?'),
      codeInput, joinBtn,
      h('div', { class: 'or' }, 'או'),
      createBtn,
    ),
    recent.length ? h('section', { class: 'card' },
      h('div', { class: 'label' }, 'המשחקים שלי'),
      h('div', { class: 'list' }, recent.map(([code, s]) => h('button', { class: 'row link', type: 'button', onclick: () => go(`#/g/${code}`) },
        h('span', { class: 'row-main' }, s.gameName || code),
        h('span', { class: `tag ${s.status || ''}` }, { lobby: 'בהמתנה', active: 'פעיל', ended: 'נגמר' }[s.status] || code),
      ))),
    ) : null,
    h('p', { class: 'foot' }, 'שותים באחריות 🙏'),
  );
  if (!app.name) nameInput.focus(); else if (joinCode) joinBtn.focus();
}

// ----- create -----

async function openCreateSheet() {
  let defaults = [];
  try { defaults = (await api('GET', '/defaults')).categories; } catch (e) { toast(e.message, 'bad'); return; }
  const cats = defaults.map((c) => ({ ...c, on: true }));
  const nameInput = h('input', { class: 'input', maxLength: 40, placeholder: `המשחק של ${app.name}` });
  const chips = h('div', { class: 'chips wrap' });
  const drawChips = () => {
    clear(chips);
    for (const c of cats) {
      chips.append(h('button', { class: `chip ${c.on ? 'on' : ''}`, type: 'button', 'aria-pressed': String(c.on), onclick: () => { c.on = !c.on; drawChips(); } }, `${c.emoji} ${c.label}`));
    }
  };
  drawChips();
  const emojiInput = h('input', { class: 'input emoji-input', maxLength: 4, placeholder: '🍕', 'aria-label': 'אימוג׳י' });
  const labelInput = h('input', { class: 'input', maxLength: 30, placeholder: 'אתגר משלך, למשל: לאכול פיצה', 'aria-label': 'שם האתגר' });
  const add = () => {
    const label = labelInput.value.trim();
    if (!label) { labelInput.focus(); return; }
    if (cats.length >= 12) { toast('עד 12 אתגרים', 'bad'); return; }
    cats.push({ id: `x${Date.now().toString(36)}`, emoji: emojiInput.value.trim() || '⭐', label, on: true });
    labelInput.value = ''; emojiInput.value = '';
    drawChips();
  };
  labelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  const createBtn = h('button', { class: 'btn primary', type: 'button' }, 'להקים משחק');
  createBtn.addEventListener('click', () => act(async () => {
    const chosen = cats.filter((c) => c.on).map(({ id, emoji, label }) => ({ id, emoji, label }));
    if (!chosen.length) { toast('צריך לבחור לפחות אתגר אחד', 'bad'); return; }
    const out = await api('POST', '/games', { body: { playerName: app.name, name: nameInput.value, categories: chosen } });
    app.sessions[out.code] = { token: out.token, lastSeen: Date.now() };
    saveSessions();
    go(`#/g/${out.code}`);
  }, createBtn));

  openSheet(
    h('h2', {}, 'משחק חדש'),
    h('label', { class: 'label' }, 'שם המשחק'), nameInput,
    h('div', { class: 'label' }, 'על מה מתחרים? מי שעושה הכי הרבה מנצח'),
    chips,
    h('div', { class: 'add-row' }, emojiInput, labelInput, h('button', { class: 'btn small', type: 'button', onclick: add }, 'הוספה')),
    createBtn,
  );
}

// ----- sheets -----

function openSheet(...children) {
  closeSheet();
  const panel = h('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true' },
    h('button', { class: 'sheet-close', type: 'button', 'aria-label': 'סגירה', onclick: closeSheet }, '✕'),
    ...children);
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e) => { if (e.target === backdrop) closeSheet(); } }, panel);
  sheetRoot.append(backdrop);
  document.body.classList.add('sheet-open');
  return panel;
}

function closeSheet() {
  for (const img of sheetRoot.querySelectorAll('img[data-blob]')) URL.revokeObjectURL(img.src);
  clear(sheetRoot);
  document.body.classList.remove('sheet-open');
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

function confirmSheet(title, text, okLabel, onOk) {
  const ok = h('button', { class: 'btn danger', type: 'button' }, okLabel);
  ok.addEventListener('click', () => act(async () => { await onOk(); closeSheet(); }, ok));
  openSheet(h('h2', {}, title), h('p', { class: 'muted' }, text), ok, h('button', { class: 'btn ghost', type: 'button', onclick: closeSheet }, 'ביטול'));
}

// ----- effects -----

function burst(emoji) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (let i = 0; i < 14; i++) {
    const bit = h('span', { class: 'bit' }, emoji);
    bit.style.left = `${8 + Math.random() * 84}%`;
    bit.style.animationDelay = `${Math.random() * 0.35}s`;
    bit.style.fontSize = `${22 + Math.random() * 26}px`;
    fx.append(bit);
    setTimeout(() => bit.remove(), 2200);
  }
}

// ----- game -----

function render() {
  if (!app.code) return;
  const g = app.game;
  clear(main);
  if (!g) { mount(h('div', { class: 'center' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, 'מתחברים למשחק…'))); return; }
  mount(header(g));
  if (g.me.status === 'out') return mount(outView());
  if (g.me.status === 'waiting') return mount(waitingView(g));
  if (g.status === 'lobby') return mount(lobbyView(g));
  if (g.me.isHost) mount(waitingList(g));
  if (g.status === 'active') {
    mount(tabs([['play', 'משחק'], ['board', 'טבלה'], ['gallery', `גלריה (${g.entries.length})`]]));
    mount(app.tab === 'board' ? boardView(g) : app.tab === 'gallery' ? galleryView(g) : playView(g));
  } else {
    mount(tabs([['results', 'תוצאות'], ['gallery', `גלריה (${g.entries.length})`]]));
    mount(app.tab === 'gallery' ? galleryView(g) : resultsView(g));
  }
}

function header(g) {
  return h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'חזרה לדף הבית', onclick: () => go('#/') }, '→'),
    h('div', { class: 'topbar-title' }, h('strong', {}, g.name), h('span', { class: 'muted small' }, `קוד ${g.code}`)),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'הזמנת חברים', onclick: () => invite(g) }, '🔗'),
  );
}

async function invite(g) {
  const url = `${location.origin}${location.pathname}#/join/${g.code}`;
  const text = `בואו ל-${g.name} ב-Food Wars! קוד: ${g.code}`;
  if (navigator.share) { try { await navigator.share({ title: 'Food Wars', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('הקישור הועתק 📋', 'good'); }
  catch { toast(`קוד המשחק: ${g.code}`); }
}

function tabs(items) {
  return h('nav', { class: 'tabs', role: 'tablist' }, items.map(([id, label]) =>
    h('button', { class: `tab ${app.tab === id ? 'on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(app.tab === id), onclick: () => { app.tab = id; render(); scrollTo(0, 0); } }, label)));
}

function avatar(player, extra = '') {
  const el = h('span', { class: `avatar ${extra}` }, initials(player?.name));
  el.style.backgroundColor = colorFor(player?.id || '');
  return el;
}

function outView() {
  return h('section', { class: 'center' },
    h('div', { class: 'big-emoji' }, '👋'),
    h('h2', {}, 'יצאת מהמשחק'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => { forgetSession(app.code); go('#/'); } }, 'חזרה לדף הבית'));
}

function waitingView(g) {
  const leaveBtn = h('button', { class: 'btn ghost', type: 'button' }, 'לא משנה, לצאת');
  leaveBtn.addEventListener('click', () => act(async () => { await gameApi('POST', '/leave'); forgetSession(app.code); go('#/'); }, leaveBtn));
  return h('section', { class: 'center' },
    h('div', { class: 'big-emoji pulse' }, '⏳'),
    h('h2', {}, 'ברשימת ההמתנה'),
    h('p', { class: 'muted' }, `מחכים ש${g.hostName || 'הבוס'} יכניס אותך לקבוצה. הדף יתעדכן לבד.`),
    h('p', { class: 'muted small' }, `${g.memberCount} כבר בפנים`),
    leaveBtn);
}

function waitingList(g) {
  const waiting = g.players.filter((p) => p.status === 'waiting');
  if (!waiting.length) return null;
  const allBtn = h('button', { class: 'btn small primary', type: 'button' }, 'להכניס את כולם');
  allBtn.addEventListener('click', () => act(() => gameApi('POST', '/approve', { body: { all: true } }), allBtn));
  return h('section', { class: 'card waiting-card' },
    h('div', { class: 'card-head' }, h('div', { class: 'label' }, `רשימת המתנה (${waiting.length})`), waiting.length > 1 ? allBtn : null),
    h('div', { class: 'list' }, waiting.map((p) => {
      const yes = h('button', { class: 'btn small primary', type: 'button', 'aria-label': `להכניס את ${p.name}` }, 'להכניס');
      const no = h('button', { class: 'btn small ghost', type: 'button', 'aria-label': `לדחות את ${p.name}` }, '✕');
      yes.addEventListener('click', () => act(() => gameApi('POST', '/approve', { body: { playerId: p.id } }), yes));
      no.addEventListener('click', () => act(() => gameApi('POST', '/kick', { body: { playerId: p.id } }), no));
      return h('div', { class: 'row' }, avatar(p), h('span', { class: 'row-main' }, p.name), yes, no);
    })));
}

function memberRow(g, p) {
  const kickBtn = g.me.isHost && p.id !== g.hostId
    ? h('button', { class: 'btn small ghost', type: 'button', 'aria-label': `להוציא את ${p.name}`, onclick: () => confirmSheet(`להוציא את ${p.name}?`, 'התמונות שכבר עלו יישארו בגלריה.', 'להוציא', () => gameApi('POST', '/kick', { body: { playerId: p.id } })) }, '✕')
    : null;
  return h('div', { class: 'row' }, avatar(p),
    h('span', { class: 'row-main' }, p.name, p.id === g.me.id ? h('span', { class: 'muted small' }, ' (אני)') : null),
    p.id === g.hostId ? h('span', { class: 'tag boss' }, '👑 הבוס') : null, kickBtn);
}

function lobbyView(g) {
  const members = g.players.filter((p) => p.status === 'in');
  const parts = [
    h('section', { class: 'card code-card' },
      h('div', { class: 'label' }, 'קוד המשחק'),
      h('div', { class: 'code', dir: 'ltr' }, g.code),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => invite(g) }, 'להזמין חברים 🔗')),
    g.me.isHost ? waitingList(g) : null,
    h('section', { class: 'card' },
      h('div', { class: 'label' }, `בקבוצה (${members.length})`),
      h('div', { class: 'list' }, members.map((p) => memberRow(g, p)))),
    h('section', { class: 'card' },
      h('div', { class: 'label' }, 'על מה מתחרים'),
      h('div', { class: 'chips wrap' }, g.categories.map((c) => h('span', { class: 'chip on static' }, `${c.emoji} ${c.label}`)))),
  ];
  if (g.me.isHost) {
    const hours = h('select', { class: 'input', id: 'hours' },
      [['0', 'עד שאני מסיים'], ['1', 'שעה'], ['3', '3 שעות'], ['6', '6 שעות'], ['12', '12 שעות'], ['24', 'יום שלם'], ['48', 'יומיים'], ['72', '3 ימים'], ['168', 'שבוע']]
        .map(([v, label]) => h('option', { value: v }, label)));
    hours.value = store.get('fw.hours', '0');
    hours.addEventListener('change', () => store.set('fw.hours', hours.value));
    const startBtn = h('button', { class: 'btn primary big', type: 'button' }, 'להתחיל את המשחק 🚀');
    startBtn.addEventListener('click', () => act(() => gameApi('POST', '/start', { body: { hours: Number(hours.value) } }), startBtn));
    parts.push(h('section', { class: 'card' },
      h('label', { class: 'label', for: 'hours' }, 'כמה זמן משחקים?'), hours, startBtn,
      g.waitingCount ? h('p', { class: 'muted small' }, 'יש עוד אנשים ברשימת ההמתנה. אפשר להכניס אותם גם אחרי שמתחילים.') : null));
  } else {
    parts.push(h('p', { class: 'center-note' }, h('span', { class: 'pulse' }, '⏳'), ' מחכים שהבוס יתחיל את המשחק…'));
  }
  return h('div', {}, parts);
}

// ----- play -----

function playView(g) {
  const mine = scores(g)[g.me.id] || { total: 0, byCat: {} };
  const rank = ranking(g, 'all');
  const place = rank.findIndex((r) => r.player.id === g.me.id) + 1;
  const timer = g.endsAt ? h('span', { class: 'timer', id: 'timer' }, countdown(g.endsAt - serverNow())) : null;
  const endBtn = g.me.isHost
    ? h('button', { class: 'btn ghost danger-text', type: 'button', onclick: () => confirmSheet('לסיים את המשחק?', 'אחרי הסיום אי אפשר להוסיף נקודות. התוצאות והגלריה נשארות.', 'לסיים', () => gameApi('POST', '/end')) }, 'לסיים את המשחק 🏁')
    : null;
  return h('div', {},
    h('section', { class: 'status' },
      h('div', { class: 'stat' }, h('strong', {}, String(mine.total)), h('span', {}, 'הנקודות שלי')),
      h('div', { class: 'stat' }, h('strong', {}, place && mine.total ? `#${place}` : '-'), h('span', {}, `מתוך ${rank.length}`)),
      timer ? h('div', { class: 'stat' }, timer, h('span', {}, 'נשאר')) : null),
    h('p', { class: 'hint' }, 'עשית משהו? לוחצים, מצלמים, וזה נחשב 📸'),
    h('section', { class: 'grid' }, g.categories.map((c) =>
      h('button', { class: 'action', type: 'button', 'data-cat': c.id, onclick: () => pickPhoto(c.id) },
        h('span', { class: 'action-emoji' }, c.emoji),
        h('span', { class: 'action-label' }, c.label),
        h('span', { class: 'action-count' }, String(mine.byCat[c.id] || 0))))),
    feed(g, 6),
    endBtn);
}

function feed(g, max) {
  const latest = g.entries.slice(-max).reverse();
  if (!latest.length) return h('p', { class: 'center-note' }, 'עוד אין תמונות. מי פותח?');
  return h('section', { class: 'card' },
    h('div', { class: 'label' }, 'מה קורה עכשיו'),
    h('div', { class: 'list' }, latest.map((e) => {
      const p = g.players.find((x) => x.id === e.playerId);
      const c = g.categories.find((x) => x.id === e.cat);
      return h('button', { class: 'row link', type: 'button', onclick: () => openLightbox(g, e.id) },
        avatar(p), h('span', { class: 'row-main' }, `${p?.name || '?'} ${c?.emoji || ''}`, h('span', { class: 'muted small' }, ` ${timeAgo(e.ts, serverNow())}`)),
        h('img', { class: 'thumb', src: e.photo, alt: '', loading: 'lazy' }));
    })));
}

const serverNow = () => Date.now() + app.clockSkew;

setInterval(() => {
  const el = document.getElementById('timer');
  if (el && app.game?.endsAt) el.textContent = countdown(app.game.endsAt - serverNow());
}, 1000);

function pickPhoto(catId) {
  app.pendingCat = catId;
  photoInput.value = '';
  photoInput.click();
}

photoInput.addEventListener('change', async () => {
  const file = photoInput.files && photoInput.files[0];
  const g = app.game;
  const cat = g && g.categories.find((c) => c.id === app.pendingCat);
  if (!file || !cat) return;
  let blob;
  try { blob = await shrinkPhoto(file); }
  catch { toast('לא הצלחנו לקרוא את התמונה. נסו תמונה אחרת', 'bad'); return; }
  const preview = h('img', { class: 'preview', src: URL.createObjectURL(blob), alt: 'התמונה שנבחרה', 'data-blob': '1' });
  const note = h('input', { class: 'input', maxLength: 80, placeholder: 'כיתוב (לא חובה)', enterKeyHint: 'send' });
  const send = h('button', { class: 'btn primary big', type: 'button' }, `זה נחשב! \u200E+1 ${cat.emoji}`);
  const upload = () => act(async () => {
    send.textContent = 'מעלה…';
    try {
      await gameApi('POST', `/entries?cat=${encodeURIComponent(cat.id)}&note=${encodeURIComponent(note.value.trim())}`, { raw: blob });
    } catch (e) { send.textContent = 'לנסות שוב'; throw e; }
    closeSheet();
    toast(`\u200E+1 ${cat.emoji} ${cat.label}`, 'good');
    burst(cat.emoji);
    if (navigator.vibrate) navigator.vibrate(40);
  }, send);
  send.addEventListener('click', upload);
  note.addEventListener('keydown', (e) => { if (e.key === 'Enter') upload(); });
  openSheet(h('h2', {}, `${cat.emoji} ${cat.label}`), preview, note, send,
    h('button', { class: 'btn ghost', type: 'button', onclick: () => pickPhoto(cat.id) }, 'תמונה אחרת'));
});

// ----- board -----

function catChips(g, current, onPick, withAll = 'הכול') {
  const item = (id, label) => h('button', { class: `chip ${current === id ? 'on' : ''}`, type: 'button', 'aria-pressed': String(current === id), onclick: () => onPick(id) }, label);
  return h('div', { class: 'chips scroll' }, item('all', withAll), g.categories.map((c) => item(c.id, `${c.emoji} ${c.label}`)));
}

function rankList(g, catId) {
  const rows = ranking(g, catId);
  const top = Math.max(1, rows[0]?.count || 0);
  const medals = ['🥇', '🥈', '🥉'];
  return h('div', { class: 'list board' }, rows.map((r) => {
    const bar = h('span', { class: 'bar' });
    bar.style.width = `${Math.round((r.count / top) * 100)}%`;
    return h('div', { class: `row rank ${r.player.id === g.me.id ? 'me' : ''}` },
      h('span', { class: 'place' }, r.count ? medals[r.place - 1] || String(r.place) : '-'),
      avatar(r.player),
      h('span', { class: 'row-main' }, h('span', {}, r.player.name), h('span', { class: 'bar-track' }, bar)),
      h('strong', { class: 'count' }, String(r.count)));
  }));
}

function boardView(g) {
  return h('div', {},
    catChips(g, app.boardCat, (id) => { app.boardCat = id; render(); }),
    h('section', { class: 'card' }, rankList(g, app.boardCat)));
}

// ----- results -----

function resultsView(g) {
  const rows = ranking(g, 'all');
  const winners = rows.filter((r) => r.place === 1 && r.count > 0);
  const podium = rows.filter((r) => r.count > 0).slice(0, 3);
  const order = [podium[1], podium[0], podium[2]]; // 2nd, 1st, 3rd
  const perCat = categoryWinners(g);
  return h('div', {},
    h('section', { class: 'winner' },
      h('div', { class: 'big-emoji' }, winners.length ? '🏆' : '🤷'),
      h('h2', {}, winners.length ? winners.map((w) => w.player.name).join(' ו-') : 'אף אחד לא שיחק'),
      winners.length ? h('p', { class: 'muted' }, `${winners.length > 1 ? 'תיקו! ' : ''}${winners[0].count} נקודות`) : null),
    podium.length > 1 ? h('section', { class: 'podium' }, order.map((r, i) => r ? h('div', { class: `step s${[2, 1, 3][i]}` },
      avatar(r.player, 'lg'), h('span', { class: 'step-name' }, r.player.name),
      h('div', { class: 'step-block' }, h('strong', {}, String(r.count)), h('span', {}, ['🥈', '🥇', '🥉'][i]))) : h('div', { class: 'step' }))) : null,
    h('section', { class: 'card' },
      h('div', { class: 'label' }, 'אלופי הקטגוריות'),
      h('div', { class: 'list' }, perCat.map(({ cat, winners: w, count }) => h('button', { class: 'row link', type: 'button', onclick: () => { app.galleryCat = cat.id; app.galleryPlayer = 'all'; app.tab = 'gallery'; render(); scrollTo(0, 0); } },
        h('span', { class: 'cat-emoji' }, cat.emoji),
        h('span', { class: 'row-main' }, h('span', {}, cat.label), h('span', { class: 'muted small' }, count ? w.map((p) => p.name).join(', ') : 'אף אחד')),
        h('strong', { class: 'count' }, count ? String(count) : '-'))))),
    h('section', { class: 'card' },
      h('div', { class: 'label' }, 'הטבלה המלאה'),
      catChips(g, app.boardCat, (id) => { app.boardCat = id; render(); }),
      rankList(g, app.boardCat)),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => shareResults(g, rows) }, 'לשתף את התוצאות 📣'));
}

async function shareResults(g, rows) {
  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.filter((r) => r.count).slice(0, 5).map((r) => `${medals[r.place - 1] || `${r.place}.`} ${r.player.name} - ${r.count}`);
  const text = `🏆 ${g.name} - Food Wars\n${lines.join('\n')}`;
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('התוצאות הועתקו 📋', 'good'); } catch { toast('לא הצלחנו לשתף', 'bad'); }
}

// ----- gallery -----

function galleryEntries(g) {
  return g.entries.filter((e) => (app.galleryCat === 'all' || e.cat === app.galleryCat) && (app.galleryPlayer === 'all' || e.playerId === app.galleryPlayer)).reverse();
}

function galleryView(g) {
  const withPhotos = g.players.filter((p) => g.entries.some((e) => e.playerId === p.id));
  const who = h('select', { class: 'input', 'aria-label': 'של מי התמונות' },
    h('option', { value: 'all' }, 'כל השחקנים'), withPhotos.map((p) => h('option', { value: p.id }, p.name)));
  who.value = withPhotos.some((p) => p.id === app.galleryPlayer) ? app.galleryPlayer : 'all';
  app.galleryPlayer = who.value;
  who.addEventListener('change', () => { app.galleryPlayer = who.value; render(); });
  const list = galleryEntries(g);
  return h('div', {},
    catChips(g, app.galleryCat, (id) => { app.galleryCat = id; render(); }),
    who,
    list.length ? h('section', { class: 'gallery' }, list.map((e) => {
      const p = g.players.find((x) => x.id === e.playerId);
      const c = g.categories.find((x) => x.id === e.cat);
      return h('button', { class: 'tile', type: 'button', 'aria-label': `${p?.name || ''} ${c?.label || ''}`, onclick: () => openLightbox(g, e.id) },
        h('img', { src: e.photo, alt: '', loading: 'lazy' }),
        h('span', { class: 'tile-tag' }, `${c?.emoji || ''} ${p?.name || ''}`));
    })) : h('p', { class: 'center-note' }, 'אין כאן תמונות עדיין'));
}

function openLightbox(g, entryId) {
  // Step through whatever the gallery filter shows; from the feed, through everything.
  let list = app.tab === 'gallery' ? galleryEntries(g) : g.entries.slice().reverse();
  let i = list.findIndex((e) => e.id === entryId);
  if (i < 0) { list = g.entries.slice().reverse(); i = list.findIndex((e) => e.id === entryId); }
  if (i < 0) return;
  const draw = () => {
    const e = list[i];
    const p = g.players.find((x) => x.id === e.playerId);
    const c = g.categories.find((x) => x.id === e.cat);
    const canDelete = g.me.isHost || (e.playerId === g.me.id && g.status === 'active');
    const panel = openSheet(
      h('div', { class: 'row' }, avatar(p), h('span', { class: 'row-main' }, h('span', {}, p?.name || '?'), h('span', { class: 'muted small' }, `${c?.emoji || ''} ${c?.label || ''} · ${clock(e.ts)}`))),
      h('img', { class: 'preview', src: e.photo, alt: `${p?.name || ''}: ${c?.label || ''}` }),
      e.note ? h('p', { class: 'note' }, e.note) : null,
      h('div', { class: 'pager' },
        h('button', { class: 'btn small ghost', type: 'button', disabled: i === 0, onclick: () => { i--; draw(); } }, '→ חדש יותר'),
        h('span', { class: 'muted small' }, `${i + 1} / ${list.length}`),
        h('button', { class: 'btn small ghost', type: 'button', disabled: i === list.length - 1, onclick: () => { i++; draw(); } }, 'ישן יותר ←')),
      canDelete ? h('button', { class: 'btn ghost danger-text', type: 'button', onclick: () => confirmSheet('למחוק את התמונה?', 'הנקודה תרד מהטבלה.', 'למחוק', () => gameApi('DELETE', `/entries/${e.id}`)) }, 'למחוק 🗑️') : null);
    panel.classList.add('lightbox');
  };
  draw();
}

// ----- boot -----

addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  // Phones freeze background tabs; on return make sure the stream is alive and the state is fresh.
  if (document.visibilityState !== 'visible' || !app.code) return;
  if (!app.stream || app.stream.readyState === EventSource.CLOSED) { disconnect(); connect(); }
  else gameApi('GET').then(onState).catch(() => {});
});
route();
