// Finding books. Google Books first (big, includes Hebrew, has descriptions), Open Library as
// backup, and the community catalog (books readers added themselves) on top. Every result carries
// one canonical book key that reviews, the catalog and trending all share:
//   isbn:<13 digits>  a Google Books volume with an ISBN-13
//   gb:<volumeId>     a Google Books volume without one
//   ol:<OL...W>       an Open Library work (1.x books, and the Open Library fallback)
//   c:<uuid>          added by a reader
// Display data from these APIs is untrusted text: callers render it with textContent only.

import { FIREBASE_CONFIG } from './config.js';

const GB = 'https://www.googleapis.com/books/v1/volumes';
const OL = 'https://openlibrary.org';
const COOLDOWN_KEY = 'rd-gb-cooldown';
const cache = new Map(); // per session: query -> results (saves the shared Google Books quota)

export const KEY_RE = /^(isbn:97[89]\d{10}|gb:[A-Za-z0-9_-]{6,24}|ol:OL\d{1,12}W|c:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const isBookKey = (k) => KEY_RE.test(k || '');

// 1.x books only know their Open Library work; 2.0 books carry bookKey.
export function bookKeyOf(book) {
  if (isBookKey(book?.bookKey)) return book.bookKey;
  const m = /^\/works\/(OL\d{1,12}W)$/.exec(book?.olKey || '');
  return m ? `ol:${m[1]}` : null;
}

const httpsCover = (u) => (u ? String(u).replace(/^http:\/\//, 'https://').replace(/&edge=curl/, '') : '');
const COVER_OK = /^https:\/\/(books\.google\.com|books\.googleusercontent\.com|covers\.openlibrary\.org)\//;
export const safeCover = (u) => (COVER_OK.test(u || '') ? u : '');
const clip = (s, n) => String(s || '').slice(0, n);

// HTML descriptions (Google) become plain text. DOMParser builds an inert document: no scripts run.
export function plainText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return clip(doc.body.textContent.replace(/\s+\n/g, '\n').trim(), 5000);
}

function fromGoogle(item) {
  const v = item.volumeInfo || {};
  const isbn13 = (v.industryIdentifiers || []).find((x) => x.type === 'ISBN_13')?.identifier || '';
  const key = /^97[89]\d{10}$/.test(isbn13) ? `isbn:${isbn13}` : `gb:${item.id}`;
  return {
    key, source: 'google', gbId: item.id,
    title: clip(v.title + (v.subtitle ? `: ${v.subtitle}` : ''), 300),
    author: clip((v.authors || []).join(', '), 300),
    year: clip(v.publishedDate, 4), pages: Number.isInteger(v.pageCount) ? v.pageCount : 0,
    isbn13: key.startsWith('isbn:') ? isbn13 : '',
    coverUrl: safeCover(httpsCover(v.imageLinks?.thumbnail)),
    description: v.description || '', categories: (v.categories || []).slice(0, 3), language: v.language || '',
  };
}

function fromOpenLibrary(d) {
  const work = /^\/works\/(OL\d{1,12}W)$/.exec(d.key || '');
  if (!work) return null;
  return {
    key: `ol:${work[1]}`, source: 'openlibrary', olKey: d.key,
    title: clip(d.title, 300), author: clip((d.author_name || [])[0], 300),
    year: d.first_publish_year ? String(d.first_publish_year) : '', pages: Number.isInteger(d.number_of_pages_median) ? d.number_of_pages_median : 0,
    isbn13: '', coverUrl: Number.isInteger(d.cover_i) ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
    description: '', categories: [], language: '',
  };
}

function googleCoolingDown() {
  try { return localStorage.getItem(COOLDOWN_KEY) === new Date().toDateString(); } catch { return false; }
}
function coolGoogleDown() {
  try { localStorage.setItem(COOLDOWN_KEY, new Date().toDateString()); } catch { /* ignore */ }
}

async function fetchJson(url, signal) {
  const r = await fetch(url, { signal, referrerPolicy: 'strict-origin-when-cross-origin' });
  if (r.status === 429 || r.status === 403) { const e = new Error('quota'); e.quota = true; throw e; }
  if (!r.ok) throw new Error(`http-${r.status}`);
  return r.json();
}

async function searchGoogle(q, signal) {
  const key = FIREBASE_CONFIG?.apiKey ? `&key=${encodeURIComponent(FIREBASE_CONFIG.apiKey)}` : '';
  const fields = 'items(id,volumeInfo(title,subtitle,authors,publishedDate,pageCount,industryIdentifiers,imageLinks/thumbnail,description,categories,language))';
  const data = await fetchJson(`${GB}?q=${encodeURIComponent(q)}&maxResults=20&printType=books&fields=${encodeURIComponent(fields)}${key}`, signal);
  return (data.items || []).map(fromGoogle).filter((b) => b.title);
}

async function searchOpenLibrary(q, signal) {
  const data = await fetchJson(`${OL}/search.json?limit=20&fields=key,title,author_name,cover_i,first_publish_year,number_of_pages_median&q=${encodeURIComponent(q)}`, signal);
  return (data.docs || []).map(fromOpenLibrary).filter(Boolean);
}

// Same book from two sources, or two editions with identical title + author: show it once.
const sameBook = (b) => `${b.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}|${b.author.toLowerCase().split(',')[0].replace(/[^\p{L}\p{N}]+/gu, '')}`;
export function mergeResults(lists) {
  const seen = new Set(), out = [];
  for (const list of lists) for (const b of list) {
    const k = sameBook(b);
    if (seen.has(k) || seen.has(b.key)) continue;
    seen.add(k); seen.add(b.key);
    out.push(b);
  }
  return out;
}

export const clearSearchCache = () => cache.clear();

let inflight = null;
// community: async (q) -> results from catalog/ (Firestore prefix search), injected by the caller.
export async function searchBooks(query, { community } = {}) {
  const q = query.trim();
  if (q.length < 2) return [];
  if (cache.has(q)) return cache.get(q);
  inflight?.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const mine = community ? community(q).catch(() => []) : Promise.resolve([]);
    let primary = [];
    if (!googleCoolingDown()) {
      try { primary = await searchGoogle(q, ctrl.signal); } catch (e) { if (e.quota) coolGoogleDown(); else if (e.name === 'AbortError') throw e; }
    }
    // Open Library fills in when Google is out of quota, finds nothing, or finds little.
    const backup = primary.length >= 8 ? [] : await searchOpenLibrary(q, ctrl.signal).catch(() => []);
    const results = mergeResults([await mine, primary, backup]);
    cache.set(q, results);
    return results;
  } finally {
    clearTimeout(timer);
  }
}

// Full details for a book page. External keys always render from the live source (catalog docs
// are only hints and could have been written by anyone); community books from the catalog doc.
export async function bookDetails(key, { catalogDoc } = {}) {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  try {
    if (kind === 'gb' || kind === 'isbn') {
      if (!googleCoolingDown()) {
        const k = FIREBASE_CONFIG?.apiKey ? `key=${encodeURIComponent(FIREBASE_CONFIG.apiKey)}` : '';
        if (kind === 'gb') return fromGoogle(await fetchJson(`${GB}/${encodeURIComponent(id)}?${k}`));
        const r = await fetchJson(`${GB}?q=isbn:${id}&maxResults=1&${k}`);
        if (r.items?.length) return { ...fromGoogle(r.items[0]), key };
      }
      if (kind === 'isbn') { // Open Library by ISBN as backup
        const d = await fetchJson(`${OL}/isbn/${id}.json`);
        const work = d.works?.[0]?.key;
        const w = work ? await fetchJson(`${OL}${work}.json`) : {};
        return { key, source: 'openlibrary', title: clip(d.title, 300), author: '', year: clip(d.publish_date, 4), pages: d.number_of_pages || 0, isbn13: id,
          coverUrl: d.covers?.[0] ? `https://covers.openlibrary.org/b/id/${d.covers[0]}-M.jpg` : '',
          description: typeof w.description === 'string' ? w.description : w.description?.value || '', categories: [], language: '' };
      }
    }
    if (kind === 'ol') {
      const w = await fetchJson(`${OL}/works/${id}.json`);
      return { key, source: 'openlibrary', olKey: `/works/${id}`, title: clip(w.title, 300), author: catalogDoc?.author || '', year: '', pages: catalogDoc?.pages || 0, isbn13: '',
        coverUrl: w.covers?.[0] ? `https://covers.openlibrary.org/b/id/${w.covers[0]}-M.jpg` : (catalogDoc?.coverUrl || ''),
        description: typeof w.description === 'string' ? w.description : w.description?.value || '', categories: (w.subjects || []).slice(0, 3), language: '' };
    }
  } catch { /* fall through to the catalog hints */ }
  if (catalogDoc) return { key, source: 'community', title: catalogDoc.title, author: catalogDoc.author, year: '', pages: catalogDoc.pages || 0,
    isbn13: catalogDoc.isbn13 || '', coverUrl: safeCover(catalogDoc.coverUrl), description: '', categories: [], language: '' };
  return null;
}
