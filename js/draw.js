// Full-screen drawing pad. Resolves with a webp Blob, or null if cancelled.

import { h } from './dom.js';
import { MAX_DRAWING_BYTES } from './validate.js';

const W = 1080, H = 1350;
const COLORS = ['#1d1b16', '#c2410c', '#1d4ed8', '#15803d'];
const WIDTHS = [6, 18];

export function openDrawing(baseBlob = null) {
  return new Promise((resolve) => {
    const canvas = h('canvas', { width: W, height: H, class: 'draw-canvas' });
    const ctx = canvas.getContext('2d');
    const strokes = [];
    let color = COLORS[0], width = WIDTHS[0], erasing = false, current = null, base = null;

    function paint(st) {
      ctx.strokeStyle = st.erase ? '#ffffff' : st.color;
      ctx.lineWidth = st.erase ? st.width * 3 : st.width;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      st.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (st.points.length === 1) ctx.lineTo(st.points[0][0] + 0.1, st.points[0][1]);
      ctx.stroke();
    }
    function redraw() {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      if (base) ctx.drawImage(base, 0, 0, W, H);
      strokes.forEach(paint);
    }
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      current = { color, width, erase: erasing, points: [pos(e)] };
      strokes.push(current);
      paint(current);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!current) return;
      current.points.push(pos(e));
      paint({ ...current, points: current.points.slice(-2) }); // only the new segment
    });
    const end = () => { current = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    const tools = h('div', { class: 'draw-tools' });
    function renderTools() {
      tools.replaceChildren(
        ...COLORS.map((c) => h('button', {
          class: `swatch${!erasing && c === color ? ' on' : ''}`, style: `background:${c}`, 'aria-label': 'Colour',
          onclick: () => { color = c; erasing = false; renderTools(); },
        })),
        ...WIDTHS.map((w) => h('button', {
          class: `tool${w === width ? ' on' : ''}`, 'aria-label': w === WIDTHS[0] ? 'Thin' : 'Thick',
          onclick: () => { width = w; renderTools(); },
        }, h('span', { class: 'dot', style: `width:${w / 2 + 4}px;height:${w / 2 + 4}px` }))),
        h('button', { class: `tool${erasing ? ' on' : ''}`, onclick: () => { erasing = !erasing; renderTools(); } }, 'Eraser'),
        h('button', { class: 'tool', onclick: () => { strokes.pop(); redraw(); } }, 'Undo'),
        h('button', { class: 'tool', onclick: () => { if (strokes.length && confirm('Clear the page?')) { strokes.length = 0; redraw(); } } }, 'Clear'),
      );
    }
    renderTools();

    const finish = (val) => { overlay.remove(); resolve(val); };
    const save = () => canvas.toBlob((blob) => {
      if (!blob) return finish(null);
      if (blob.size > MAX_DRAWING_BYTES) { alert('That drawing is too big to save. Try fewer thick strokes.'); return; }
      finish(blob);
    }, 'image/webp', 0.8);

    const overlay = h('div', { class: 'draw-overlay' },
      h('header', { class: 'draw-head' },
        h('button', { class: 'btn ghost', onclick: () => { if (!strokes.length || confirm('Throw this drawing away?')) finish(null); } }, 'Cancel'),
        h('strong', null, 'Draw'),
        h('button', { class: 'btn primary', onclick: save }, 'Save')),
      h('div', { class: 'draw-stage' }, canvas),
      tools);
    document.body.append(overlay);

    if (baseBlob) {
      const img = new Image();
      img.onload = () => { base = img; redraw(); URL.revokeObjectURL(img.src); };
      img.src = URL.createObjectURL(baseBlob);
    }
    redraw();
  });
}
