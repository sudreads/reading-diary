// Tiny DOM builder. Text always goes in as text nodes - never parsed as HTML - so nothing a
// user types, a backup contains or Open Library returns can run as code.

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden']);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  apply(el, props);
  append(el, kids);
  return el;
}

export function s(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  append(el, kids);
  return el;
}

function apply(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
}

function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

// Line icons, drawn in the current text colour. One style for the whole app.
const ICONS = {
  home: ['M3 11l9-8 9 8', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
  search: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14', 'M21 21l-4.3-4.3'],
  books: ['M3 4h4v16H3z', 'M9 4h4v16H9z', 'M15.2 6.2l3.9-1 3.4 13.6-3.9 1z'],
  person: ['M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8', 'M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  share: ['M12 15V4', 'M8 8l4-4 4 4', 'M5 13v6h14v-6'],
};
export function icon(name) {
  return s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
    ICONS[name].map((d) => s('path', { d })));
}

// Every book gets its own colour from its title: blue through violet to pink. The glow and the
// covers also use this hue + 55, so it stops at 290: nothing ever lands on red, orange or green.
export function hueOf(text) {
  let n = 7;
  for (const ch of String(text)) n = (n * 31 + ch.codePointAt(0)) % 100003;
  return 195 + (n % 96);
}

// A light tap you can feel, where the phone supports it.
export const buzz = (ms = 10) => { try { navigator.vibrate?.(ms); } catch { /* not allowed here */ } };

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }
// replaceChildren() that skips false/null like h() does (native would print the word "false").
export function fill(el, ...kids) { clear(el); append(el, kids); return el; }

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Bottom sheet. Returns close(); onClose runs however it was dismissed.
export function sheet(title, body, { onClose } = {}) {
  const root = document.getElementById('sheets');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.remove();
    onClose?.();
  };
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    h('section', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('header', { class: 'sheet-head' },
        h('h2', null, title),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
      body));
  root.append(wrap);
  const first = wrap.querySelector('input, textarea');
  if (first) setTimeout(() => first.focus(), 50);
  return close;
}

// Asks a yes/no question in the app's own style. Resolves true only when the action is chosen;
// tapping outside, Cancel or Escape all mean no. `yes` names the action ("Delete", "Stop").
export function ask(message, { yes = 'Yes', danger = false } = {}) {
  return new Promise((resolve) => {
    const done = (answer) => { document.removeEventListener('keydown', onKey); wrap.remove(); resolve(answer); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    const go = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => done(true) }, yes);
    const wrap = h('div', { class: 'ask-wrap', onclick: (e) => { if (e.target === wrap) done(false); } },
      h('div', { class: 'ask', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': message },
        h('p', null, message),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Cancel'), go)));
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    go.focus();
  });
}

export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function confetti() {
  const c = h('div', { class: 'confetti', 'aria-hidden': 'true' },
    Array.from({ length: 24 }, (_, i) => h('i', { style: `--x:${(i * 37) % 100}vw;--d:${(i % 6) * 0.08}s;--k:${i % 7}` })));
  document.body.append(c);
  setTimeout(() => c.remove(), 1800);
}
