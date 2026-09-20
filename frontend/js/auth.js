import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut
} from 'firebase/auth';
import { firebaseConfig, isFirebaseConfigured } from './config.js';

const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

export const authReady = new Promise((resolve) => {
  if (!auth) {
    resolve(null);
    return;
  }
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    unsubscribe();
    resolve(user);
  });
});

export function observeAuth(callback) {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

export async function signInWithGoogle() {
  if (!auth) {
    throw new Error('Firebase Authentication is not configured');
  }
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOut() {
  if (auth) await firebaseSignOut(auth);
}

export async function requireAuthenticatedUser({ interactive = true } = {}) {
  await authReady;
  if (auth?.currentUser) return auth.currentUser;
  if (!interactive) throw new Error('Sign in with Google to continue');
  return signInWithGoogle();
}

export function displayNameFor(user) {
  return user?.displayName || user?.email?.split('@')[0] || 'Verified participant';
}
