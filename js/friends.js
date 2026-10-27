// Friends by @name: send a request, both accept, then each sees the other's small activity card
// (streak, reading now, last finished). Never notebook pages or comments.

import * as fb from './firebase.js';
import * as syncer from './syncer.js';
import * as store from './store.js';
import { h, fill, sheet, toast } from './dom.js';
import { localDate } from './derive.js';
import { activityCard, liveStreak } from './activity.js';
import { normaliseHandle, handleProblem } from './social.js';

// A friend's card with the streak as of today, not as of their last visit.
const activityOf = async (uid) => { const a = await fb.friendActivity(uid); return a && { ...a, streak: liveStreak(a) }; };

// Requests and friends list, kept for a minute: Me redraws on every sync, and each fetch is 3 reads.
// Anything you do here clears it (forget()), so your own changes always show at once.
let lists = { uid: '', at: 0, data: null };
const activityCache = { uid: '', at: 0, cards: [] };
function forget() { lists.at = 0; activityCache.at = 0; }
async function loadLists(uid) {
  if (lists.uid === uid && Date.now() - lists.at < 60 * 1000) return lists.data;
  const [{ incoming, outgoing }, friends] = await Promise.all([fb.friendRequests(uid), fb.friendsList(uid)]);
  lists = { uid, at: Date.now(), data: { incoming, outgoing, friends } };
  return lists.data;
}

const ready = () => syncer.state.checked && syncer.state.account === 'ready' && !!syncer.state.handle;

// Publishes the card only when it changed (one small write), and only once you have a reader name.
let publishTimer = null;
export function schedulePublish() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(publishActivity, 3000);
}
async function publishActivity() {
  if (!ready() || !navigator.onLine) return;
  const [books, sessions] = await Promise.all([store.list('books'), store.list('sessions')]);
  const card = activityCard({ handle: syncer.state.handle, books, sessions });
  const sig = JSON.stringify(card) + localDate(); // the streak can change at midnight without an edit
  if (sig === (await store.getMeta('activitySent', ''))) return;
  try {
    await fb.writeActivity(syncer.state.uid, card);
    await store.setMeta('activitySent', sig);
  } catch { /* offline or not yet allowed: tried again on the next change */ }
}

// ---------- friend profile sheet ----------

export async function friendSheet(friend, { cover, onChange } = {}) {
  const body = h('div', { class: 'form' }, h('p', { class: 'muted' }, 'Loading…'));
  const close = sheet(`@${friend.handle}`, body);
  let a = null;
  try { a = await activityOf(friend.uid); } catch { /* shown below */ }
  const bookLine = (label, b) => b && b.title && h('div', { class: 'row' }, cover({ title: b.title, coverUrl: b.coverUrl }, 'cover-sm'),
    h('div', null, h('div', { class: 'eyebrow' }, label), h('strong', null, b.title), b.rating ? h('div', { class: 'stars-inline' }, '★'.repeat(b.rating)) : null));
  fill(body,
    a ? h('div', { class: 'friend-stats' },
      h('div', null, h('div', { class: 'big' }, `${a.streak ? '🔥' : '🌱'} ${a.streak}`), h('div', { class: 'muted small' }, 'day streak')),
      h('div', null, h('div', { class: 'big' }, String(a.finishedCount)), h('div', { class: 'muted small' }, 'books finished')))
      : h('p', { class: 'muted' }, `@${friend.handle} hasn't shared any reading yet.`),
    a && bookLine('Reading now', a.currentBook),
    a && bookLine('Last finished', a.lastFinished),
    h('button', { class: 'btn ghost', onclick: async () => {
      if (!confirm(`Remove @${friend.handle} from your friends?`)) return;
      try { await fb.unfriend(syncer.state.uid, friend.uid); forget(); toast(`Removed @${friend.handle}`); close(); onChange?.(); } catch (e) { toast(`Couldn't remove (${e.code || e.message})`); }
    } }, 'Unfriend'));
}

// ---------- Me -> Friends ----------

export function friendsCard({ cover, rerender: redraw }) {
  const rerender = () => { forget(); redraw(); }; // your change shows here and in Explore at once
  const box = h('div', { class: 'card' }, h('h2', null, 'Friends'));
  if (!ready()) {
    box.append(h('p', { class: 'muted small' }, syncer.state.account === 'needs-handle' ? 'Pick your reader name first, then add friends by theirs.' : 'Sign in to add friends.'));
    return box;
  }
  const me = syncer.state;
  const input = h('input', { placeholder: 'Their reader name, e.g. sudreads', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '21' });
  const msg = h('p', { class: 'muted small' });
  const send = h('button', { class: 'btn primary', onclick: async () => {
    const handle = normaliseHandle(input.value);
    const problem = handleProblem(handle);
    if (problem) { msg.textContent = problem; return; }
    if (handle === me.handle) { msg.textContent = 'That\'s you!'; return; }
    send.disabled = true;
    try {
      const uid = await fb.uidForHandle(handle);
      if (!uid) { msg.textContent = `Nobody is called @${handle} yet.`; return; }
      const { incoming } = await fb.friendRequests(me.uid);
      const theirs = incoming.find((r) => r.from === uid);
      if (theirs) { await fb.acceptFriendRequest(me.uid, me.handle, theirs); toast(`You and @${handle} are friends now`); }
      else { await fb.sendFriendRequest(me.uid, me.handle, uid, handle); toast(`Request sent to @${handle}`); }
      input.value = '';
      rerender();
    } catch (e) {
      msg.textContent = e.code === 'permission-denied' ? `You're already friends with @${handle}, or a request is already waiting.` : `Couldn't send (${e.code || e.message}).`;
    } finally { send.disabled = false; }
  } }, 'Add');
  const listBox = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Loading…'));
  box.append(h('div', { class: 'add-friend' }, input, send), msg, listBox);
  const drop = (id, what) => async () => {
    try { await fb.deleteFriendRequest(id); } catch (e) { toast(`Couldn't ${what} (${e.code || e.message})`); }
    rerender();
  };

  (async () => {
    try {
      const { incoming, outgoing, friends } = await loadLists(me.uid);
      fill(listBox,
        ...incoming.map((r) => h('div', { class: 'request-row' }, h('span', { class: 'grow' }, h('strong', null, `@${r.fromHandle}`), ' wants to be friends'),
          h('button', { class: 'btn small primary', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { await fb.acceptFriendRequest(me.uid, me.handle, r); toast(`You and @${r.fromHandle} are friends now`); } catch (err) { toast(`Couldn't accept (${err.code || err.message})`); }
            rerender();
          } }, 'Accept'),
          h('button', { class: 'btn small ghost', onclick: drop(r.id, 'decline') }, 'Decline'))),
        ...outgoing.map((r) => h('div', { class: 'request-row' }, h('span', { class: 'grow muted' }, `Waiting for @${r.toHandle}`),
          h('button', { class: 'btn small ghost', onclick: drop(r.id, 'cancel') }, 'Cancel'))),
        friends.length
          ? h('div', { class: 'stack' }, friends.slice(0, 200).map((f) => h('button', { class: 'friend-row', onclick: () => friendSheet(f, { cover, onChange: rerender }) }, h('strong', null, `@${f.handle}`), h('span', { class: 'muted small' }, 'See reading ›'))))
          : (!incoming.length && !outgoing.length) && h('p', { class: 'muted small' }, 'No friends yet. Add a classmate by their reader name.'));
    } catch (e) {
      listBox.replaceChildren(h('p', { class: 'muted small' }, navigator.onLine ? `Couldn't load friends (${e.code || e.message}).` : 'You\'re offline.'));
    }
  })();
  return box;
}

// ---------- Explore -> what friends are reading ----------

export async function friendsActivity() {
  if (!ready()) return [];
  const uid = syncer.state.uid;
  if (activityCache.uid === uid && Date.now() - activityCache.at < 10 * 60 * 1000) return activityCache.cards;
  const friends = (await fb.friendsList(uid)).slice(0, 50); // first 50 by name (PLAN-v2)
  const cards = (await Promise.all(friends.map((f) => activityOf(f.uid).catch(() => null)))).filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  Object.assign(activityCache, { uid, at: Date.now(), cards });
  return cards;
}
