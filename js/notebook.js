// The per-book notebook: lined pages you write straight onto, with a transparent drawing layer
// over the same page. The page has a fixed 3:4 shape and its text is sized in container units,
// so writing and drawing line up the same way on any screen width.

import * as store from './store.js';
import * as syncer from './syncer.js';
import { h, toast } from './dom.js';
import { rankBetween, compareRanked } from './rank.js';
import { MAX_DRAWING_BYTES } from './validate.js';

const W = 1080, H = 1440;
const COLORS = ['#1d1b16', '#c2410c', '#1d4ed8', '#15803d', '#ffffff'];
const WIDTHS = [5, 16];

// Pages in order. Legacy drawing blocks from 1.0 show as pages holding that drawing.
export function pagesOf(blocks, bookId) {
  return blocks.filter((b) => b.bookId === bookId && (b.type === 'page' || b.type === 'drawing')).sort(compareRanked);
}

// Everything the notebook needs to finish before the screen changes: pending text, open drawing.
// The list belongs to the notebook currently on screen: resetNotebook() runs before every redraw.
let flushers = [];
export async function flushNotebook() {
  for (const fn of [...flushers]) await fn();
}
export function resetNotebook() { flushers = []; }

export function notebookView({ book, pages, pageIndex, setPage, quiet, isBusy }) {
  const index = Math.min(Math.max(0, pageIndex), Math.max(0, pages.length - 1));
  let page = pages[index] || null; // null = blank first page, created on first write
  let saveTimer = null, pendingText = null, drawing = null;

  const ta = h('textarea', { class: 'paper-text', placeholder: page ? '' : 'Write anything about this book…', spellcheck: 'true', 'aria-label': 'Notebook page' });
  ta.value = page?.text || '';
  const overlay = h('img', { class: 'paper-ink', alt: '', hidden: true });
  const canvas = h('canvas', { class: 'paper-canvas', width: W, height: H, hidden: true });
  // 1.0 drawings are opaque white images; multiply lets the lines and text show through them.
  const paper = h('div', { class: `paper${page?.type === 'drawing' ? ' legacy' : ''}` }, ta, overlay, canvas);

  // The first save on a blank page creates it; any save that overlaps waits for that one.
  let creating = null;
  async function ensurePage(fields) {
    if (!page && creating) await creating;
    if (page) return quiet(() => store.save('blocks', { id: page.id, ...fields }));
    const rank = rankBetween(pages.at(-1)?.rank || '', null);
    creating = quiet(() => store.save('blocks', { bookId: book.id, type: 'page', text: '', rank, createdAt: Date.now(), ...fields }));
    page = await creating;
    creating = null;
    pages.push(page);
    return page;
  }

  async function saveText() {
    clearTimeout(saveTimer);
    if (pendingText === null) return;
    const text = pendingText;
    pendingText = null;
    if (!page && !text.trim()) return;
    page = await ensurePage({ text });
  }

  // A page holds what fits on it, like paper - so the drawing layer always lines up with the text.
  let lastFit = ta.value;
  ta.addEventListener('input', () => {
    if (ta.scrollHeight > ta.clientHeight + 2) {
      const caret = Math.max(0, ta.selectionStart - (ta.value.length - lastFit.length));
      ta.value = lastFit;
      ta.setSelectionRange(caret, caret);
      toast('This page is full - tap "+ New page"');
      return;
    }
    lastFit = ta.value;
    pendingText = ta.value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveText, 800);
  });
  ta.addEventListener('blur', saveText);

  // Existing drawing on this page.
  let baseBlob = null;
  if (page?.drawingId) {
    syncer.drawingBlob(page.drawingId).then((blob) => {
      if (!blob) return;
      baseBlob = blob;
      overlay.src = URL.createObjectURL(blob);
      overlay.hidden = false;
      overlay.onload = () => URL.revokeObjectURL(overlay.src);
    }).catch(() => {});
  }

  // ----- drawing layer -----
  const ctx = canvas.getContext('2d');
  function startDrawing() {
    drawing = { strokes: [], color: COLORS[0], width: WIDTHS[0], erase: false, current: null, base: null };
    ctx.clearRect(0, 0, W, H);
    if (baseBlob) {
      const img = new Image();
      img.onload = () => { drawing.base = img; redraw(); URL.revokeObjectURL(img.src); };
      img.src = URL.createObjectURL(baseBlob);
    }
    canvas.hidden = false;
    overlay.hidden = true;
    ta.readOnly = true;
    paper.classList.add('drawing-mode');
  }
  function paint(st) {
    ctx.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = st.color;
    ctx.lineWidth = st.erase ? st.width * 3 : st.width;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (st.points.length === 1) ctx.lineTo(st.points[0][0] + 0.1, st.points[0][1]);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  function redraw() {
    ctx.clearRect(0, 0, W, H);
    if (drawing.base) ctx.drawImage(drawing.base, 0, 0, W, H);
    drawing.strokes.forEach(paint);
  }
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!drawing) return;
    canvas.setPointerCapture(e.pointerId);
    drawing.current = { color: drawing.color, width: drawing.width, erase: drawing.erase, points: [pos(e)] };
    drawing.strokes.push(drawing.current);
    paint(drawing.current);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing?.current) return;
    drawing.current.points.push(pos(e));
    paint({ ...drawing.current, points: drawing.current.points.slice(-2) });
  });
  const endStroke = () => { if (drawing) drawing.current = null; };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  async function stopDrawing() {
    if (!drawing) return;
    if (drawing.strokes.length) {
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.85));
      if (blob && blob.size > MAX_DRAWING_BYTES) {
        // Stay in draw mode so he can undo a few strokes and try again.
        toast('That drawing is too big to save - undo a few thick strokes.');
        return;
      }
      if (blob) {
        const drawingId = await store.putDrawing(blob); // immutable: every save is a new drawing
        page = await ensurePage({ drawingId });
        baseBlob = blob;
        overlay.src = URL.createObjectURL(blob);
        paper.classList.remove('legacy');
      }
    }
    drawing = null;
    canvas.hidden = true;
    ta.readOnly = false;
    paper.classList.remove('drawing-mode');
    overlay.hidden = !baseBlob;
    renderTools();
  }

  // ----- toolbar -----
  const tools = h('div', { class: 'paper-tools' });
  function renderTools() {
    if (!drawing) {
      tools.replaceChildren(
        h('button', { class: 'btn', onclick: async () => { await saveText(); startDrawing(); renderTools(); } }, '🖍 Draw on this page'));
      return;
    }
    tools.replaceChildren(
      ...COLORS.map((c) => h('button', {
        class: `swatch${!drawing.erase && c === drawing.color ? ' on' : ''}`, style: `background:${c}`, 'aria-label': 'Colour',
        onclick: () => { drawing.color = c; drawing.erase = false; renderTools(); },
      })),
      ...WIDTHS.map((w) => h('button', {
        class: `tool${w === drawing.width ? ' on' : ''}`, 'aria-label': w === WIDTHS[0] ? 'Thin' : 'Thick',
        onclick: () => { drawing.width = w; renderTools(); },
      }, h('span', { class: 'dot', style: `width:${w / 2 + 4}px;height:${w / 2 + 4}px` }))),
      h('button', { class: `tool${drawing.erase ? ' on' : ''}`, onclick: () => { drawing.erase = !drawing.erase; renderTools(); } }, 'Eraser'),
      h('button', { class: 'tool', onclick: () => { drawing.strokes.pop(); redraw(); } }, 'Undo'),
      h('button', { class: 'btn primary', onclick: stopDrawing }, 'Done'));
  }
  renderTools();

  flushers.push(async () => { await saveText(); await stopDrawing(); });
  isBusy.current = () => !!drawing || document.activeElement === ta;

  const total = Math.max(1, pages.length);
  const go = async (i) => { await flushNotebook(); setPage(i); };
  const nav = h('div', { class: 'paper-nav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Previous page', disabled: index === 0, onclick: () => go(index - 1) }, '‹'),
    h('span', { class: 'muted small' }, `Page ${index + 1} of ${total}`),
    h('button', { class: 'icon-btn', 'aria-label': 'Next page', disabled: index >= total - 1, onclick: () => go(index + 1) }, '›'),
    h('button', { class: 'btn small', onclick: async () => {
      await flushNotebook();
      if (!page) return toast('Write or draw on this page first');
      const rank = rankBetween(pages.at(-1)?.rank || '', null);
      await quiet(() => store.save('blocks', { bookId: book.id, type: 'page', text: '', rank, createdAt: Date.now() }));
      setPage(pages.length);
    } }, '+ New page'),
    h('button', { class: 'icon-btn', 'aria-label': 'Delete page', onclick: async () => {
      await saveText();
      if (!page) return toast('This page is already empty');
      if (!confirm('Tear out this page? Its writing and drawing will be deleted.')) return;
      clearTimeout(saveTimer);
      pendingText = null;
      flushers = [];
      drawing = null;
      await store.remove('blocks', page.id);
      setPage(Math.max(0, index - 1));
    } }, '🗑'));

  return h('div', { class: 'notebook' }, nav, paper, tools);
}

export function commentsView({ book, blocks }) {
  // Comments, plus 1.0 notes/quotes/lessons, which are shown here and never rewritten.
  const items = blocks.filter((b) => b.bookId === book.id && ['comment', 'text', 'quote', 'lesson'].includes(b.type))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (a.id < b.id ? 1 : -1));
  const input = h('textarea', { rows: '2', maxlength: '20000', placeholder: 'Add a comment about this book…' });
  let lesson = false;
  const lessonBtn = h('button', { class: 'chip', 'aria-pressed': 'false', onclick: () => {
    lesson = !lesson;
    lessonBtn.classList.toggle('on', lesson);
    lessonBtn.setAttribute('aria-pressed', String(lesson));
  } }, '💡 It\'s a lesson');

  return h('div', { class: 'stack' },
    h('div', { class: 'card composer' }, input,
      h('div', { class: 'composer-row' }, lessonBtn,
        h('button', { class: 'btn primary', onclick: async () => {
          const text = input.value.trim();
          if (!text) return toast('Write something first');
          await store.save('blocks', { bookId: book.id, type: 'comment', text, lesson, createdAt: Date.now() });
        } }, 'Post'))),
    items.length ? items.map((c) => {
      const isLesson = c.type === 'lesson' || c.lesson === true;
      return h('article', { class: `comment${isLesson ? ' lesson' : ''}` },
        h('div', { class: 'comment-head' },
          h('span', { class: 'muted small' }, c.createdAt ? new Date(c.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''),
          isLesson && h('span', { class: 'badge' }, '💡 Lesson'),
          h('button', { class: 'icon-btn', 'aria-label': 'Delete comment', onclick: async () => { if (confirm('Delete this comment?')) await store.remove('blocks', c.id); } }, '🗑')),
        h('p', { class: `comment-text${c.type === 'quote' ? ' quote' : ''}` }, c.text || ''));
    }) : h('p', { class: 'muted center' }, 'No comments yet. What do you think of the book so far?'));
}

export function isLessonBlock(b) {
  return b.type === 'lesson' || (b.type === 'comment' && b.lesson === true);
}
