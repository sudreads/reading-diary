import * as store from './store.js';
import * as syncer from './syncer.js';
import { h, s, clear, toast, sheet, ago } from './dom.js';
import { streak, readingDates, lessonOfDay, localDate, addDays } from './derive.js';
import { validateBackup } from './validate.js';
import { searchBooks } from './openlibrary.js';
import { notebookView, commentsView, pagesOf, flushNotebook, resetNotebook, isLessonBlock } from './notebook.js';
import { isConfigured } from './drive.js';
import { isConfigured as fbConfigured } from './firebase.js';
import { workIdOf } from './social.js';
import { reviewsSheet, handleSheet, adminPanel } from './reviews.js';

const VERSION = '1.2.0';
const TABS = [
  { id: 'now', label: 'Now', icon: '📖' },
  { id: 'journal', label: 'Notebook', icon: '📓' },
  { id: 'trophies', label: 'Trophies', icon: '🏆' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

const ui = { tab: 'now', bookId: null, section: 'notebook', page: {} };
let data = { books: [], blocks: [], sessions: [] };

const main = () => document.getElementById('main');
const byNewest = (a, b) => (b.rev?.t || 0) - (a.rev?.t || 0);
const bookTitle = (id) => data.books.find((b) => b.id === id)?.title || '';
const currentBook = () => data.books.filter((b) => b.status === 'reading').sort(byNewest)[0] || null;

// Notebook typing and drawing write through quiet(), so they don't redraw the page under his
// finger; sync merges that land while he is writing wait until he stops.
let quietDepth = 0, pendingRender = false;
const busy = { current: () => false };
async function quiet(fn) {
  quietDepth++;
  try { return await fn(); } finally { quietDepth--; }
}
function maybeRender() {
  if (!pendingRender || busy.current()) return;
  pendingRender = false;
  render();
}

async function load() {
  const [books, blocks, sessions] = await Promise.all([store.list('books'), store.list('blocks'), store.list('sessions')]);
  data = { books, blocks, sessions };
}

async function render() {
  await load();
  busy.current = () => false;
  resetNotebook();
  const el = clear(main());
  el.append(SCREENS[ui.tab]());
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
}

async function go(tab, bookId) {
  await flushNotebook();
  ui.tab = tab;
  if (bookId) ui.bookId = bookId;
  try { localStorage.setItem('rd-tab', tab); } catch { /* storage may be blocked */ }
  await render();
  window.scrollTo(0, 0);
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

function notYetToday() {
  try { return localStorage.getItem('rd-notyet') === localDate(); } catch { return false; }
}

function nowScreen() {
  const today = localDate();
  const st = streak(data.sessions, today);
  const dates = readingDates(data.sessions);
  const readToday = dates.has(today);
  const book = currentBook();
  const lesson = lessonOfDay(data.blocks, today);

  if (!data.books.length) {
    return h('div', { class: 'stack' },
      h('div', { class: 'card hero' },
        h('h1', null, 'Your reading diary'),
        h('p', null, 'One book at a time. Keep a notebook for it, keep your streak going, and build a trophy road of everything you finish.'),
        h('button', { class: 'btn primary', onclick: addBookSheet }, 'Add your first book')));
  }

  const week = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const streakCard = h('div', { class: 'card streak-card' },
    h('div', { class: 'flame-big', 'aria-hidden': 'true' }, st ? '🔥' : '🌱'),
    h('div', { class: 'big' }, st === 1 ? '1 day streak' : `${st} day streak`),
    h('div', { class: 'week', 'aria-label': 'Last 7 days' }, week.map((d) => h('div', { class: `day${dates.has(d) ? ' on' : ''}${d === today ? ' today' : ''}` },
      h('span', { class: 'dot' }), h('span', { class: 'muted tiny' }, new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'narrow' }))))));

  return h('div', { class: 'stack' },
    streakCard,
    book ? currentBookCard(book, readToday) : nextBookCard(),
    book && h('button', { class: 'btn ghost wide', onclick: addBookSheet }, '+ Save a book for later'),
    lesson && h('div', { class: 'card lesson-day' },
      h('div', { class: 'eyebrow' }, '💡 Lesson of the day'),
      h('p', { class: 'lesson-text' }, lesson.text),
      h('div', { class: 'muted' }, `from ${bookTitle(lesson.bookId)}`)));
}

function currentBookCard(book, readToday) {
  let question;
  if (readToday) {
    const today = localDate();
    const undoable = data.sessions.some((s) => s.bookId === book.id && s.date === today && s.read === true);
    question = h('div', { class: 'checkin done' },
      h('p', null, '✓ You read today. See you tomorrow!'),
      undoable && h('button', { class: 'link-btn', onclick: () => undoToday(book) }, 'Undo'));
  } else if (notYetToday()) {
    question = h('div', { class: 'checkin' },
      h('p', { class: 'muted' }, 'No problem - tap when you\'ve read.'),
      h('button', { class: 'btn primary wide', onclick: (e) => readTodayClick(e, book) }, 'I read today'));
  } else {
    question = h('div', { class: 'checkin' },
      h('p', { class: 'question' }, 'Did you read today?'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: (e) => readTodayClick(e, book) }, 'I read today'),
        h('button', { class: 'btn', onclick: () => { try { localStorage.setItem('rd-notyet', localDate()); } catch { /* ignore */ } render(); } }, 'Not yet')));
  }
  return h('div', { class: 'card current' },
    h('div', { class: 'current-top' },
      cover(book),
      h('div', null,
        h('div', { class: 'eyebrow' }, 'Reading now'),
        h('h2', null, book.title),
        book.author && h('div', { class: 'muted' }, book.author))),
    question,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => { ui.section = 'notebook'; go('journal', book.id); } }, '📓 Notebook'),
      fbConfigured() && workIdOf(book.olKey) && h('button', { class: 'btn', onclick: () => openReviews(book) }, '★ Reviews'),
      h('button', { class: 'btn', onclick: () => finishSheet(book) }, 'Finished 🏆')));
}

async function readTodayClick(e, book) {
  e.currentTarget.disabled = true;
  const today = localDate();
  if (readingDates(await store.list('sessions')).has(today)) return render(); // another tab got there first
  await store.save('sessions', { bookId: book.id, date: today, read: true, pages: 0, minutes: 0 });
  const st = streak(await store.list('sessions'), today);
  toast(st > 1 ? `🔥 ${st} days in a row!` : '🔥 Streak started!');
}

async function undoToday(book) {
  const today = localDate();
  for (const s of data.sessions) if (s.bookId === book.id && s.date === today && s.read === true) await store.remove('sessions', s.id);
}

function nextBookCard() {
  const want = data.books.filter((b) => b.status === 'want').sort(byNewest);
  return h('div', { class: 'card' },
    h('h2', null, 'What are you reading next?'),
    want.length > 0 && h('div', { class: 'want-list' }, want.map((b) => h('div', { class: 'row' },
      cover(b, 'cover-xs'), h('span', { class: 'grow' }, b.title),
      h('button', { class: 'btn small primary', onclick: () => startReading(b) }, 'Start reading')))),
    h('button', { class: 'btn wide', onclick: addBookSheet }, '+ Add a book'));
}

async function startReading(book) {
  if (currentBook()) return toast(`Finish ${currentBook().title} first`);
  await store.save('books', { id: book.id, status: 'reading', startedAt: localDate() });
  toast(`Started ${book.title}`);
}

function finishSheet(book) {
  let rating = book.rating || 0;
  const starBox = h('div');
  const drawStars = () => starBox.replaceChildren(stars(rating, (n) => { rating = n; drawStars(); }));
  drawStars();
  const comment = h('textarea', { rows: '4', maxlength: '2000', placeholder: 'What did you think? Would you recommend it?' });
  comment.value = book.comment || '';
  const share = publicSwitch(book, book.publicReview !== false); // on by default for new finishes
  const close = sheet(`Finished ${book.title}!`, h('div', { class: 'form' },
    h('p', null, 'It goes on your trophy road. How was it?'),
    starBox,
    h('label', null, 'Your review', comment),
    share.el,
    h('button', { class: 'btn primary', onclick: async () => {
      if (!rating) return toast('Tap the stars to rate it');
      await store.save('books', { id: book.id, status: 'finished', finishedAt: book.finishedAt || localDate(), rating, comment: comment.value.trim(), publicReview: share.value() });
      await store.outboxBump(book.id);
      close();
      celebrate();
      go('now'); // straight to picking the next book
    } }, 'Add to trophy road')));
}

// "Post publicly" switch. Hidden (and false) when reviews are off or the book can't be matched.
function publicSwitch(book, initial) {
  if (!fbConfigured() || !workIdOf(book.olKey)) {
    const why = fbConfigured() ? h('p', { class: 'muted small' }, 'Private only - add the book from search to share reviews.') : null;
    return { el: why, value: () => book.publicReview === true };
  }
  const box = h('input', { type: 'checkbox', checked: initial });
  const who = syncer.state.handle ? `@${syncer.state.handle}` : 'your reader name';
  return {
    el: h('label', { class: 'switch-row' }, box,
      h('span', null, h('strong', null, 'Post publicly'), h('span', { class: 'muted small block' }, `Everyone in the beta will see your stars and review as ${who}.`))),
    value: () => box.checked,
  };
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
  const reading = currentBook();
  const q = h('input', { type: 'search', placeholder: 'Search by title or author', autocomplete: 'off' });
  const results = h('div', { class: 'results' });
  const manualTitle = h('input', { placeholder: 'Title', maxlength: '500' });
  const manualAuthor = h('input', { placeholder: 'Author (optional)', maxlength: '500' });
  const options = reading
    ? [['want', 'Want to read'], ['finished', 'Already finished']]
    : [['reading', 'Start reading it now'], ['want', 'Want to read'], ['finished', 'Already finished']];
  const status = h('select', null, options.map(([v, label]) => h('option', { value: v }, label)));
  let timer;

  const add = async (b) => {
    if (status.value === 'reading' && currentBook()) return toast(`Finish ${currentBook().title} first`);
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
        results.replaceChildren(...(found.length ? found.map((b) => h('div', { class: 'result-row' },
          h('button', { class: 'result', onclick: () => add(b) },
            cover(b, 'cover-xs'), h('span', null, h('strong', null, b.title), b.author && h('span', { class: 'muted' }, ` - ${b.author}`))),
          fbConfigured() && workIdOf(b.olKey) && h('button', { class: 'btn small', 'aria-label': `Reviews of ${b.title}`, onclick: () => reviewsSheet(b) }, '★'))) : [h('p', { class: 'muted' }, 'Nothing found - add it by hand below.')]));
      } catch (e) {
        if (e.name !== 'AbortError' || q.value.trim() === term) results.replaceChildren(h('p', { class: 'muted' }, 'Search is not working right now (offline?). Add it by hand below.'));
      }
    }, 300);
  });

  const close = sheet('Add a book', h('div', { class: 'form' },
    reading && h('p', { class: 'note' }, `You're reading ${reading.title}. Finish it first to start another - you can still save books for later.`),
    h('label', null, 'Status', status),
    q, results,
    h('details', { class: 'manual' },
      h('summary', null, 'Add by hand'),
      manualTitle, manualAuthor,
      h('button', { class: 'btn primary', onclick: () => {
        const title = manualTitle.value.trim();
        if (!title) return toast('Give it a title');
        add({ title, author: manualAuthor.value.trim(), totalPages: 0, coverUrl: '', olKey: '' });
      } }, 'Add book'))));
}

// ---------- Notebook + comments ----------

function journalScreen() {
  const books = data.books.filter((b) => b.status !== 'want').sort((a, b) => (a.status === 'reading' ? -1 : b.status === 'reading' ? 1 : byNewest(a, b)));
  if (!books.length) return h('div', { class: 'card' }, h('p', null, 'Start a book to open its notebook.'), h('button', { class: 'btn primary', onclick: addBookSheet }, 'Add a book'));
  if (!books.some((b) => b.id === ui.bookId)) ui.bookId = books[0].id;
  const book = books.find((b) => b.id === ui.bookId);
  const pages = pagesOf(data.blocks, book.id);
  const section = (id, label) => h('button', { class: `seg${ui.section === id ? ' on' : ''}`, onclick: async () => { await flushNotebook(); ui.section = id; render(); } }, label);

  return h('div', { class: 'stack' },
    books.length > 1 && h('div', { class: 'chips', role: 'tablist' }, books.map((b) =>
      h('button', { class: `chip${b.id === book.id ? ' on' : ''}`, role: 'tab', onclick: () => go('journal', b.id) }, b.title))),
    h('div', { class: 'journal-head' }, cover(book, 'cover-sm'), h('div', null, h('h2', null, book.title), book.author && h('div', { class: 'muted' }, book.author))),
    h('div', { class: 'segmented' }, section('notebook', '📓 Notebook'), section('comments', '💬 Comments')),
    ui.section === 'comments'
      ? commentsView({ book, blocks: data.blocks })
      : notebookView({
        book, pages, pageIndex: ui.page[book.id] ?? Math.max(0, pages.length - 1),
        setPage: (i) => { ui.page[book.id] = i; render(); }, quiet, isBusy: busy,
      }));
}

// ---------- Trophy road ----------

function trophyScreen() {
  const done = data.books.filter((b) => b.status === 'finished').sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || '') || byNewest(a, b));
  const next = currentBook();
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
      h('div', null, h('div', { class: 'big' }, String(data.blocks.filter(isLessonBlock).length)), h('div', { class: 'muted' }, 'lessons kept'))),
    nodes.length ? h('div', { class: 'road', style: `height:${height}px` },
      s('svg', { class: 'road-path', viewBox: `0 0 100 ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        s('path', { d, fill: 'none', 'vector-effect': 'non-scaling-stroke' })),
      nodes.map(({ book, ghost }, i) => h('button', {
        class: `node${ghost ? ' ghost' : ''}`, style: `top:${TOP + i * STEP - 52}px;left:${xs(i)}%`,
        onclick: () => (ghost ? go('journal', book.id) : trophySheet(book)),
      },
      cover(book, 'cover-sm'),
      h('span', { class: 'node-title' }, book.title),
      ghost ? h('span', { class: 'node-sub' }, 'Reading now…') : stars(book.rating)))) :
      h('div', { class: 'card' }, h('p', null, 'Finish a book to place your first trophy.')));
}

function trophySheet(book) {
  const lessons = data.blocks.filter((b) => b.bookId === book.id && isLessonBlock(b)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  let rating = book.rating || 0;
  const starBox = h('div');
  const comment = h('textarea', { rows: '4', maxlength: '2000', placeholder: 'Your review' });
  comment.value = book.comment || '';
  const drawStars = () => starBox.replaceChildren(stars(rating, (n) => { rating = n; drawStars(); }));
  drawStars();
  const share = publicSwitch(book, book.publicReview === true); // books finished before 1.2 stay private
  const close = sheet(book.title, h('div', { class: 'form' },
    h('div', { class: 'trophy-head' }, cover(book), h('div', null,
      book.author && h('div', null, book.author),
      h('div', { class: 'muted small' }, `Finished ${book.finishedAt || ''}`))),
    starBox,
    h('label', null, 'Review', comment),
    share.el,
    lessons.length > 0 && h('div', null, h('div', { class: 'eyebrow' }, '💡 Lessons'), lessons.map((l) => h('p', { class: 'lesson-text small' }, l.text))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: async () => {
        await store.save('books', { id: book.id, rating, comment: comment.value.trim(), publicReview: share.value() });
        await store.outboxBump(book.id);
        close();
        toast('Saved');
      } }, 'Save'),
      fbConfigured() && h('button', { class: 'btn', onclick: () => { close(); openReviews(book); } }, '★ Reviews'),
      h('button', { class: 'btn', onclick: () => { close(); ui.section = 'notebook'; go('journal', book.id); } }, 'Open notebook'),
      h('button', { class: 'btn ghost', onclick: async () => {
        if (!confirm(`Remove ${book.title}, its notebook, comments and public review?`)) return;
        for (const b of data.blocks.filter((x) => x.bookId === book.id)) await store.remove('blocks', b.id);
        await store.remove('books', book.id);
        await store.outboxBump(book.id); // the outbox sees the tombstone and deletes the public review
        close();
      } }, 'Remove'))));
}

// Reviews for a book in the diary; deleting your own public review there also flips the switch off.
function openReviews(book) {
  reviewsSheet({ ...book, onUnpublish: async () => {
    await store.save('books', { id: book.id, publicReview: false });
    await store.outboxBump(book.id); // supersedes any upsert still queued for this book
  } });
}

// ---------- Settings ----------

function settingsScreen() {
  const box = h('div', { class: 'stack' });
  (async () => {
    const st = await store.status();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    const logEntries = await store.getMeta('syncLog', []);
    const ds = syncer.state;
    const fileIn = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden-input', onchange: (e) => restoreFrom(e.target.files[0]) });

    box.append(
      fbConfigured() && accountCard(ds, await store.getMeta('deleteJob', false)),
      fbConfigured() && ds.admin && adminPanel(),
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

function accountCard(ds, deleteUnfinished) {
  const privacy = h('a', { href: 'privacy.html', target: '_blank', rel: 'noopener', class: 'muted small' }, 'Privacy: what is public and how to delete it');
  let body;
  if (ds.account === 'ready') {
    body = [
      deleteUnfinished && h('p', { class: 'note' }, 'Deleting your public data didn\'t finish. Tap the button below to finish it.'),
      h('p', null, 'Your reader name: ', h('strong', null, `@${ds.handle}`)),
      h('p', { class: 'muted small' }, 'Public: your stars and review on books you finish with "Post publicly" on. Everything else in this diary stays private.'),
      h('button', { class: 'btn ghost', onclick: async () => {
        if (!confirm('Delete all your public reviews and your reviews account? Your private diary stays. Your reader name stays reserved and can\'t be reused.')) return;
        try { await syncer.deleteMyPublicData(); toast('Your public data is deleted'); render(); } catch (e) { toast(`Couldn't finish (${e.code || e.message}) - try again`); }
      } }, 'Delete my public data'),
    ];
  } else if (ds.account === 'needs-handle') {
    body = [h('p', null, 'Pick your reader name to share reviews.'), h('button', { class: 'btn primary', onclick: () => handleSheet(render) }, 'Pick a name')];
  } else if (ds.account === 'wrong-account') {
    body = [h('p', null, 'This diary belongs to a different Google account. Sign in with that one to back up and share reviews.')];
  } else {
    body = [h('p', null, 'Sign in with Google to back up your diary and share reviews with other readers.'),
      h('button', { class: 'btn primary', onclick: () => syncer.syncNow({ interactive: true }).then(render) }, 'Sign in with Google')];
  }
  return h('div', { class: 'card' }, h('h2', null, 'Reader account'), body, privacy);
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
    const notes = data.blocks.filter((x) => x.bookId === b.id && ['comment', 'text', 'quote', 'lesson'].includes(x.type))
      .sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
    for (const n of notes) lines.push(`- ${isLessonBlock(n) ? 'Lesson' : 'Comment'}: ${n.text}`);
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
    if (ds.drive === 'wrong-account' || ds.account === 'wrong-account') { cls = 'red'; text = 'Different Google account - tap for details'; }
    else if (ds.drive === 'needs-confirm') { cls = 'amber'; text = `Back up to ${ds.email}? Tap to confirm`; }
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
  // GitHub Pages can't send X-Frame-Options, and CSP frame-ancestors doesn't work in a <meta>,
  // so refuse to run inside someone else's frame (clickjacking).
  if (window.top !== window.self) {
    clear(main()).append(h('div', { class: 'card' }, h('p', null, 'Open Reading Diary directly: '), h('a', { href: location.href, target: '_top' }, location.href)));
    return;
  }
  try {
    await store.open();
  } catch (e) {
    clear(main()).append(h('div', { class: 'card' }, h('h2', null, 'Could not open your diary'), h('p', null, e.message)));
    return;
  }
  navigator.storage?.persist?.().catch(() => {});
  try { const t = localStorage.getItem('rd-tab'); if (SCREENS[t]) ui.tab = t; } catch { /* ignore */ }
  setupShell();
  store.onChange(() => {
    renderPill();
    if (quietDepth > 0) return; // his own notebook typing - the page is already showing it
    pendingRender = true;
    maybeRender();
  });
  // Something he writes or draws is finished once focus leaves it or "Done" is tapped.
  document.addEventListener('focusout', () => setTimeout(maybeRender, 0));
  document.addEventListener('click', () => setTimeout(maybeRender, 0));
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') await flushNotebook(); // keep a half-finished drawing
    else if (!busy.current()) render(); // a new day: "Not yet" resets, streak updates
  });
  window.addEventListener('pagehide', () => { flushNotebook(); });
  let askedHandle = false;
  syncer.onStatus((s) => {
    renderPill();
    // First sign-in: ask for the reader name once per app open.
    if (s.account === 'needs-handle' && !askedHandle) { askedHandle = true; handleSheet(() => render()); }
  });
  syncer.start();
  setupServiceWorker();
  await render();
  renderPill();
}

boot();
