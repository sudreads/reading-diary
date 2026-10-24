// One-time cleanup of duplicate books (the same book added twice). Conservative on purpose: a copy
// is only removed when it is completely empty AND another copy of the same book has something in
// it. Copies that both hold writing are never touched.

import { workIdOf } from './social.js';

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const keyOf = (b) => workIdOf(b.olKey) || `${norm(b.title)}|${norm(b.author)}`;
const RANK = { reading: 3, finished: 2, want: 1 };

// A blank page made by "+ New page" isn't writing; a page with text or a drawing is.
const hasContent = (x) => !!String(x.text || '').trim() || !!x.drawingId;
const written = (book, blocks) => blocks.filter((x) => x.bookId === book.id && hasContent(x)).length;

// Nothing written, no rating, no review: removing it loses nothing.
function isEmpty(book, blocks) {
  return !written(book, blocks) && !(book.rating > 0) && !String(book.comment || '').trim();
}

// -> { remove: [bookId], moveSessions: [{ from, to }], setStatus: [{ id, status }] }
// Blank pages of a removed copy go with it (the caller removes all its blocks).
export function dedupePlan(books, blocks) {
  const live = books.filter((b) => !b.deleted);
  const liveBlocks = blocks.filter((x) => !x.deleted);
  const groups = new Map();
  for (const b of live) {
    const k = keyOf(b);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  const plan = { remove: [], moveSessions: [], setStatus: [] };
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const full = group.filter((b) => !isEmpty(b, liveBlocks));
    if (!full.length) continue; // all empty: leave it to him, nothing tells us which to keep
    // Keep the copy with the most writing (ties: further along, then newest).
    const keep = [...full].sort((a, b) =>
      written(b, liveBlocks) - written(a, liveBlocks) ||
      (RANK[b.status] || 0) - (RANK[a.status] || 0) || (b.rev?.t || 0) - (a.rev?.t || 0))[0];
    for (const b of group) {
      if (b.id === keep.id || !isEmpty(b, liveBlocks)) continue;
      plan.remove.push(b.id);
      plan.moveSessions.push({ from: b.id, to: keep.id }); // check-ins follow the book that stays
      // The empty copy was the one "reading now": the kept copy takes over unless it's finished.
      if (b.status === 'reading' && keep.status === 'want') plan.setStatus.push({ id: keep.id, status: 'reading' });
    }
  }
  return plan;
}
