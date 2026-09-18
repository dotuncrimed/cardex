import { auth, db, isFirebaseConfigured } from "./firebase.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { DUMMY_EMAIL_DOMAIN, DEFAULT_STARTING_CASH } from "./config.js";

const authListeners = [];

function sanitizeUsername(username) {
  return String(username || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function usernameToDummyEmail(username) {
  return `${sanitizeUsername(username)}${DUMMY_EMAIL_DOMAIN}`;
}

function usernameFromEmail(email) {
  return email.split("@")[0];
}

function notifyAuthListeners(user) {
  authListeners.forEach((listener) => listener(user));
}

async function ensureUserDocument(username, uid) {
  const userRef = doc(db, "users", username);
  const snap = await getDoc(userRef);

  if (!snap.exists()) {
    await setDoc(userRef, {
      username,
      uid,
      displayName: username,
      cash: DEFAULT_STARTING_CASH,
      wins: 0,
      losses: 0,
      draws: 0,
      games: 0,
      points: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }
}

export function watchAuth(callback) {
  authListeners.push(callback);

  if (!isFirebaseConfigured) {
    setTimeout(() => callback(null), 0);
    return;
  }

  onAuthStateChanged(auth, (firebaseUser) => {
    if (!firebaseUser) {
      callback(null);
      return;
    }

    callback({
      uid: firebaseUser.uid,
      username: usernameFromEmail(firebaseUser.email),
      email: firebaseUser.email
    });
  });
}

export async function loginOrRegister(username, pin) {
  username = sanitizeUsername(username);

  if (!username) {
    throw new Error("Username is required.");
  }

  if (!pin || pin.length < 6) {
    throw new Error("PIN must be at least 6 characters.");
  }

  if (!isFirebaseConfigured) {
    throw new Error("Firebase is not configured. Edit /js/config.js.");
  }

  const email = usernameToDummyEmail(username);

  try {
    await signInWithEmailAndPassword(auth, email, pin);
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      const credential = await createUserWithEmailAndPassword(auth, email, pin);
      await ensureUserDocument(username, credential.user.uid);
      return;
    }

    if (
      error.code === "auth/invalid-credential" ||
      error.code === "auth/invalid-login-credentials"
    ) {
      try {
        const credential = await createUserWithEmailAndPassword(auth, email, pin);
        await ensureUserDocument(username, credential.user.uid);
        return;
      } catch (createError) {
        if (createError.code === "auth/email-already-in-use") {
          throw new Error("Incorrect PIN for this username.");
        }

        throw createError;
      }
    }

    if (error.code === "auth/wrong-password") {
      throw new Error("Incorrect PIN for this username.");
    }

    throw error;
  }
}

export async function logoutUser() {
  if (!isFirebaseConfigured) return;

  await signOut(auth);
}
