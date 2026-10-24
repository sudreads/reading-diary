// Filled in once, during the Google Cloud setup (see SETUP.md). Until then the app works fully
// offline and the status pill says Drive is not set up yet.
export const GOOGLE_CLIENT_ID = '1021103663138-3fje22cgmvrqo8nfq43scns6r7v9dl51.apps.googleusercontent.com';
// Left blank in public code: the first account he connects is confirmed once with a tap and
// remembered on the device.
export const EXPECTED_EMAIL = '';
// The firebaseConfig object from the Firebase console (public by design; Firestore rules are the
// protection). null = public reviews switched off; the private diary works either way.
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAeN9QVmIiedyfaOH0r8IOjoyk2qOC7xw4',
  authDomain: 'reading-diary-57f16.firebaseapp.com',
  projectId: 'reading-diary-57f16',
  storageBucket: 'reading-diary-57f16.firebasestorage.app',
  messagingSenderId: '1021103663138',
  appId: '1:1021103663138:web:84854645cb613b555b827b',
};
