// Explore: find any book, see what readers think. And the public book page: details, ratings,
// every review, add to My Books. All text from Google Books / Open Library / other readers is
// rendered with textContent (via h()); descriptions are reduced to plain text first.

import * as fb from './firebase.js';
import * as syncer from './syncer.js';
import { h, fill, sheet, toast } from './dom.js';
import { searchBooks, bookDetails, plainText, bookKeyOf } from './catalog.js';
import { averageOf, onePerReader, REPORT_REASONS } from './social.js';
import { friendsActivity, friendSheet } from './friends.js';

const monthYear = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '');
const canRead = () => syncer.state.checked && (syncer.state.account === 'ready' || syncer.state.account === 'needs-handle');

function starRow(n, cls = '') {
  const r = Math.max(0, Math.min(5, Math.round(n || 0)));
  return h('span', { class: `stars-inline ${cls}`, 'aria-label': `${r} of 5 stars` }, '★'.repeat(r), h('span', { class: 'off' }, '★'.repeat(5 - r)));
}

// ---------- Explore screen ----------

const feedCache = { at: 0, latest: [], trending: [] };
let lastQuery = '';

async function loadFeed() {
  if (Date.now() - feedCache.at < 15 * 60 * 1000 && feedCache.latest.length) return feedCache;
  // One page of the 30 newest reviews (the rules' limit): ~30 reads per refresh, cached 15 min.
  const { list: raw } = await fb.latestReviews(null);
  const pages = onePerReader(raw);
  const byBook = new Map();
  for (const r of pages) {
    if (!r.bookKey) continue;
    const e = byBook.get(r.bookKey) || { key: r.bookKey, title: r.title, author: r.author, coverUrl: r.coverUrl, count: 0, sum: 0 };
    e.count++; e.sum += r.rating;
    if (!e.title && r.title) Object.assign(e, { title: r.title, author: r.author, coverUrl: r.coverUrl });
    byBook.set(r.bookKey, e);
  }
  feedCache.trending = [...byBook.values()].filter((b) => b.title).sort((a, b) => b.count - a.count || b.sum - a.sum).slice(0, 10);
  feedCache.latest = pages.filter((r) => r.title).slice(0, 30);
  feedCache.at = Date.now();
  return feedCache;
}

// ctx: { cover, myBookFor(key), addToMyBooks(book, status), openMyBook(id), currentBook() }
export function exploreScreen(ctx) {
  const input = h('input', { type: 'search', class: 'search-input', placeholder: 'Search any book or author', autocomplete: 'off', value: lastQuery, 'aria-label': 'Search books' });
  const results = h('div', { class: 'results-list' });
  const home = h('div', { class: 'stack' });
  let timer;

  // Tap the row for the book page; tap ＋ to add it straight away (two taps from search to shelf).
  const resultRow = (b) => {
    const mine = ctx.myBookFor(b.key);
    return h('div', { class: 'result-line' },
      h('button', { class: 'book-row', onclick: () => bookPage(b.key, b, ctx) },
        ctx.cover(b, 'cover-sm'),
        h('span', { class: 'book-row-text' },
          h('strong', null, b.title),
          h('span', { class: 'muted small' }, [b.author, b.year].filter(Boolean).join(' · ')),
          mine && h('span', { class: 'badge' }, 'In My Books'))),
      !mine && h('button', { class: 'add-fab', 'aria-label': `Add ${b.title} to My Books`, onclick: () => chooseStatusSheet(b, {
        ...ctx, addToMyBooks: async (book, status) => { await ctx.addToMyBooks(book, status); run(input.value); },
      }) }, '＋'));
  };

  async function run(q) {
    lastQuery = q;
    if (q.trim().length < 2) { results.replaceChildren(); home.hidden = false; return; }
    home.hidden = true;
    results.replaceChildren(h('p', { class: 'muted' }, 'Searching…'));
    try {
      const found = await searchBooks(q);
      if (q !== lastQuery) return;
      results.replaceChildren(...(found.length ? found.map(resultRow)
        : [h('p', { class: 'muted' }, 'No books found. Try the title in another language, or the author\'s name.')]));
    } catch (e) {
      if (e.name === 'AbortError') return;
      results.replaceChildren(h('p', { class: 'muted' }, navigator.onLine ? 'Search isn\'t working right now. Try again in a moment.' : 'You\'re offline - search needs the internet.'));
    }
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(input.value), 400); });

  // Trending + latest reviews, when not searching.
  if (canRead()) {
    home.append(h('p', { class: 'muted' }, 'Loading what readers are reading…'));
    loadFeed().then(({ trending, latest }) => {
      fill(home,
        trending.length > 0 && h('section', null, h('h2', { class: 'section-title' }, 'Trending in Reading Diary'),
          h('div', { class: 'cover-strip' }, trending.map((b) => h('button', { class: 'strip-book', onclick: () => bookPage(b.key, b, ctx) },
            ctx.cover(b, 'cover'), h('span', { class: 'strip-title' }, b.title),
            h('span', { class: 'muted tiny' }, `${(b.sum / b.count).toFixed(1)}★ · ${b.count} review${b.count === 1 ? '' : 's'}`))))),
        h('section', null, h('h2', { class: 'section-title' }, 'Latest reviews'),
          latest.length ? h('div', { class: 'stack' }, latest.map((r) => h('button', { class: 'feed-review', onclick: () => bookPage(r.bookKey, r, ctx) },
            ctx.cover(r, 'cover-sm'),
            h('span', { class: 'feed-text' },
              h('strong', null, r.title),
              h('span', { class: 'small' }, starRow(r.rating), ` @${r.handle}`),
              r.text && h('span', { class: 'muted small clamp-3' }, r.text)))))
            : h('p', { class: 'muted' }, 'No reviews yet - finish a book and be the first!')));
    }).catch(() => home.replaceChildren(h('p', { class: 'muted' }, navigator.onLine ? 'Couldn\'t load reviews right now.' : 'You\'re offline - Explore needs the internet.')));
  } else {
    home.append(h('p', { class: 'muted' }, 'Sign in to see what other readers think.'));
  }
  // What friends are reading: only cards they share with friends (streak, current and last book).
  const friendsBox = h('div');
  friendsActivity().then((cards) => {
    if (!cards.length) return;
    friendsBox.replaceChildren(h('section', null, h('h2', { class: 'section-title' }, 'Friends'),
      h('div', { class: 'stack' }, cards.map((a) => h('button', { class: 'feed-review', onclick: (e) => { const row = e.currentTarget; friendSheet(a, { cover: ctx.cover, onChange: () => { const rest = row.parentElement; row.remove(); if (!rest.children.length) friendsBox.replaceChildren(); } }); } },
        a.currentBook ? ctx.cover(a.currentBook, 'cover-sm') : h('span', { class: 'cover-sm friend-dot' }, a.streak ? '🔥' : '🌱'),
        h('span', { class: 'feed-text' },
          h('strong', null, `@${a.handle}`),
          h('span', { class: 'small' }, a.currentBook ? `Reading ${a.currentBook.title}` : a.lastFinished ? `Finished ${a.lastFinished.title}` : 'Not reading anything yet'),
          h('span', { class: 'muted small' }, `${a.streak ? '🔥' : '🌱'} ${a.streak} day streak · ${a.finishedCount} finished`)))))));
  }).catch(() => { /* friends are a bonus here; the Me tab shows any error */ });
  if (lastQuery.trim().length >= 2) run(lastQuery);
  return h('div', { class: 'stack' }, input, results, friendsBox, home);
}

// ---------- Add to My Books ----------

export function chooseStatusSheet(b, ctx) {
  const reading = ctx.currentBook();
  const pick = async (status) => { close(); await ctx.addToMyBooks(b, status); };
  const close = sheet(`Add "${b.title}"`, h('div', { class: 'form' },
    reading ? h('p', { class: 'note' }, `You're reading ${reading.title}. Finish it first to start another.`)
      : h('button', { class: 'btn primary big-btn', onclick: () => pick('reading') }, '📖 Start reading now'),
    h('button', { class: 'btn big-btn', onclick: () => pick('want') }, '🔖 Want to read'),
    h('button', { class: 'btn big-btn', onclick: () => pick('finished') }, '🏆 I already finished it')));
}

// ---------- Book page ----------

export function bookPage(key, hint, ctx) {
  const overlay = h('div', { class: 'page-overlay', role: 'dialog', 'aria-label': hint?.title || 'Book' });
  // A history entry per book page, so Android's back gesture closes it instead of the app.
  let closed = false;
  const onPop = () => {
    window.removeEventListener('popstate', onPop);
    if (closed) return;
    closed = true;
    overlay.remove();
    ctx.onClose?.();
  };
  history.pushState({ rdBook: key }, '');
  window.addEventListener('popstate', onPop);
  const close = () => { if (!closed) history.back(); };
  const body = h('div', { class: 'page-body stack' });
  overlay.append(h('header', { class: 'page-head' },
    h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: close }, '←'),
    h('strong', { class: 'page-title' }, hint?.title || 'Book')), body);
  document.body.append(overlay);

  let book = { key, ...hint };
  const top = h('div', { class: 'book-top' });
  const action = h('div', { class: 'actions' });
  const desc = h('div');
  const ratings = h('div', { class: 'card ratings' }, h('p', { class: 'muted' }, 'Loading reviews…'));
  const list = h('div', { class: 'stack' });
  const more = h('button', { class: 'btn wide', hidden: true }, 'Load more reviews');
  body.append(top, action, desc, ratings, list, more);

  function drawTop() {
    fill(top, ctx.cover(book, 'cover-lg'),
      h('div', null,
        h('h1', { class: 'book-title' }, book.title || ''),
        book.author && h('div', null, book.author),
        h('div', { class: 'muted small' }, [book.year, book.pages ? `${book.pages} pages` : ''].filter(Boolean).join(' · ')),
        book.categories?.length > 0 && h('div', { class: 'chips small' }, book.categories.map((c) => h('span', { class: 'chip' }, c)))));
    const mine = ctx.myBookFor(key);
    action.replaceChildren(mine
      ? h('button', { class: 'btn primary', onclick: () => { close(); ctx.openMyBook(mine.id); } }, `Open in My Books (${{ reading: 'reading now', want: 'want to read', finished: 'finished' }[mine.status] || mine.status})`)
      : h('button', { class: 'btn primary', onclick: () => chooseStatusSheet(book, { ...ctx, addToMyBooks: async (b, st) => { await ctx.addToMyBooks(b, st); drawTop(); } }) }, '+ Add to My Books'));
    const text = plainText(book.description);
    if (text) {
      const p = h('p', { class: 'description clamp-6' }, text);
      fill(desc, h('h2', { class: 'section-title' }, 'About this book'), p,
        text.length > 300 && h('button', { class: 'link-btn', onclick: (e) => { p.classList.toggle('clamp-6'); e.currentTarget.textContent = p.classList.contains('clamp-6') ? 'More' : 'Less'; } }, 'More'));
    }
  }
  drawTop();

  // Live details (catalog docs are only hints).
  (async () => {
    const doc = canRead() ? await fb.catalogDoc(key).catch(() => null) : null;
    const d = await bookDetails(key, { catalogDoc: doc });
    if (d) { book = { ...book, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length))) }; drawTop(); }
  })();

  // Reviews.
  let all = [], cursor = null;
  function drawRatings() {
    if (!all.length) { ratings.replaceChildren(h('p', { class: 'muted' }, 'No reviews yet. Finish it and be the first!')); return; }
    const avg = averageOf(all);
    const counts = [5, 4, 3, 2, 1].map((n) => all.filter((r) => r.rating === n).length);
    ratings.replaceChildren(
      h('div', { class: 'ratings-top' },
        h('div', { class: 'big' }, avg.toFixed(1)), starRow(avg, 'lg'),
        h('div', { class: 'muted small' }, all.length >= 50 ? `from the latest ${all.length} reviews` : `${all.length} review${all.length === 1 ? '' : 's'}`)),
      h('div', { class: 'bars' }, [5, 4, 3, 2, 1].map((n, i) => h('div', { class: 'bar-row' },
        h('span', { class: 'tiny' }, `${n}★`), h('span', { class: 'bar' }, h('span', { style: `width:${Math.round((counts[i] / all.length) * 100)}%` })), h('span', { class: 'tiny muted' }, String(counts[i]))))));
  }
  function reviewCard(r) {
    const me = syncer.state;
    const mine = r.uid === me.uid;
    const card = h('article', { class: `review${mine ? ' mine' : ''}` },
      h('div', { class: 'review-head' }, h('strong', null, `@${r.handle}`), mine && h('span', { class: 'badge' }, 'You'), h('span', { class: 'muted small' }, monthYear(r.createdAt))),
      starRow(r.rating),
      r.text && h('p', { class: 'review-text' }, r.text),
      h('div', { class: 'review-tools' },
        !mine && h('button', { class: 'link-btn', onclick: () => reportSheet(r, key) }, 'Report'),
        (mine || me.admin) && h('button', { class: 'link-btn', onclick: async () => {
          if (!confirm(mine ? 'Delete your public review? Your private rating stays in your diary.' : `Delete @${r.handle}'s review for everyone?`)) return;
          try {
            await fb.deleteReview2(key, r.uid);
            card.remove();
            all = all.filter((x) => x !== r);
            drawRatings();
            feedCache.at = 0; // Explore's counts must drop it too
            if (mine) ctx.onUnpublish?.(key);
          } catch (e) { toast(`Couldn't delete (${e.code || e.message})`); }
        } }, 'Delete')));
    return card;
  }
  async function loadReviews() {
    if (!canRead()) { ratings.replaceChildren(h('p', { class: 'muted' }, 'Sign in to see reviews.')); return; }
    try {
      const page = await fb.reviewsFor(key, cursor);
      const fresh = page.list.filter((r) => !all.some((x) => x.uid === r.uid));
      all = all.concat(fresh);
      cursor = page.cursor;
      drawRatings();
      list.append(...fresh.map(reviewCard));
      more.hidden = !page.more;
      more.onclick = loadReviews;
    } catch (e) {
      ratings.replaceChildren(h('p', { class: 'muted' }, navigator.onLine ? `Couldn't load reviews (${e.code || e.message}).` : 'You\'re offline - reviews need the internet.'));
    }
  }
  loadReviews();
  return close;
}

function reportSheet(r, key) {
  const close = sheet('Report review', h('div', { class: 'form' },
    h('p', { class: 'muted small' }, `Reporting @${r.handle}'s review. The admin will look at it.`),
    Object.entries(REPORT_REASONS).map(([reason, label]) => h('button', { class: 'btn', onclick: async () => {
      try {
        await fb.report(r.legacy ? key.replace(/^ol:/, '') : key, r.uid, syncer.state.uid, reason);
        toast('Reported - thanks');
      } catch (e) {
        toast(e.code === 'permission-denied' ? 'You already reported this one' : `Couldn't report (${e.code || e.message})`);
      }
      close();
    } }, label))));
}

export { bookKeyOf };
