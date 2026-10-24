# Plan: Reading Diary 1.1 - Yanai's first feedback
_2026-10-24. Builds on PLAN.md; data model rules there still hold._

## Changes
1. **No starter button.** First run shows only "Add your first book".
2. **Now = streak only.** Remove pages/day goal, progress bar and page logging. Big flame with
   streak count + last-7-days dots. The current book card asks "Did you read today?" with
   **I read today** / **Not yet**.
   - I read today -> append a session `{bookId, date: localDate(), read: true, pages: 0, minutes: 0}`.
     Shown as done for the rest of the day ("You read today ✓"), with a small Undo that tombstones
     today's sessions for that book.
   - Not yet -> no data written; remembers "asked today" in localStorage for that date only and
     collapses the question to a single "I read today" button. Streak is not broken until midnight.
   - Streak derivation: a date counts if any live session has `read === true` OR pages/minutes > 0
     (old sessions keep counting).
3. **One book at a time.** Add-book offers "Start reading now" only when no book is in progress;
   otherwise "Want to read" / "Already finished" with a note "Finish <current> first". When there
   is no current book, Now lists want-to-read books with "Start reading". Finishing a book leads
   straight to picking the next one.
4. **Journal -> Notebook** (tab renamed). Per book, a stack of notebook **pages**: lined paper,
   handwriting font (Caveat from Google Fonts, cursive fallback offline), free text typed straight
   onto the page (autosave 800 ms after typing stops), and a **Draw** toggle that puts a
   transparent canvas over the same page (colors, 2 widths, eraser via destination-out, undo).
   The drawing is saved as a transparent webp overlay when leaving draw mode, as a new immutable
   drawing id (per PLAN.md). Page flip ‹ ›, "Page 2 / 5", + New page, delete page.
   Page = block `{type: 'page', text, drawingId, rank}`.
5. **Comments**, a separate section per book (segment control "Notebook | Comments"): short dated
   remarks, newest first, composer at the bottom with a "💡 lesson" toggle. Comment = block
   `{type: 'comment', text, lesson: bool, createdAt}`. Lesson of the day and trophy lessons read
   comments with lesson=true plus legacy 'lesson' blocks.
6. **Legacy data** (old text/quote/lesson/drawing blocks) is shown, never rewritten: text/quote/
   lesson -> comments (lesson -> lesson=true); drawing -> a notebook page with that drawing.
7. Validation accepts the new types and fields (`read` boolean, `lesson` boolean); CSP adds
   fonts.googleapis.com (style) and fonts.gstatic.com (font). SW cache bumped to rd-v2.
8. Settings: remove the daily goal card.

## Out of scope
Multiple concurrent books, page-count tracking, handwriting recognition.
