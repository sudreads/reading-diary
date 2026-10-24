// Public reviews UI: the per-book reviews sheet, picking a handle, reporting, and the admin panel.

import * as fb from './firebase.js';
import * as syncer from './syncer.js';
import { h, sheet, toast } from './dom.js';
import { workIdOf, averageOf, normaliseHandle, handleProblem, REPORT_REASONS } from './social.js';

const monthYear = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '');

function starRow(n, cls = '') {
  return h('span', { class: `stars-inline ${cls}`, 'aria-label': `${n} of 5 stars` }, '★'.repeat(n), h('span', { class: 'off' }, '★'.repeat(5 - n)));
}

// What to show instead of reviews when this phone can't read them yet.
function gate() {
  const s = syncer.state;
  if (!fb.isConfigured()) return 'Public reviews are not switched on yet.';
  if (s.account === 'wrong-account') return 'This diary belongs to a different Google account.';
  if (s.account === 'needs-handle') return 'pick-handle';
  if (s.account !== 'ready') return 'sign-in';
  return '';
}

export function reviewsSheet(book) {
  const workId = workIdOf(book.olKey);
  const body = h('div', { class: 'form' });
  const close = sheet(`Reviews · ${book.title}`, body);
  if (!workId) {
    body.append(h('p', { class: 'muted' }, 'This book was added by hand, so it can\'t be matched with other readers. Add it from search to see and share reviews.'));
    return close;
  }
  const blocked = gate();
  if (blocked === 'sign-in') {
    body.append(h('p', null, 'Sign in with Google to see what other readers think.'),
      h('button', { class: 'btn primary', onclick: async () => { close(); await syncer.syncNow({ interactive: true }); reviewsSheet(book); } }, 'Sign in with Google'));
    return close;
  }
  if (blocked === 'pick-handle') {
    body.append(h('p', null, 'Pick your reader name first.'), h('button', { class: 'btn primary', onclick: () => { close(); handleSheet(() => reviewsSheet(book)); } }, 'Pick a name'));
    return close;
  }
  if (blocked) { body.append(h('p', { class: 'muted' }, blocked)); return close; }

  const summary = h('div', { class: 'review-summary' }, h('p', { class: 'muted' }, 'Loading reviews…'));
  const list = h('div', { class: 'review-list' });
  const more = h('button', { class: 'btn wide', hidden: true }, 'Load more');
  body.append(summary, list, more);
  let all = [];

  async function loadPage(after) {
    try {
      const page = await fb.listReviews(workId, after);
      all = all.concat(page);
      renderSummary();
      list.append(...page.map(reviewCard));
      more.hidden = page.length < 50;
      more.onclick = () => loadPage(all.at(-1));
    } catch (e) {
      summary.replaceChildren(h('p', { class: 'muted' }, navigator.onLine ? `Couldn't load reviews (${e.code || e.message}).` : 'You\'re offline - reviews need the internet.'));
    }
  }

  function renderSummary() {
    if (!all.length) { summary.replaceChildren(h('p', { class: 'muted' }, 'No reviews yet. Finish it and be the first!')); return; }
    const avg = averageOf(all);
    summary.replaceChildren(
      h('div', { class: 'big' }, avg.toFixed(1), ' ', starRow(Math.round(avg), 'lg')),
      h('div', { class: 'muted small' }, all.length >= 50 ? `from the latest ${all.length} reviews` : `${all.length} review${all.length === 1 ? '' : 's'}`));
  }

  function reviewCard(r) {
    const mine = r.uid === syncer.state.uid;
    const card = h('article', { class: `review${mine ? ' mine' : ''}` },
      h('div', { class: 'review-head' },
        h('strong', null, `@${r.handle}`), mine && h('span', { class: 'badge' }, 'You'),
        h('span', { class: 'muted small' }, monthYear(r.createdAt))),
      starRow(r.rating),
      r.text && h('p', { class: 'review-text' }, r.text),
      h('div', { class: 'review-tools' },
        !mine && h('button', { class: 'link-btn', onclick: () => reportSheet(r) }, 'Report'),
        (mine || syncer.state.admin) && h('button', { class: 'link-btn', onclick: async () => {
          if (!confirm(mine ? 'Delete your public review? Your private rating stays in your diary.' : `Delete @${r.handle}'s review for everyone?`)) return;
          try {
            await fb.deleteReview(workId, r.uid);
            card.remove();
            all = all.filter((x) => x !== r);
            renderSummary();
            if (mine) book.onUnpublish?.();
          } catch (e) { toast(`Couldn't delete (${e.code || e.message})`); }
        } }, 'Delete')));
    return card;
  }

  loadPage(null);
  return close;
}

function reportSheet(r) {
  const close = sheet('Report review', h('div', { class: 'form' },
    h('p', { class: 'muted small' }, `Reporting @${r.handle}'s review. The admin will look at it.`),
    Object.entries(REPORT_REASONS).map(([reason, label]) => h('button', { class: 'btn', onclick: async () => {
      try {
        await fb.report(r.workId, r.uid, syncer.state.uid, reason);
        toast('Reported - thanks');
      } catch (e) {
        toast(e.code === 'permission-denied' ? 'You already reported this one' : `Couldn't report (${e.code || e.message})`);
      }
      close();
    } }, label))));
}

// First sign-in: pick the permanent @handle.
export function handleSheet(then) {
  const input = h('input', { placeholder: 'e.g. sudreads', maxlength: '21', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false' });
  const status = h('p', { class: 'muted small' }, '3-20 characters: a-z, 0-9 and _');
  const go = h('button', { class: 'btn primary', disabled: true }, 'Use this name');
  let timer, checked = '';
  input.addEventListener('input', () => {
    const v = normaliseHandle(input.value);
    const problem = handleProblem(v);
    go.disabled = true;
    checked = '';
    clearTimeout(timer);
    if (problem) { status.textContent = v ? problem : '3-20 characters: a-z, 0-9 and _'; return; }
    status.textContent = 'Checking…';
    timer = setTimeout(async () => {
      try {
        const taken = await fb.handleTaken(v);
        if (normaliseHandle(input.value) !== v) return;
        status.textContent = taken ? `@${v} is taken` : `@${v} is free`;
        if (!taken) { checked = v; go.disabled = false; }
      } catch (e) { status.textContent = `Couldn't check (${e.code || e.message})`; }
    }, 400);
  });
  go.addEventListener('click', async () => {
    if (!checked) return;
    go.disabled = true;
    try {
      await syncer.claimHandle(checked);
      close();
      toast(`Welcome, @${checked}!`);
      then?.();
    } catch (e) {
      status.textContent = e.code === 'permission-denied' ? 'Someone just took that name - try another' : `Couldn't save (${e.code || e.message})`;
      go.disabled = false;
    }
  });
  const close = sheet('Pick your reader name', h('div', { class: 'form' },
    h('p', null, 'This is how other readers see your reviews. It can\'t be changed later, so pick one you like. Don\'t use your full real name.'),
    input, status, go,
    h('a', { href: 'privacy.html', target: '_blank', rel: 'noopener', class: 'muted small' }, 'What is public? Read the privacy page')));
}

export function adminPanel() {
  const box = h('div', { class: 'card' }, h('h2', null, '🛡 Admin: reports'), h('p', { class: 'muted small' }, 'Loading…'));
  fb.listReports().then((reports) => {
    box.replaceChildren(h('h2', null, '🛡 Admin: reports'),
      reports.length ? h('div', { class: 'stack' }, reports.map((r) => {
        const row = h('div', { class: 'report-row' },
          h('div', null, h('strong', null, REPORT_REASONS[r.reason] || r.reason), h('div', { class: 'muted small' }, `Book ${r.workId} · reviewer ${r.reviewerUid.slice(0, 6)}…`)),
          h('div', { class: 'actions' },
            h('button', { class: 'btn small', onclick: async () => {
              if (!confirm('Delete this review for everyone?')) return;
              await fb.deleteReview(r.workId, r.reviewerUid).catch(() => {});
              await fb.dismissReport(r.id).catch(() => {});
              row.remove();
            } }, 'Delete review'),
            h('button', { class: 'btn small ghost', onclick: async () => { await fb.dismissReport(r.id).catch(() => {}); row.remove(); } }, 'Dismiss')));
        return row;
      })) : h('p', { class: 'muted small' }, 'No open reports.'),
      h('a', { class: 'muted small', href: 'https://console.firebase.google.com/', target: '_blank', rel: 'noopener' }, 'Firebase console (usage and quota)'));
  }).catch((e) => box.replaceChildren(h('h2', null, '🛡 Admin'), h('p', { class: 'muted small' }, `Couldn't load reports (${e.code || e.message})`)));
  return box;
}
