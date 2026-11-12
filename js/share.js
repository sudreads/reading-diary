// "Share my streak": a story-sized picture drawn on the phone (no picture leaves it until the
// reader shares it). Only the streak, the book title and the reader name go on it.

import { hueOf } from './dom.js';

const W = 1080, H = 1920;

function glow(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'transparent');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// Breaks a title into at most `max` lines that fit `width`.
function wrap(ctx, text, width, max) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= width || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > max) { lines.length = max; lines[max - 1] = `${lines[max - 1].replace(/.{2}$/, '')}…`; }
  return lines;
}

export function drawStreakCard({ streak, title, handle }) {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const hue = hueOf(title || 'Reading Diary');
  const font = (px, weight = 800) => `${weight} ${px}px "SF Pro Display", "Inter", "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = '#0a0a0d';
  ctx.fillRect(0, 0, W, H);
  glow(ctx, 160, 200, 1100, `hsl(${hue} 85% 45% / 0.75)`);
  glow(ctx, 1000, 700, 900, `hsl(${hue + 55} 85% 45% / 0.6)`);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.font = font(520);
  ctx.fillText(String(streak), 80, 900);
  ctx.font = font(92);
  ctx.fillText(streak === 1 ? 'day of reading' : 'days of reading', 90, 1040);
  ctx.font = font(64, 600);
  ctx.fillStyle = 'rgb(255 255 255 / 0.75)';
  ctx.fillText('in a row', 90, 1130);
  if (title) {
    ctx.font = font(46, 600);
    ctx.fillStyle = 'rgb(255 255 255 / 0.6)';
    ctx.fillText('Reading now', 90, 1420);
    ctx.font = font(76);
    ctx.fillStyle = '#ffffff';
    wrap(ctx, title, W - 180, 2).forEach((l, i) => ctx.fillText(l, 90, 1520 + i * 92));
  }
  ctx.font = font(44, 700);
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Reading Diary', 90, H - 110);
  if (handle) {
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgb(255 255 255 / 0.7)';
    ctx.fillText(`@${handle}`, W - 90, H - 110);
  }
  return canvas;
}

// Opens the phone's share sheet with the picture; where that isn't possible, saves the picture.
// -> 'shared' | 'saved' | 'cancelled'
export async function shareStreak(data) {
  const blob = await new Promise((res) => drawStreakCard(data).toBlob(res, 'image/png'));
  const file = new File([blob], 'reading-streak.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'My reading streak' }); return 'shared'; } catch { return 'cancelled'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return 'saved';
}
