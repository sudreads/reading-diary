// Google sign-in (Identity Services token client) and the Drive appDataFolder calls.
// The access token lives only in this module's memory - never in storage or logs.

import { GOOGLE_CLIENT_ID, EXPECTED_EMAIL } from './config.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.appdata openid email';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

let tokenClient = null;
let token = null; // { value, expires }
let pending = null;

export const isConfigured = () => !!GOOGLE_CLIENT_ID;
export const hasToken = () => !!token && token.expires > Date.now() + 60_000;
export const forget = () => { token = null; };

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = res;
    s.onerror = () => rej(new Error('offline-or-blocked'));
    document.head.appendChild(s);
  });
}

// interactive=false tries silently (works when he already consented and is signed in to Chrome).
export async function connect({ interactive }) {
  if (!isConfigured()) throw new Error('not-configured');
  if (hasToken()) return;
  if (pending) return pending;
  pending = (async () => {
    await loadGis();
    await new Promise((res, rej) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        ...(EXPECTED_EMAIL ? { login_hint: EXPECTED_EMAIL } : {}),
        callback: (r) => {
          if (r.error) return rej(new Error(r.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, 'https://www.googleapis.com/auth/drive.appdata')) return rej(new Error('drive-permission-not-granted'));
          token = { value: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
          res();
        },
        error_callback: (e) => rej(new Error(e?.type || 'popup-failed')),
      });
      tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
    });
  })();
  try { await pending; } finally { pending = null; }
}

async function call(url, opts = {}, as = 'json') {
  if (!hasToken()) throw new Error('no-token');
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token.value}` } });
  if (r.status === 401) { token = null; throw new Error('token-expired'); }
  if (!r.ok) throw new Error(`drive-${r.status}`);
  if (as === 'json') return r.json();
  if (as === 'blob') return r.blob();
  return r;
}

export async function whoAmI() {
  const u = await call('https://openidconnect.googleapis.com/v1/userinfo');
  return u.email || '';
}

const q = (s) => encodeURIComponent(s);

async function listByName(clause) {
  const out = [];
  let pageToken = '';
  do {
    const r = await call(`${API}/files?spaces=appDataFolder&pageSize=1000&fields=nextPageToken,files(id,name,modifiedTime)&q=${q(clause)}${pageToken ? `&pageToken=${q(pageToken)}` : ''}`);
    out.push(...r.files);
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

function multipart(meta, body, type) {
  const boundary = 'rd' + crypto.randomUUID().replace(/-/g, '');
  const blob = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${type}\r\n\r\n`, body, `\r\n--${boundary}--`,
  ]);
  return { blob, contentType: `multipart/related; boundary=${boundary}` };
}

async function create(name, body, type) {
  const { blob, contentType } = multipart({ name, parents: ['appDataFolder'] }, body, type);
  return call(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', headers: { 'Content-Type': contentType }, body: blob });
}

// The shape sync.js expects.
export const driveApi = {
  listDeviceFiles: () => listByName("name contains 'device-' and trashed = false"),
  downloadJson: (id) => call(`${API}/files/${q(id)}?alt=media`),
  async uploadDeviceFile(id, name, obj) {
    const body = JSON.stringify(obj);
    if (!id) return create(name, body, 'application/json');
    try {
      return await call(`${UPLOAD}/files/${q(id)}?uploadType=media&fields=id,modifiedTime`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
      });
    } catch (e) {
      if (e.message === 'drive-404') return create(name, body, 'application/json'); // file was removed
      throw e;
    }
  },
  async getFileMeta(id) {
    try { return await call(`${API}/files/${q(id)}?fields=id,modifiedTime`); } catch (e) {
      if (e.message === 'drive-404') return null;
      throw e;
    }
  },
  async ensureDrawing(name, blob) {
    const found = await listByName(`name = '${name}' and trashed = false`);
    if (!found.length) await create(name, blob, 'image/webp');
  },
  async downloadDrawing(id) {
    const found = await listByName(`name = 'drawing-${id}.webp' and trashed = false`);
    if (!found.length) return null;
    return call(`${API}/files/${q(found[0].id)}?alt=media`, {}, 'blob');
  },
};
