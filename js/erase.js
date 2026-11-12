// Deleting an account: the decisions, kept pure so every branch is tested without Firebase.
// The rule behind all of it: nothing is removed from the cloud unless the signed-in account is
// provably this diary's owner. Erasing the phone itself never needs a sign-in.

// What "Delete" or "Finish deleting" may do with the Google account that was just picked.
//   googleSub: the Google id of the token just obtained
//   sessionUid / sessionSub: the Firebase session on this phone right now ('' when none)
//   ownerUid / ownerSub: who this diary belongs to (ownerSub may be unknown: '')
// -> 'proceed'      the owner is signed in: delete
//    'sign-in'      no owner session: sign in with this token, then call afterSignIn()
//    'other-google' a different Google account was picked: change nothing, ask again
export function eraseIdentity({ googleSub, sessionUid, sessionSub, ownerUid, ownerSub }) {
  const hasOwnerSession = !!sessionUid && sessionUid === ownerUid;
  const expected = (hasOwnerSession && sessionSub) || ownerSub || '';
  if (expected && googleSub !== expected) return 'other-google';
  return hasOwnerSession ? 'proceed' : 'sign-in';
}

// After signing in with the picked Google account.
//   knewSub: we could check beforehand that it is the owner's Google account
// -> 'proceed'  it opened the owner's account
//    'gone'     the right Google account, but the reader account no longer exists
//    'unknown'  it opened some other account and we can't tell why: change nothing
export function afterSignIn({ uid, ownerUid, knewSub }) {
  if (uid === ownerUid) return 'proceed';
  return knewSub ? 'gone' : 'unknown';
}

// The words for every way it can stop. `fatal: false` means nothing was changed.
export const ERASE_MESSAGES = {
  offline: 'You\'re offline. Connect to the internet and try again.',
  'sign-in-failed': 'Couldn\'t sign in with Google. Nothing was changed - try again.',
  'other-google': 'That is a different Google account. Pick the one this diary belongs to.',
  unknown: 'That Google account doesn\'t open this diary. If you picked the wrong one, try again.',
  gone: 'This account can no longer be opened. Its diary and reviews were already removed from the cloud. You can erase this phone now.',
  drive: 'Couldn\'t remove your drawings from Google Drive. Try again.',
  blocked: 'Reading Diary is open in another tab. Close it, then try again.',
};
export const eraseMessage = (e) => ERASE_MESSAGES[e?.kind] || `It didn't finish (${e?.code || e?.message || 'unknown problem'}). Try again.`;
