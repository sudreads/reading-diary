// Shrink a camera photo before upload: phones shoot 5-12 MB, the gallery needs ~200 KB.
// Re-encoding through a canvas also drops EXIF, so no GPS location leaves the phone.

const MAX_SIDE = 1280;
const QUALITY = 0.8;
const THUMB_SIDE = 320;
const THUMB_MAX_BYTES = 80 * 1024;

async function decode(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

function encode(source, w, hgt, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(w, hgt));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(hgt * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), 'image/jpeg', quality));
}

// Returns the photo to keep and a small copy for the gallery grid, so a gallery of a hundred
// photos costs a couple of megabytes of mobile data instead of twenty.
export async function shrinkPhoto(file) {
  const source = await decode(file);
  const w = source.width || source.naturalWidth, hgt = source.height || source.naturalHeight;
  if (!w || !hgt) throw new Error('empty image');
  const blob = await encode(source, w, hgt, MAX_SIDE, QUALITY);
  let thumb = await encode(source, w, hgt, THUMB_SIDE, 0.7).catch(() => null);
  if (thumb && thumb.size > THUMB_MAX_BYTES) thumb = null; // the grid will use the full photo
  if (source.close) source.close();
  return { blob, thumb };
}
