// Reader-name onboarding and the admin panel. (Reviews themselves live on the book page: explore.js.)

import * as fb from './firebase.js';
import * as syncer from './syncer.js';
import { h, sheet, toast } from './dom.js';
import { normaliseHandle, handleProblem, REPORT_REASONS } from './social.js';

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
              // reports carry a 2.0 book key, or a bare 1.x Open Library work id
              const key = /^OL\d+W$/.test(r.workId) ? `ol:${r.workId}` : r.workId;
              await fb.deleteReview2(key, r.reviewerUid).catch(() => {});
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
