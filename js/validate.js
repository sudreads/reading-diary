// Backup files are untrusted input. Everything is checked before anything touches IndexedDB.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANK = /^[0-9a-z]{0,199}[1-9a-z]$/; // rank.js alphabet; keys never end in '0'
const COVER_HOSTS = ['covers.openlibrary.org', 'openlibrary.org'];
export const MAX_DRAWING_BYTES = 1.5 * 1024 * 1024;
const MAX_TEXT = 20000;

function isRev(r) {
  return r && typeof r === 'object' && Number.isFinite(r.t) && r.t > 0 && typeof r.d === 'string' && r.d.length <= 64;
}

function str(v, max = MAX_TEXT) { return v === undefined || v === null || (typeof v === 'string' && v.length <= max); }
function num(v, lo, hi) { return v === undefined || v === null || (Number.isFinite(v) && v >= lo && v <= hi); }

export function safeCoverUrl(u) {
  if (!u) return true;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && COVER_HOSTS.includes(url.hostname);
  } catch { return false; }
}

const checks = {
  books: (r) => str(r.title, 500) && (r.title || '').length > 0 && str(r.author, 500) && str(r.comment) &&
    str(r.olKey, 100) && safeCoverUrl(r.coverUrl) && ['reading', 'finished', 'want'].includes(r.status) &&
    num(r.rating, 0, 5) && num(r.totalPages, 0, 100000),
  blocks: (r) => typeof r.bookId === 'string' && UUID.test(r.bookId) &&
    ['page', 'comment', 'text', 'quote', 'lesson', 'drawing'].includes(r.type) && str(r.text) &&
    (r.lesson === undefined || typeof r.lesson === 'boolean') && num(r.createdAt, 0, 1e14) &&
    (r.rank === undefined || r.rank === '' || (typeof r.rank === 'string' && RANK.test(r.rank))) &&
    (r.drawingId === undefined || r.drawingId === null || UUID.test(r.drawingId)) &&
    (r.rankRev === undefined || isRev(r.rankRev)),
  sessions: (r) => typeof r.bookId === 'string' && UUID.test(r.bookId) && typeof r.date === 'string' &&
    DATE.test(r.date) && (r.read === undefined || typeof r.read === 'boolean') && (r.away === undefined || typeof r.away === 'boolean') && num(r.pages, 0, 10000) && num(r.minutes, 0, 1440) && num(r.toPage, 0, 100000),
};

// maxT: revisions after this are forged or from a broken clock and are rejected, not clamped.
// fatal: the whole file is unusable (nothing in data); otherwise bad records are dropped one by one.
export function validateBackup(data, { maxT }) {
  const errors = [];
  const out = { books: [], blocks: [], sessions: [], drawings: [] };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, fatal: true, errors: ['Not a backup file'], data: out };
  if (data.app !== 'reading-diary') return { ok: false, fatal: true, errors: ['Not a Reading Diary backup'], data: out };
  if (data.schemaVersion !== 1) return { ok: false, fatal: true, errors: [`Unsupported backup version ${data.schemaVersion}`], data: out };
  for (const kind of ['books', 'blocks', 'sessions']) {
    const list = data[kind];
    if (!Array.isArray(list)) { errors.push(`Missing ${kind}`); continue; }
    for (const r of list) {
      const base = r && typeof r === 'object' && typeof r.id === 'string' && UUID.test(r.id) &&
        isRev(r.rev) && typeof (r.deleted ?? false) === 'boolean';
      if (!base || !checks[kind](r)) { errors.push(`Bad ${kind} record`); continue; }
      if (r.rev.t > maxT || (r.rankRev && r.rankRev.t > maxT)) { errors.push(`${kind} record dated in the future`); continue; }
      out[kind].push(JSON.parse(JSON.stringify(r)));
    }
  }
  for (const d of Array.isArray(data.drawings) ? data.drawings : []) {
    if (!d || !UUID.test(d.id || '') || typeof d.webp !== 'string') { errors.push('Bad drawing'); continue; }
    if (d.webp.length * 0.75 > MAX_DRAWING_BYTES) { errors.push('Drawing too large'); continue; }
    if (!/^[A-Za-z0-9+/=]+$/.test(d.webp)) { errors.push('Bad drawing data'); continue; }
    out.drawings.push({ id: d.id, webp: d.webp });
  }
  return { ok: errors.length === 0, errors, data: out };
}

// Strictly additive: only ids that do not exist locally at all (live or deleted) are taken.
export function additiveRestore(local, incoming) {
  const add = {};
  for (const kind of ['books', 'blocks', 'sessions']) {
    const have = new Set((local[kind] || []).map((r) => r.id));
    add[kind] = (incoming[kind] || []).filter((r) => !have.has(r.id));
  }
  return add;
}
