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
    Array.from({ length: 24 }, (_, i) => h('i', { style: `--x:${(i * 37) % 100}vw;--d:${(i % 6) * 0.08}s;--h:${(i * 47) % 360}` })));
  document.body.append(c);
  setTimeout(() => c.remove(), 1800);
}
