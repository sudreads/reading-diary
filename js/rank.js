// String fractional indexes: rankBetween(a, b) returns a key that sorts strictly between a and b.
// Keys never end in '0', so there is always room between any two of them - no renumbering.

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

export function rankBetween(a = '', b = null) {
  if (b !== null && b !== '' && a >= b) throw new Error('rankBetween: a must sort before b');
  if (b === '') b = null;
  let out = '';
  for (let i = 0; ; i++) {
    const ca = i < a.length ? DIGITS.indexOf(a[i]) : 0;
    const cb = b !== null ? (i < b.length ? DIGITS.indexOf(b[i]) : 0) : BASE;
    if (ca === cb) { out += DIGITS[ca]; continue; }
    const mid = Math.floor((ca + cb) / 2);
    if (mid > ca) return out + DIGITS[mid];
    // Adjacent digits: keep a's digit; from here on the only bound is a.
    out += DIGITS[ca];
    b = null;
  }
}

export function compareRanked(x, y) {
  const rx = x.rank || '', ry = y.rank || '';
  if (rx !== ry) return rx < ry ? -1 : 1;
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}
