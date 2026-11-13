// Small DOM and formatting helpers. Text always goes in as text nodes, never as HTML.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && !key.includes('-') && key !== 'for' && key !== 'dir' && key !== 'role') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) { el.replaceChildren(); }

let toastTimer = null;
export function toast(message, kind = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

export function timeAgo(ts, now = Date.now()) {
  const min = Math.floor(Math.max(0, now - ts) / 60000);
  if (min < 1) return 'עכשיו';
  if (min < 60) return `לפני ${min} דק׳`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `לפני ${hours} שע׳`;
  return `לפני ${Math.floor(hours / 24)} ימים`;
}

export function clock(ts) {
  return new Date(ts).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function countdown(ms) {
  if (ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400), hrs = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (d) return `${d} ימים ${p(hrs)}:${p(m)}`;
  return hrs ? `${p(hrs)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

const COLORS = ['#e4572e', '#17a398', '#7b5ea7', '#2e86de', '#c0392b', '#d98e04', '#2d9d5c', '#c2408f', '#5c6bc0', '#00838f'];
export function colorFor(id) {
  let n = 0;
  for (const ch of String(id)) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return COLORS[n % COLORS.length];
}

export function initials(name) {
  const chars = [...String(name || '?').trim()];
  return chars.slice(0, 2).join('');
}
