// End-to-end: three phones play a whole game in real browsers.
// Run: node test/e2e.mjs   (screenshots land in test/shots/)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createApp } from '../server.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-e2e-'));
let clock = 0; // added to the real time, to step over the anti-spam cooldown
const app = createApp({ dataDir, now: () => Date.now() + clock });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const errors = [];

const urls = []; // every request any phone makes

async function phone(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'he-IL', hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  page.on('request', (r) => urls.push(r.url()));
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text())) errors.push(`${name}: console: ${m.text()}`); });
  return page;
}

// A "photo": a screenshot of a big emoji on a coloured page.
async function fakePhoto(emoji, color) {
  const page = await browser.newPage({ viewport: { width: 800, height: 1000 } });
  await page.setContent(`<body style="margin:0;display:grid;place-items:center;height:100vh;background:${color};font-size:420px">${emoji}</body>`);
  const buffer = await page.screenshot({ type: 'jpeg', quality: 80 });
  await page.close();
  return { name: 'photo.jpg', mimeType: 'image/jpeg', buffer };
}

async function addPoint(page, catLabel, photo, note) {
  clock += 4000;
  await page.getByRole('tab', { name: 'משחק' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.action', { hasText: catLabel }).click();
  await (await chooser).setFiles(photo);
  await page.locator('.sheet-panel img.preview').waitFor();
  if (note) await page.getByPlaceholder('כיתוב (לא חובה)').fill(note);
  await page.getByRole('button', { name: /זה נחשב/ }).click();
  await page.locator('.sheet-panel').waitFor({ state: 'detached' });
}

// Remove the newest photo straight through the API, as the given player.
const deleteNewest = (page) => page.evaluate(async (gameCode) => {
  const { token } = JSON.parse(localStorage.getItem('fw.sessions'))[gameCode];
  const auth = { Authorization: `Bearer ${token}` };
  const game = await (await fetch(`/api/games/${gameCode}`, { headers: auth })).json();
  return (await fetch(`/api/games/${gameCode}/entries/${game.entries.at(-1).id}`, { method: 'DELETE', headers: auth })).status;
}, currentCode);
let currentCode = '';

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

try {
  const photos = {
    beer: await fakePhoto('🍺', '#c98a1a'), food: await fakePhoto('🍔', '#8a3b1a'),
    beach: await fakePhoto('🏖️', '#1a7fa8'), view: await fakePhoto('🌄', '#3a5a2a'),
  };

  // --- the boss creates a game ---
  const boss = await phone('boss');
  await boss.goto(base);
  assert.equal(await boss.getByText('null', { exact: true }).count(), 0);
  await shot(boss, '01-home');
  await boss.getByRole('button', { name: 'להקים משחק חדש' }).click();
  await boss.locator('.toast.show.bad').waitFor(); // no name yet
  await boss.getByPlaceholder('השם שלך').fill('שירן');
  await boss.getByRole('button', { name: 'להקים משחק חדש' }).click();
  await boss.getByPlaceholder(/המשחק של/).fill('סופ״ש באילת');
  await boss.locator('.chip', { hasText: 'לשתות מים' }).click(); // drop water
  await boss.getByLabel('אימוג׳י').fill('🍕');
  await boss.getByLabel('שם האתגר').fill('לאכול פיצה');
  await boss.getByRole('button', { name: 'הוספה' }).click();
  await shot(boss, '02-create');
  await boss.getByRole('button', { name: 'להקים משחק', exact: true }).click();
  await boss.locator('.code').waitFor();
  const code = (await boss.locator('.code').textContent()).trim();
  assert.match(code, /^[A-Z2-9]{6}$/);
  currentCode = code;

  // --- two friends join: one by code, one by invite link ---
  const dana = await phone('dana');
  await dana.goto(base);
  await dana.getByPlaceholder('השם שלך').fill('דנה');
  await dana.getByPlaceholder('קוד משחק').fill(code.toLowerCase());
  await dana.getByRole('button', { name: 'להצטרף למשחק' }).click();
  await dana.getByText('ברשימת ההמתנה').waitFor();
  await shot(dana, '03-waiting');

  const yossi = await phone('yossi');
  await yossi.goto(`${base}/#/join/${code}`);
  assert.equal(await yossi.getByPlaceholder('קוד משחק').inputValue(), code);
  await yossi.getByPlaceholder('השם שלך').fill('יוסי');
  await yossi.getByRole('button', { name: 'להצטרף למשחק' }).click();
  await yossi.getByText('ברשימת ההמתנה').waitFor();

  // --- the boss sees the waiting list and lets them in ---
  await boss.getByText('רשימת המתנה (2)').waitFor();
  await shot(boss, '04-lobby-waiting-list');
  await boss.getByRole('button', { name: 'להכניס את דנה' }).click();
  await dana.getByText('מחכים שהבוס יתחיל').waitFor();
  await boss.getByRole('button', { name: 'להכניס את יוסי' }).click();
  await yossi.getByText('בקבוצה (3)').waitFor();
  await shot(yossi, '05-lobby-member');
  assert.equal(await dana.getByRole('button', { name: /להתחיל את המשחק/ }).count(), 0); // only the boss starts

  // --- start ---
  await boss.locator('#hours').selectOption('24');
  await boss.getByRole('button', { name: /להתחיל את המשחק/ }).click();
  for (const p of [boss, dana, yossi]) await p.locator('.action').first().waitFor();
  assert.equal(await dana.locator('.action').count(), 6); // 5 defaults (no water) + pizza
  assert.equal(await dana.locator('.action', { hasText: 'לשתות מים' }).count(), 0);
  await dana.locator('#timer').waitFor();

  // --- play: no photo, no point ---
  await addPoint(dana, 'לשתות בירה', photos.beer, 'לחיים! 🍻');
  await addPoint(dana, 'לשתות בירה', photos.beer);
  await addPoint(dana, 'להיות בים', photos.beach);
  await addPoint(yossi, 'לאכול פיצה', photos.food, 'משולש שלישי');
  await addPoint(yossi, 'לצלם נוף', photos.view);
  await addPoint(boss, 'לשתות בירה', photos.beer);
  assert.equal((await dana.locator('.action', { hasText: 'לשתות בירה' }).locator('.action-count').textContent()).trim(), '2');
  await dana.locator('.toast').waitFor({ state: 'visible' });
  await dana.waitForTimeout(2300); // let the confetti fall
  await shot(dana, '06-play');

  // Picking a file and closing the sheet gives nothing.
  {
    clock += 4000;
    const chooser = yossi.waitForEvent('filechooser');
    await yossi.locator('.action', { hasText: 'לשתות בירה' }).click();
    await (await chooser).setFiles(photos.beer);
    await yossi.locator('.sheet-panel img.preview').waitFor();
    await yossi.getByRole('button', { name: 'סגירה' }).click();
    assert.equal((await yossi.locator('.action', { hasText: 'לשתות בירה' }).locator('.action-count').textContent()).trim(), '0');
  }

  // --- updates from others must not disturb what you are doing ---
  {
    await yossi.getByRole('tab', { name: /גלריה/ }).click();
    await yossi.locator('.tile').first().waitFor();
    const chips = yossi.locator('.chips.scroll');
    await chips.evaluate((el) => { el.scrollLeft = -150; }); // RTL: scrolling goes negative
    const before = await chips.evaluate((el) => el.scrollLeft);
    assert.notEqual(before, 0);
    await yossi.evaluate(() => { document.querySelector('.tile').dataset.mark = 'same'; });
    // The boss looks at the game again (a state push with nothing new): nothing is rebuilt.
    await boss.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await yossi.waitForTimeout(400);
    assert.equal(await yossi.locator('.tile[data-mark=same]').count(), 1);
    // A picker is open when a new photo arrives: the list waits, then catches up; the chips stay put.
    await yossi.locator('main select').focus();
    await addPoint(boss, 'לשתות בירה', photos.beer);
    await yossi.waitForTimeout(400);
    assert.equal(await yossi.locator('.tile').count(), 6);
    await yossi.locator('main select').blur();
    await yossi.getByRole('tab', { name: 'גלריה (7)' }).waitFor();
    assert.equal(await yossi.locator('.tile').count(), 7);
    assert.equal(await yossi.locator('.chips.scroll').evaluate((el) => el.scrollLeft), before);
    assert.equal(await deleteNewest(boss), 200); // the boss takes that extra photo back, so the story below is unchanged
    await yossi.getByRole('tab', { name: 'גלריה (6)' }).waitFor();
    await yossi.getByRole('tab', { name: 'משחק' }).click();
  }

  // --- live board ---
  await boss.getByRole('tab', { name: 'טבלה' }).click();
  await boss.locator('.rank').first().waitFor();
  const names = await boss.locator('.rank .row-main > span:first-child').allTextContents();
  assert.deepEqual(names, ['דנה', 'יוסי', 'שירן']);
  await shot(boss, '07-board');
  await boss.locator('.chip', { hasText: 'לשתות בירה' }).click();
  assert.deepEqual(await boss.locator('.rank .count').allTextContents(), ['2', '1', '0']);

  // --- gallery + lightbox ---
  await yossi.getByRole('tab', { name: /גלריה/ }).click();
  await yossi.locator('.tile').first().waitFor();
  assert.equal(await yossi.locator('.tile').count(), 6);
  await yossi.waitForFunction(() => [...document.querySelectorAll('.tile img')].every((i) => i.complete && i.naturalWidth > 0));
  // The grid shows small copies (a few KB each), not the full photos.
  const sizes = await yossi.evaluate(() => [...document.querySelectorAll('.tile img')].map((i) => Math.max(i.naturalWidth, i.naturalHeight)));
  assert.equal(sizes.every((n) => n > 0 && n <= 320), true, String(sizes));
  await shot(yossi, '08-gallery');
  await yossi.locator('.chip', { hasText: 'לשתות בירה' }).click();
  assert.equal(await yossi.locator('.tile').count(), 3);
  await yossi.locator('select').selectOption({ label: 'דנה' });
  assert.equal(await yossi.locator('.tile').count(), 2);
  await yossi.locator('.tile').last().click();
  await yossi.getByText('לחיים! 🍻').waitFor();
  await yossi.waitForFunction(() => document.querySelector('.sheet-panel img.preview')?.naturalWidth > 320); // the full photo here
  assert.equal(await yossi.getByRole('button', { name: /למחוק/ }).count(), 0); // not his photo
  // Reactions: tap, it counts; the photo's owner sees it arrive; tap again takes it back.
  await yossi.getByRole('button', { name: '🔥 0' }).click();
  await yossi.getByRole('button', { name: '🔥 1', pressed: true }).waitFor();
  await yossi.getByRole('button', { name: '🍻 0' }).click();
  await yossi.getByRole('button', { name: '🍻 1', pressed: true }).waitFor();
  await yossi.getByRole('button', { name: '🔥 1' }).click();
  await yossi.getByRole('button', { name: '🔥 0', pressed: false }).waitFor();
  await dana.getByRole('tab', { name: /גלריה/ }).click();
  await dana.locator('.tile-react', { hasText: '🍻 1' }).waitFor();
  await dana.getByRole('tab', { name: 'משחק' }).click();
  await shot(yossi, '09-lightbox');
  await yossi.getByRole('button', { name: 'סגירה' }).click();

  // --- a latecomer joins mid-game; the boss lets him in from the game screen ---
  const late = await phone('late');
  await late.goto(`${base}/#/join/${code}`);
  await late.getByPlaceholder('השם שלך').fill('מאחר');
  await late.getByRole('button', { name: 'להצטרף למשחק' }).click();
  await late.getByText('ברשימת ההמתנה').waitFor();
  await boss.getByRole('button', { name: 'להכניס את מאחר' }).click();
  await late.locator('.action').first().waitFor();

  // --- bad reception: the player is told, nothing gets stuck, and the retry works ---
  {
    const net = late.locator('#net');
    assert.equal(await net.isVisible(), false);
    await late.context().setOffline(true);
    await net.waitFor({ state: 'visible' });
    clock += 4000;
    const chooser = late.waitForEvent('filechooser');
    await late.locator('.action', { hasText: 'להיות במסיבה' }).click();
    await (await chooser).setFiles(photos.beach);
    await late.getByRole('button', { name: /זה נחשב/ }).click();
    await late.getByRole('button', { name: 'לנסות שוב' }).waitFor(); // failed, the photo is still here
    await late.locator('.toast.show.bad').waitFor();
    await late.context().setOffline(false);
    await net.waitFor({ state: 'hidden', timeout: 20000 });
    await late.getByRole('button', { name: 'לנסות שוב' }).click();
    await late.locator('.sheet-panel').waitFor({ state: 'detached' });
    assert.equal((await late.locator('.action', { hasText: 'להיות במסיבה' }).locator('.action-count').textContent()).trim(), '1');
    assert.equal(await deleteNewest(boss), 200); // keep the story below unchanged
    await late.getByRole('tab', { name: 'גלריה (6)' }).waitFor();
  }

  // --- a hostile player: markup in the name and in a caption must stay plain text ---
  const evil = await phone('evil');
  const payload = '<img src=x onerror="window.__xss=1">';
  await evil.goto(`${base}/#/join/${code}`);
  await evil.getByPlaceholder('השם שלך').fill(payload.slice(0, 20));
  await evil.getByRole('button', { name: 'להצטרף למשחק' }).click();
  await evil.getByText('ברשימת ההמתנה').waitFor();
  await boss.getByText('רשימת המתנה (1)').waitFor();
  await boss.locator('.waiting-card .row .btn.primary').click();
  await evil.locator('.action').first().waitFor();
  await addPoint(evil, 'להיות במסיבה', photos.food, '<script>window.__xss=1</script><img src=x onerror=window.__xss=1>');
  await boss.getByRole('tab', { name: /גלריה \(7\)/ }).waitFor();
  await boss.getByRole('tab', { name: 'טבלה' }).click();
  await boss.getByText('<img src=x onerror=', { exact: false }).first().waitFor(); // shown literally
  await boss.getByRole('tab', { name: /גלריה/ }).click();
  await boss.locator('.tile').first().click();
  await boss.getByText('<script>window.__xss=1</script>', { exact: false }).waitFor();
  for (const p of [boss, dana, yossi, late, evil]) {
    assert.equal(await p.evaluate(() => window.__xss), undefined);
    assert.equal(await p.locator('main img[src="x"], #sheet img[src="x"], main script').count(), 0);
  }
  // The hostile photo is the newest one; the boss removes it and then the player.
  await boss.getByRole('button', { name: /למחוק/ }).click();
  await boss.getByRole('button', { name: 'למחוק', exact: true }).click();
  await boss.getByRole('tab', { name: 'גלריה (6)' }).waitFor();
  await boss.getByRole('tab', { name: 'משחק' }).click();

  // --- the boss deletes a suspicious photo ---
  await boss.getByRole('tab', { name: /גלריה/ }).click();
  await boss.locator('.tile').first().click();
  await boss.getByRole('button', { name: /למחוק/ }).click();
  await boss.getByRole('button', { name: 'למחוק', exact: true }).click();
  await boss.getByRole('tab', { name: 'גלריה (5)' }).waitFor();

  // --- reload keeps you in the game ---
  await dana.reload();
  await dana.locator('.action').first().waitFor();
  assert.equal((await dana.locator('.stat strong').first().textContent()).trim(), '3');

  // --- the end ---
  await boss.getByRole('tab', { name: 'משחק' }).click();
  await boss.getByRole('button', { name: /לסיים את המשחק/ }).click();
  await boss.getByRole('button', { name: 'לסיים', exact: true }).click();
  for (const p of [boss, dana, yossi, late]) await p.locator('.winner').waitFor();
  assert.equal((await dana.locator('.winner h2').textContent()).trim(), 'דנה');
  await dana.waitForTimeout(2300);
  await shot(dana, '10-results');
  await dana.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await shot(dana, '11-results-bottom');
  await dana.locator('.row.link', { hasText: 'להיות בים' }).click(); // category champion -> its gallery
  assert.equal(await dana.locator('.tile').count(), 1);
  assert.equal(await dana.locator('.action').count(), 0); // no more points

  // --- home lists the game ---
  await dana.getByRole('button', { name: 'חזרה לדף הבית' }).click();
  await dana.getByText('המשחקים שלי').waitFor();
  await dana.getByRole('button', { name: /סופ״ש באילת/ }).click();
  await dana.locator('.winner').waitFor();

  for (const p of [boss, dana, yossi, late]) assert.equal(await p.getByText('null', { exact: true }).count(), 0);
  // No secret ever travels in a URL (logs, history, Referer).
  const tokens = await Promise.all([boss, dana, yossi, late].map((p) => p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('fw.sessions'))).map((x) => x.token))));
  for (const token of tokens.flat()) assert.equal(urls.some((u) => u.includes(token)), false);
  assert.equal(urls.some((u) => /[?&]token=/.test(u)), false);
  // --- rematch: the boss opens another round, dana walks straight in, same challenges ---
  assert.equal(await dana.getByRole('button', { name: /משחק החוזר/ }).count(), 0); // nothing to join yet
  await boss.getByRole('button', { name: /משחק חוזר/ }).click();
  await boss.locator('.code').waitFor();
  const code2 = (await boss.locator('.code').textContent()).trim();
  assert.notEqual(code2, code);
  await dana.getByRole('button', { name: /להצטרף למשחק החוזר/ }).click();
  await dana.getByText('בקבוצה (2)').waitFor(); // in the lobby, not on the waiting list
  await boss.getByText('בקבוצה (2)').waitFor();
  assert.equal(await boss.locator('.waiting-card').count(), 0);
  assert.equal(await dana.locator('.chip.static').count(), 6);
  await shot(dana, '12-rematch-lobby');
  await boss.getByRole('button', { name: /להתחיל את המשחק/ }).click();
  await dana.locator('.action').first().waitFor();
  assert.equal((await dana.locator('.stat strong').first().textContent()).trim(), '0'); // a clean slate
  // Back in the old game, the button now leads to the rematch.
  await dana.goto(`${base}/#/g/${code}`);
  await dana.getByRole('button', { name: /למשחק החוזר/ }).click();
  await dana.locator('.action').first().waitFor();

  assert.deepEqual(errors, []);
  console.log(`e2e ok - game ${code}, screenshots in ${SHOTS}`);
} catch (e) {
  console.error('page errors:', errors);
  throw e;
} finally {
  await browser.close();
  app.server.closeAllConnections();
  await new Promise((r) => app.server.close(r));
  await app.flush();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
