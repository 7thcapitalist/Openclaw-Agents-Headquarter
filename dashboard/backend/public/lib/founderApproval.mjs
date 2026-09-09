// Browser side of one-click founder approval.
//
// Generates and holds a NON-EXTRACTABLE Ed25519 signing key in IndexedDB,
// scoped to this origin. The private key can be used to sign but never read —
// not by this code, not by the server, not by the factory agents. Only the
// public key and signatures ever leave the browser.

const DB_NAME = "founder-approval";
const STORE = "keys";
const KEY_ID = "signing-keypair";

export function webcryptoEd25519Available() {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.subtle.generateKey === "function";
}

function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error || new Error("IndexedDB unavailable"));
  });
}

function idbGet(db, key) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    tx.onsuccess = () => res(tx.result);
    tx.onerror = () => rej(tx.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
    tx.onsuccess = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// The stored value is a CryptoKeyPair with a non-extractable privateKey;
// structured clone keeps it usable without ever exposing the bytes.
export async function loadLocalKeyPair() {
  try {
    const db = await openDb();
    const pair = await idbGet(db, KEY_ID);
    return pair && pair.privateKey ? pair : null;
  } catch {
    return null;
  }
}

export async function createLocalKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, /* extractable */ false, ["sign", "verify"]);
  const db = await openDb();
  await idbPut(db, KEY_ID, pair);
  return pair;
}

export async function clearLocalKeyPair() {
  try {
    const db = await openDb();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, "readwrite").objectStore(STORE).delete(KEY_ID);
      tx.onsuccess = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch { /* ignore */ }
}

function toBase64(bytes) {
  let s = "";
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 1) s += String.fromCharCode(a[i]);
  return btoa(s);
}

const PEM = (b64) => `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----\n`;

export async function exportPublicKeyPem(keyPair) {
  const spki = await crypto.subtle.exportKey("spki", keyPair.publicKey);
  return PEM(toBase64(spki));
}

// Sign the exact UTF-8 bytes of `payloadString` and return a base64 signature —
// the format factory/lib/task-workflow.mjs verify() expects.
export async function signPayloadString(keyPair, payloadString) {
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, new TextEncoder().encode(payloadString));
  return toBase64(sig);
}
