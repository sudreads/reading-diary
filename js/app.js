import * as store from './store.js';
import * as syncer from './syncer.js';
import { h, s, clear, toast, sheet, ago } from './dom.js';
import { rankBetween, compareRanked } from './rank.js';
import { streak, dayTotals, currentPage, lessonOfDay, localDate } from './derive.js';
import { validateBackup } from './validate.js';
import { searchBooks } from './openlibrary.js';
import { openDrawing } from './draw.js';
import { isConfigured } from './drive.js';

const VERSION = '1.0.0';
const TABS = [
  { id: 'now', label: 'Now', icon: '📖' },
  { id: 'journal', label: 'Journal', icon: '✏️' },
  { id: 'trophies', label: 'Trophies', icon: '🏆' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];
const BLOCK_TYPES = {
  text: { label: 'Note', icon: '📝', hint: 'What did you think about this part?' },
  quote: { label: 'Quote', icon: '💬', hint: 'Copy a line from the book' },
  lesson: { label: 'Lesson', icon: '💡', hint: 'One sentence you want to remember' },
  drawing: { label: 'Drawing', icon: '🎨' },
};

const ui = { tab: 'now', bookId: null };
let data = { books: [], blocks: [], sessions: [] };
const blobUrls = new Map();

const main = () => document.getElementById('main');
const byNewest = (a, b) => (b.rev?.t || 0) - (a.rev?.t || 0);
const bookTitle = (id) => data.books.find((b) => b.id === id)?.title || '';

// Whole number in [0, max]; anything else (blank, "1e309", negative) becomes 0 or max.
function whole(v, max) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : 0;
}

function getGoal() {
  try { return Math.max(1, Number(localStorage.getItem('rd-goal')) || 10); } catch { return 10; }
}

async function load() {
  const [books, blocks, sessions] = await Promise.all([store.list('books'), store.list('blocks'), store.list('sessions')]);
  data = { books, blocks, sessions };
}

async function render() {
  await load();
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls.clear();
  const el = clear(main());
  el.append(SCREENS[ui.tab]());
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
  window.scrollTo(0, 0);
}

function go(tab, bookId) {
  ui.tab = tab;
  if (bookId) ui.bookId = bookId;
  try { localStorage.setItem('rd-tab', tab); } catch { /* storage may be blocked */ }
  render();
}

function cover(book, cls = 'cover') {
  const fallback = () => h('div', { class: `${cls} cover-blank` }, (book.title || '?').slice(0, 1).toUpperCase());
  if (!book.coverUrl) return fallback();
  const img = h('img', { class: cls, src: book.coverUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

function stars(n, onPick) {
  return h('div', { class: 'stars', role: onPick ? 'radiogroup' : null, 'aria-label': `${n || 0} of 5 stars` },
    [1, 2, 3, 4, 5].map((i) => onPick
      ? h('button', { class: `star${i <= n ? ' on' : ''}`, 'aria-label': `${i} stars`, onclick: () => onPick(i) }, '★')
      : h('span', { class: `star${i <= n ? ' on' : ''}` }, '★')));
}

// ---------- Now ----------

function nowScreen() {
  const reading = data.books.filter((b) => b.status === 'reading').sort(byNewest);
  const today = localDate();
  const goal = getGoal();
  const t = dayTotals(data.sessions, today);
  const st = streak(data.sessions, today);
  const lesson = lessonOfDay(data.blocks, today);

  if (!data.books.length) {
    return h('div', { class: 'stack' },
      h('div', { class: 'card hero' },
        h('h1', null, 'Your reading diary'),
        h('p', null, 'Keep what you learn from every book, keep your streak going, and build a trophy road of everything you have read.'),
        h('button', { class: 'btn primary', onclick: seed }, 'Add Make Your Bed + Rich Dad Poor Dad'),
        h('button', { class: 'btn ghost', onclick: addBookSheet }, 'Add a different book')));
  }

  const book = reading[0];
  return h('div', { class: 'stack' },
    h('div', { class: 'card streak' },
      h('div', { class: 'flame', 'aria-hidden': 'true' }, st ? '🔥' : '🌱'),
      h('div', null,
        h('div', { class: 'big' }, st === 1 ? '1 day' : `${st} days`),
        h('div', { class: 'muted' }, t.pages >= goal ? `Goal done today - ${t.pages} pages` : `${t.pages} / ${goal} pages today`)),
      h('div', { class: 'ring', style: `--p:${Math.min(1, t.pages / goal)}` })),
    book ? currentBookCard(book) : h('div', { class: 'card' },
      h('p', null, 'Not reading anything right now.'),
      h('button', { class: 'btn primary', onclick: addBookSheet }, 'Start a book')),
    lesson && h('div', { class: 'card lesson-day' },
      h('div', { class: 'eyebrow' }, '💡 Lesson of the day'),
      h('p', { class: 'lesson-text' }, lesson.text),
      h('div', { class: 'muted' }, `from ${bookTitle(lesson.bookId)}`)),
    reading.length > 1 && h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, 'Also reading'),
      reading.slice(1).map((b) => h('button', { class: 'row-btn', onclick: () => go('journal', b.id) }, cover(b, 'cover-xs'), h('span', null, b.title)))),
    h('button', { class: 'btn ghost wide', onclick: addBookSheet }, '+ Add a book'));
}

function currentBookCard(book) {
  const page = currentPage(book.id, data.sessions);
  const pct = book.totalPages ? Math.min(100, Math.round((page / book.totalPages) * 100)) : null;
  return h('div', { class: 'card current' },
    h('div', { class: 'current-top' },
      cover(book),
      h('div', null,
        h('div', { class: 'eyebrow' }, 'Reading now'),
        h('h2', null, book.title),
        book.author && h('div', { class: 'muted' }, book.author),
        h('div', { class: 'muted small' }, book.totalPages ? `Page ${page} of ${book.totalPages}` : `Page ${page}`))),
    pct !== null && h('div', { class: 'bar' }, h('span', { style: `width:${pct}%` })),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => logSheet(book) }, 'I read today'),
      h('button', { class: 'btn', onclick: () => go('journal', book.id) }, 'Journal'),
      h('button', { class: 'btn', onclick: () => finishSheet(book) }, 'Finished 🏆')));
}

function logSheet(book) {
  const page = currentPage(book.id, data.sessions);
  const toPage = h('input', { type: 'number', inputmode: 'numeric', min: '0', value: String(page || ''), placeholder: 'Page number' });
  const minutes = h('input', { type: 'number', inputmode: 'numeric', min: '0', placeholder: 'Optional' });
  const close = sheet(`Log reading - ${book.title}`, h('div', { class: 'form' },
    h('label', null, 'I\'m now on page', toPage),
    h('label', null, 'Minutes read', minutes),
    h('button', { class: 'btn primary', onclick: async () => {
      const to = whole(toPage.value, 100000);
      const mins = whole(minutes.value, 1440);
      const pages = Math.max(0, to - page);
      if (!pages && !mins) return toast('Add a page number or minutes');
      await store.save('sessions', { bookId: book.id, date: localDate(), pages, minutes: mins, toPage: Math.max(to, page) });
      close();
      toast(pages ? `+${pages} pages. Nice.` : `${mins} minutes. Nice.`);
    } }, 'Save')));
}

function finishSheet(book) {
  let rating = book.rating || 0;
  const starBox = h('div');
  const drawStars = () => starBox.replaceChildren(stars(rating, (n) => { rating = n; drawStars(); }));
  drawStars();
  const comment = h('textarea', { rows: '4', maxlength: '20000', placeholder: 'What did you think? Would you recommend it?' });
  comment.value = book.comment || '';
  const close = sheet(`Finished ${book.title}!`, h('div', { class: 'form' },
    h('p', null, 'It goes on your trophy road. How was it?'),
    starBox,
    h('label', null, 'Your comment', comment),
    h('button', { class: 'btn primary', onclick: async () => {
      if (!rating) return toast('Tap the stars to rate it');
      await store.save('books', { id: book.id, status: 'finished', finishedAt: book.finishedAt || localDate(), rating, comment: comment.value.trim() });
      close();
      celebrate();
      go('trophies');
    } }, 'Add to trophy road')));
}

function celebrate() {
  const c = h('div', { class: 'confetti', 'aria-hidden': 'true' },
    Array.from({ length: 24 }, (_, i) => h('i', { style: `--x:${(i * 37) % 100}vw;--d:${(i % 6) * 0.08}s;--h:${(i * 47) % 360}` })));
  document.body.append(c);
  setTimeout(() => c.remove(), 1800);
  toast('🏆 New trophy!');
}

// ---------- Add book ----------

function addBookSheet() {
  const q = h('input', { type: 'search', placeholder: 'Search by title or author', autocomplete: 'off' });
  const results = h('div', { class: 'results' });
  const manualTitle = h('input', { placeholder: 'Title', maxlength: '500' });
  const manualAuthor = h('input', { placeholder: 'Author (optional)', maxlength: '500' });
  const manualPages = h('input', { type: 'number', inputmode: 'numeric', min: '0', placeholder: 'Pages (optional)' });
  const status = h('select', null,
    h('option', { value: 'reading' }, 'Reading it now'),
    h('option', { value: 'finished' }, 'Already finished'),
    h('option', { value: 'want' }, 'Want to read'));
  let timer;

  const add = async (b) => {
    const rec = await store.save('books', { ...b, status: status.value, startedAt: localDate(), finishedAt: status.value === 'finished' ? localDate() : null, rating: 0, comment: '' });
    close();
    if (status.value === 'finished') finishSheet(rec);
    else toast(`Added ${rec.title}`);
  };

  q.addEventListener('input', () => {
    clearTimeout(timer);
    const term = q.value.trim();
    if (term.length < 2) return results.replaceChildren();
    timer = setTimeout(async () => {
      results.replaceChildren(h('p', { class: 'muted' }, 'Searching…'));
      try {
        const found = await searchBooks(term);
        results.replaceChildren(...(found.length ? found.map((b) => h('button', { class: 'result', onclick: () => add(b) },
          cover(b, 'cover-xs'), h('span', null, h('strong', null, b.title), b.author && h('span', { class: 'muted' }, ` - ${b.author}`)))) : [h('p', { class: 'muted' }, 'Nothing found - add it by hand below.')]));
      } catch (e) {
        if (e.name !== 'AbortError' || q.value.trim() === term) results.replaceChildren(h('p', { class: 'muted' }, 'Search is not working right now (offline?). Add it by hand below.'));
      }
    }, 300);
  });

  const close = sheet('Add a book', h('div', { class: 'form' },
    h('label', null, 'Status', status),
    q, results,
    h('details', { class: 'manual' },
      h('summary', null, 'Add by hand'),
      manualTitle, manualAuthor, manualPages,
      h('button', { class: 'btn primary', onclick: () => {
        const title = manualTitle.value.trim();
        if (!title) return toast('Give it a title');
        add({ title, author: manualAuthor.value.trim(), totalPages: whole(manualPages.value, 100000), coverUrl: '', olKey: '' });
      } }, 'Add book'))));
}

async function seed() {
  const mine = [
    { title: 'Make Your Bed', author: 'William H. McRaven', status: 'finished', totalPages: 144, q: 'make your bed mcraven' },
    { title: 'Rich Dad Poor Dad', author: 'Robert T. Kiyosaki', status: 'reading', totalPages: 336, q: 'rich dad poor dad kiyosaki' },
  ];
  for (const b of mine) {
    const { q, ...rec } = b;
    const saved = await store.save('books', { ...rec, coverUrl: '', olKey: '', startedAt: localDate(), finishedAt: rec.status === 'finished' ? localDate() : null, rating: 0, comment: '' });
    searchBooks(q, { replace: false }).then((r) => r[0]?.coverUrl && store.save('books', { id: saved.id, coverUrl: r[0].coverUrl, olKey: r[0].olKey })).catch(() => {});
  }
  const first = (await store.list('books')).find((b) => b.status === 'finished');
  if (first) finishSheet(first);
}

// ---------- Journal ----------

function journalScreen() {
  const books = [...data.books].sort(byNewest);
  if (!books.length) return h('div', { class: 'card' }, h('p', null, 'Add a book first.'), h('button', { class: 'btn primary', onclick: addBookSheet }, 'Add a book'));
  if (!books.some((b) => b.id === ui.bookId)) ui.bookId = (books.find((b) => b.status === 'reading') || books[0]).id;
  const book = books.find((b) => b.id === ui.bookId);
  const blocks = data.blocks.filter((b) => b.bookId === book.id).sort(compareRanked);

  return h('div', { class: 'stack' },
    h('div', { class: 'chips', role: 'tablist' }, books.map((b) =>
      h('button', { class: `chip${b.id === book.id ? ' on' : ''}`, role: 'tab', onclick: () => go('journal', b.id) }, b.title))),
    h('div', { class: 'journal-head' }, cover(book, 'cover-sm'), h('div', null, h('h2', null, book.title), h('div', { class: 'muted' }, blocks.length ? `${blocks.length} entries` : 'Empty - add your first thought'))),
    blocks.map((b, i) => blockCard(b, blocks, i)),
    h('div', { class: 'add-bar' }, Object.entries(BLOCK_TYPES).map(([type, t]) =>
      h('button', { class: 'btn', onclick: () => addBlock(book, type, blocks) }, `${t.icon} ${t.label}`))));
}

function blockCard(b, blocks, i) {
  const t = BLOCK_TYPES[b.type] || BLOCK_TYPES.text;
  let content;
  if (b.type === 'drawing') {
    content = h('div', { class: 'drawing-box' }, h('p', { class: 'muted' }, 'Loading drawing…'));
    showDrawing(content, b.drawingId);
  } else {
    content = h('p', { class: `block-text ${b.type}` }, b.text || '');
  }
  return h('article', { class: `block ${b.type}` },
    h('div', { class: 'block-label' }, `${t.icon} ${t.label}`),
    content,
    h('div', { class: 'block-tools' },
      h('button', { class: 'icon-btn', 'aria-label': 'Edit', onclick: () => editBlock(b) }, '✏️'),
      h('button', { class: 'icon-btn', 'aria-label': 'Move up', disabled: i === 0, onclick: () => move(blocks, i, -1) }, '↑'),
      h('button', { class: 'icon-btn', 'aria-label': 'Move down', disabled: i === blocks.length - 1, onclick: () => move(blocks, i, 1) }, '↓'),
      h('button', { class: 'icon-btn', 'aria-label': 'Delete', onclick: async () => {
        if (confirm(`Delete this ${t.label.toLowerCase()}?`)) await store.remove('blocks', b.id);
      } }, '🗑')));
}

async function showDrawing(box, drawingId) {
  let blob = null;
  try { blob = await syncer.drawingBlob(drawingId); } catch { /* shown as missing below */ }
  if (!blob) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Drawing not downloaded yet. '),
      h('button', { class: 'btn small', onclick: () => syncer.syncNow({ interactive: true }).then(render) }, 'Retry'));
    return;
  }
  if (!blobUrls.has(drawingId)) blobUrls.set(drawingId, URL.createObjectURL(blob));
  box.replaceChildren(h('img', { class: 'drawing', src: blobUrls.get(drawingId), alt: 'Drawing' }));
}

async function move(blocks, i, dir) {
  const order = blocks.filter((_, k) => k !== i);
  order.splice(i + dir, 0, blocks[i]);
  const at = i + dir;
  const lo = order[at - 1]?.rank || '';
  const hi = order[at + 1]?.rank ?? null;
  if (hi === null || lo < hi) return store.setRank(blocks[i].id, rankBetween(lo, hi));
  // Two devices gave blocks the same rank: re-rank this book in the order he now sees.
  let prev = '';
  for (const b of order) { prev = rankBetween(prev, null); await store.setRank(b.id, prev); }
}

async function addBlock(book, type, blocks) {
  const rank = rankBetween(blocks.at(-1)?.rank || '', null);
  if (type === 'drawing') {
    const blob = await openDrawing();
    if (!blob) return;
    const drawingId = await store.putDrawing(blob);
    await store.save('blocks', { bookId: book.id, type, drawingId, text: '', rank, createdAt: Date.now() });
    return;
  }
  textSheet(BLOCK_TYPES[type], '', (text) => store.save('blocks', { bookId: book.id, type, text, rank, createdAt: Date.now() }));
}

async function editBlock(b) {
  if (b.type === 'drawing') {
    const base = await syncer.drawingBlob(b.drawingId).catch(() => null);
    const blob = await openDrawing(base);
    if (!blob) return;
    const drawingId = await store.putDrawing(blob); // drawings are immutable: a redraw is a new one
    await store.save('blocks', { id: b.id, drawingId });
    return;
  }
  textSheet(BLOCK_TYPES[b.type], b.text, (text) => store.save('blocks', { id: b.id, text }));
}

function textSheet(t, initial, onSave) {
  const ta = h('textarea', { rows: '6', maxlength: '20000', placeholder: t.hint });
  ta.value = initial || '';
  const close = sheet(`${t.icon} ${t.label}`, h('div', { class: 'form' }, ta,
    h('button', { class: 'btn primary', onclick: async () => {
      const text = ta.value.trim();
      if (!text) return toast('Write something first');
      await onSave(text);
      close();
    } }, 'Save')));
}

// ---------- Trophy road ----------

function trophyScreen() {
  const done = data.books.filter((b) => b.status === 'finished').sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || '') || byNewest(a, b));
  const next = data.books.filter((b) => b.status === 'reading').sort(byNewest)[0];
  const rated = done.filter((b) => b.rating);
  const avg = rated.length ? (rated.reduce((n, b) => n + b.rating, 0) / rated.length).toFixed(1) : '-';

  const nodes = [...(next ? [{ book: next, ghost: true }] : []), ...done.map((book) => ({ book }))];
  const STEP = 132, TOP = 70;
  const height = TOP + Math.max(1, nodes.length) * STEP;
  const xs = (i) => (i % 2 ? 72 : 28);
  let d = '';
  nodes.forEach((_, i) => {
    const y = TOP + i * STEP;
    if (i === 0) d = `M ${xs(0)} ${y}`;
    else { const py = TOP + (i - 1) * STEP; d += ` C ${xs(i - 1)} ${py + STEP / 2}, ${xs(i)} ${y - STEP / 2}, ${xs(i)} ${y}`; }
  });

  return h('div', { class: 'stack' },
    h('div', { class: 'card trophy-stats' },
      h('div', null, h('div', { class: 'big' }, String(done.length)), h('div', { class: 'muted' }, done.length === 1 ? 'book read' : 'books read')),
      h('div', null, h('div', { class: 'big' }, `${avg}★`), h('div', { class: 'muted' }, 'average rating')),
      h('div', null, h('div', { class: 'big' }, String(data.blocks.filter((b) => b.type === 'lesson').length)), h('div', { class: 'muted' }, 'lessons kept'))),
    nodes.length ? h('div', { class: 'road', style: `height:${height}px` },
      s('svg', { class: 'road-path', viewBox: `0 0 100 ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        s('path', { d, fill: 'none', 'vector-effect': 'non-scaling-stroke' })),
      nodes.map(({ book, ghost }, i) => h('button', {
        class: `node${ghost ? ' ghost' : ''}`, style: `top:${TOP + i * STEP - 52}px;left:${xs(i)}%`,
        onclick: () => (ghost ? go('journal', book.id) : trophySheet(book)),
      },
      cover(book, 'cover-sm'),
      h('span', { class: 'node-title' }, book.title),
      ghost ? h('span', { class: 'node-sub' }, 'Next up…') : stars(book.rating)))) :
      h('div', { class: 'card' }, h('p', null, 'Finish a book to place your first trophy.')));
}

function trophySheet(book) {
  const lessons = data.blocks.filter((b) => b.bookId === book.id && b.type === 'lesson').sort(compareRanked);
  let rating = book.rating || 0;
  const starBox = h('div');
  const comment = h('textarea', { rows: '4', maxlength: '20000', placeholder: 'Your comment' });
  comment.value = book.comment || '';
  const drawStars = () => starBox.replaceChildren(stars(rating, (n) => { rating = n; drawStars(); }));
  drawStars();
  const close = sheet(book.title, h('div', { class: 'form' },
    h('div', { class: 'trophy-head' }, cover(book), h('div', null,
      book.author && h('div', null, book.author),
      h('div', { class: 'muted small' }, `Finished ${book.finishedAt || ''}`))),
    starBox,
    h('label', null, 'Comment', comment),
    lessons.length > 0 && h('div', null, h('div', { class: 'eyebrow' }, '💡 Lessons'), lessons.map((l) => h('p', { class: 'lesson-text small' }, l.text))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: async () => {
        await store.save('books', { id: book.id, rating, comment: comment.value.trim() });
        close();
        toast('Saved');
      } }, 'Save'),
      h('button', { class: 'btn', onclick: () => { close(); go('journal', book.id); } }, 'Open journal'),
      h('button', { class: 'btn ghost', onclick: async () => {
        if (!confirm(`Remove ${book.title} and its journal?`)) return;
        for (const b of data.blocks.filter((x) => x.bookId === book.id)) await store.remove('blocks', b.id);
        await store.remove('books', book.id);
        close();
      } }, 'Remove'))));
}

// ---------- Settings ----------

function settingsScreen() {
  const box = h('div', { class: 'stack' });
  (async () => {
    const st = await store.status();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    const logEntries = await store.getMeta('syncLog', []);
    const ds = syncer.state;
    const goal = h('input', { type: 'number', inputmode: 'numeric', min: '1', value: String(getGoal()) });
    goal.addEventListener('change', () => { try { localStorage.setItem('rd-goal', String(whole(goal.value, 1000) || 10)); } catch { /* ignore */ } toast('Goal saved'); });
    const fileIn = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden-input', onchange: (e) => restoreFrom(e.target.files[0]) });

    box.append(
      h('div', { class: 'card' },
        h('h2', null, 'Google Drive backup'),
        !isConfigured() ? h('p', null, 'Not set up yet. Everything is saved on this phone; use "Download backup" until Drive is connected.') :
          h('div', null,
            h('p', null, ds.drive === 'connected' ? `Connected as ${ds.email}` : ds.drive === 'needs-confirm' ? `Signed in as ${ds.email}. Back up this diary to that account?` : 'Not connected.'),
            h('p', { class: 'muted small' }, `Last saved to Drive: ${ago(st.lastSyncOk)}${st.pending > 0 ? ` · ${st.pending} changes waiting` : ''}`),
            ds.error && h('p', { class: 'muted small' }, `Last problem: ${ds.error}`),
            h('div', { class: 'actions' },
              ds.drive === 'needs-confirm'
                ? h('button', { class: 'btn primary', onclick: () => syncer.confirmAccount().then(render) }, `Yes, use ${ds.email}`)
                : h('button', { class: 'btn primary', onclick: () => syncer.syncNow({ interactive: true }).then(render) }, ds.drive === 'connected' ? 'Sync now' : 'Connect Google Drive')))),
      h('div', { class: 'card' },
        h('h2', null, 'Backup file'),
        h('p', { class: 'muted small' }, 'A single file with everything, drawings included. Save it to Drive or send it to yourself.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: downloadBackup }, 'Download backup'),
          h('button', { class: 'btn', onclick: () => fileIn.click() }, 'Restore from file'), fileIn),
        h('p', { class: 'muted small' }, 'Restoring only adds what is missing - it never changes or deletes anything you already have.')),
      h('div', { class: 'card' },
        h('h2', null, 'Get book ideas'),
        h('p', { class: 'muted small' }, 'Copies your ratings, comments and lessons as text. Paste it to Claude and ask what to read next.'),
        h('button', { class: 'btn', onclick: exportForClaude }, 'Export for Claude')),
      h('div', { class: 'card' },
        h('h2', null, 'Daily goal'),
        h('label', { class: 'inline' }, 'Pages per day', goal)),
      h('div', { class: 'card' },
        h('h2', null, 'Reminders (like Duolingo)'),
        h('details', null, h('summary', null, 'Remind me when I get home'),
          h('ol', { class: 'steps' },
            h('li', null, 'Install the free app MacroDroid from the Play Store.'),
            h('li', null, 'Add Macro → Trigger: Connectivity → Wi-Fi State Change → Connected to network → pick your home Wi-Fi.'),
            h('li', null, 'Action: Notification → Display Notification. Title "Time to read 📖".'),
            h('li', null, `On notification press: Open Website → ${location.origin}${location.pathname}`),
            h('li', null, 'Constraint (optional): Time of Day, e.g. 15:00-22:00, so it does not fire at midnight.'),
            h('li', null, 'Phone Settings → Apps → MacroDroid → Battery → Unrestricted, or Android may silence it.'))),
        h('details', null, h('summary', null, 'Or remind me at a fixed time'),
          h('p', { class: 'small' }, 'Same as above, but use Trigger: Date/Time → Day/Time Trigger, e.g. every day at 20:30.'))),
      h('div', { class: 'card' },
        h('h2', null, 'Storage'),
        h('p', { class: 'small' }, persisted ? 'Chrome agreed to keep this app\'s data (best effort).' : 'Chrome has not promised to keep this app\'s data. The Drive backup is what really protects it.'),
        h('details', null, h('summary', null, 'Sync log'),
          logEntries.length ? h('ul', { class: 'log' }, logEntries.map((e) => h('li', null, `${new Date(e.time).toLocaleString()} · ${e.op} · ${e.ok ? 'ok' : 'failed'}${e.code ? ` · ${e.code}` : ''}`))) : h('p', { class: 'muted small' }, 'Nothing yet.'),
          h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(JSON.stringify(logEntries, null, 1)).then(() => toast('Copied')) }, 'Copy log'))),
      h('p', { class: 'muted small center' }, `Reading Diary ${VERSION}`));
  })();
  return box;
}

async function downloadBackup() {
  const snap = await store.snapshot();
  const used = new Set(snap.blocks.filter((b) => !b.deleted && b.drawingId).map((b) => b.drawingId));
  const drawings = [];
  for (const id of used) {
    const d = await store.getDrawing(id);
    if (!d) continue;
    const bytes = new Uint8Array(await d.blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    drawings.push({ id, webp: btoa(bin) });
  }
  const json = JSON.stringify({ app: 'reading-diary', schemaVersion: 1, exportedAt: new Date().toISOString(), ...snap, drawings });
  const a = h('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: `reading-diary-${localDate()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast('Backup downloaded');
}

async function restoreFrom(file) {
  if (!file) return;
  if (file.size > 200 * 1024 * 1024) return toast('That file is too big to be a backup');
  let parsed;
  try { parsed = JSON.parse(await file.text()); } catch { return toast('That is not a backup file'); }
  const maxT = Math.max(Date.now(), await store.getMeta('highestT', 0));
  const { data: clean, errors, fatal } = validateBackup(parsed, { maxT });
  if (fatal) return toast(errors[0]);
  if (!clean.books.length && !clean.blocks.length && !clean.sessions.length) return toast(errors[0] || 'Nothing to restore');
  const added = await store.restore(clean);
  toast(`Added ${added.books} books, ${added.blocks} entries${errors.length ? ` (${errors.length} skipped)` : ''}`);
  render();
}

async function exportForClaude() {
  const lines = ['My reading so far (from my Reading Diary):', ''];
  const books = [...data.books].sort((a, b) => (a.finishedAt || '9').localeCompare(b.finishedAt || '9'));
  for (const b of books) {
    lines.push(`## ${b.title}${b.author ? ` - ${b.author}` : ''}`);
    lines.push(`Status: ${b.status}${b.rating ? ` · My rating: ${b.rating}/5` : ''}`);
    if (b.comment) lines.push(`My comment: ${b.comment}`);
    for (const l of data.blocks.filter((x) => x.bookId === b.id && x.type === 'lesson').sort(compareRanked)) lines.push(`- Lesson: ${l.text}`);
    lines.push('');
  }
  lines.push('Based on what I liked and what I learned, what should I read next? Give me 5 options and say why each fits me.');
  const text = lines.join('\n');
  try {
    if (navigator.share) await navigator.share({ title: 'My reading', text });
    else { await navigator.clipboard.writeText(text); toast('Copied - paste it to Claude'); }
  } catch { /* share sheet dismissed */ }
}

// ---------- Shell ----------

const SCREENS = { now: nowScreen, journal: journalScreen, trophies: trophyScreen, settings: settingsScreen };

async function renderPill() {
  const pill = document.getElementById('pill');
  const st = await store.status();
  const ds = syncer.state;
  let cls = 'grey', text = 'Saved on this phone · Drive not set up';
  if (isConfigured()) {
    if (ds.drive === 'needs-confirm') { cls = 'amber'; text = `Back up to ${ds.email}? Tap to confirm`; }
    else if (ds.drive === 'disconnected') { cls = 'red'; text = 'Drive disconnected - tap to reconnect'; }
    else if (ds.drive !== 'connected') {
      // Signed out just means no fresh Google token yet; the truth is what's waiting.
      if (st.pending > 0) { cls = 'amber'; text = `${st.pending} change${st.pending === 1 ? '' : 's'} not backed up · tap to save`; }
      else if (st.lastSyncOk) { cls = 'green'; text = `Saved to Drive · ${ago(st.lastSyncOk)}`; }
      else { cls = 'amber'; text = 'Tap to connect Google Drive'; }
    }
    else if (ds.syncing) { cls = 'amber'; text = 'Saving to Drive…'; }
    else if (st.pending > 0) { cls = 'amber'; text = `Not backed up yet · ${st.pending} change${st.pending === 1 ? '' : 's'}`; }
    else { cls = 'green'; text = `Saved to Drive · ${ago(st.lastSyncOk)}`; }
  }
  pill.className = `pill ${cls}`;
  pill.textContent = text;
}

function setupShell() {
  const nav = document.querySelector('.tabbar');
  nav.replaceChildren(...TABS.map((t) => h('button', { 'data-tab': t.id, onclick: () => go(t.id) }, h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, t.icon), h('span', null, t.label))));
  document.getElementById('pill').addEventListener('click', () => {
    const d = syncer.state.drive;
    if (d === 'disconnected' || d === 'signed-out') syncer.syncNow({ interactive: true });
    else go('settings');
  });
  setInterval(renderPill, 30000);
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let updating = false;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => {
      const bar = document.getElementById('update');
      bar.hidden = false;
      bar.onclick = () => { updating = true; w.postMessage('skipWaiting'); };
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
  }).catch(() => {});
  // Reload only for an update he accepted - not when the first install claims the page.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) { updating = false; location.reload(); } });
}

async function boot() {
  try {
    await store.open();
  } catch (e) {
    clear(main()).append(h('div', { class: 'card' }, h('h2', null, 'Could not open your diary'), h('p', null, e.message)));
    return;
  }
  navigator.storage?.persist?.().catch(() => {});
  try { const t = localStorage.getItem('rd-tab'); if (SCREENS[t]) ui.tab = t; } catch { /* ignore */ }
  setupShell();
  store.onChange(() => { render(); renderPill(); });
  syncer.onStatus(() => renderPill());
  syncer.start();
  setupServiceWorker();
  await render();
  renderPill();
}

boot();
