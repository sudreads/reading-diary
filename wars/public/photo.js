// Shrink a camera photo before upload: phones shoot 5-12 MB, the gallery needs ~200 KB.
// Re-encoding through a canvas also drops EXIF, so no GPS location leaves the phone.

const MAX_SIDE = 1280;
const QUALITY = 0.8;

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

export async function shrinkPhoto(file) {
  const source = await decode(file);
  const w = source.width || source.naturalWidth, hgt = source.height || source.naturalHeight;
  if (!w || !hgt) throw new Error('empty image');
  const scale = Math.min(1, MAX_SIDE / Math.max(w, hgt));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(hgt * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('encode failed');
  return blob;
}
