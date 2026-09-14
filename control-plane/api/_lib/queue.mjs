// The founder intent queue, as seen from the control plane.
//
// One blob per intent, never a shared queue document. A single document would
// need read-modify-write, and the browser enqueuing while the machine claims
// would race to overwrite each other. Unique keys remove the race instead of
// managing it.
//
// Claiming is `put` with `allowOverwrite: false` against the claimed key: the
// store decides who wins, and the loser is told. That is a real once-only
// primitive rather than a check-then-act, which is what "claiming is idempotent
// and once-only under duplicate delivery and replay" actually requires.
//
// WHAT THIS MODULE DOES NOT DO: validate an intent against the allowlist. That
// lives in `factory/lib/integrations/intent-protocol.mjs`, on the machine, and
// it must stay there. Copying the allowlist here would create a second
// definition of what the founder may ask for, and the two would drift — at
// which point the control plane would be accepting things the machine refuses,
// or worse, the reverse. The machine never trusts the network; it re-validates
// everything it claims. A test asserts no allowlist appears in this tree.
//
// What IS enforced here is shape and size: enough to stop the store being
// filled with junk by a stolen session, and nothing that pretends to be
// security.

// Loaded on demand, never at module scope — the same rule _lib/store.mjs
// follows, and the one factory/test/control-plane-routes-importable.test.mjs
// enforces across this whole tree.
//
// A static import here makes the package a prerequisite for merely IMPORTING a
// route, and control-plane/node_modules is gitignored and installed by nothing
// the test suite runs. That does not fail the auth tests on this public
// endpoint, it stops them being collected at all — which is strictly worse,
// because a missing dependency then looks exactly like passing auth. That is
// what #209 fixed; this keeps the new queue on the right side of it.
let blobModule;
async function blob() {
  if (!blobModule) {
    try {
      blobModule = await import("@vercel/blob");
    } catch (error) {
      // Fail closed, exactly like a missing token: `unconfigured` is what the
      // routes turn into a 503. A queue we cannot reach must never read as an
      // empty queue.
      const missing = new Error("@vercel/blob is not installed — run `npm install` in control-plane/");
      missing.code = "unconfigured";
      missing.cause = error;
      throw missing;
    }
  }
  return blobModule;
}

const PENDING = "intents/pending/";
const CLAIMED = "intents/claimed/";
const RESULTS = "intents/results/";

// An intent names an action and carries typed arguments. It is never large.
const MAX_INTENT_BYTES = 16 * 1024;
const MAX_ARG_LENGTH = 8000;
const MAX_ARGS = 12;
const MAX_PENDING = 200;

function token() {
  const value = process.env.BLOB_READ_WRITE_TOKEN;
  if (!value) {
    const error = new Error("BLOB_READ_WRITE_TOKEN is not configured");
    error.code = "unconfigured";
    throw error;
  }
  return value;
}

export function isNotFound(error) {
  if (!error) return false;
  if (error.status === 404 || error.statusCode === 404) return true;
  const name = String(error.name || "");
  if (name === "BlobNotFoundError" || name.includes("NotFound")) return true;
  return /\b(not found|no such (?:blob|key|object)|does not exist)\b/i.test(String(error.message || ""));
}

// Generic shape checks only — deliberately no knowledge of which kinds exist.
export function checkShape(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    return "intent must be an object";
  }
  if (typeof intent.kind !== "string" || !/^[a-z][a-z0-9.-]{1,60}$/.test(intent.kind)) {
    return "kind must be a short lowercase identifier";
  }
  const args = intent.args ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "args must be an object";
  }
  const keys = Object.keys(args);
  if (keys.length > MAX_ARGS) return `at most ${MAX_ARGS} arguments`;
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return `argument ${key} must be a string, number or boolean`;
    }
    if (typeof value === "string" && value.length > MAX_ARG_LENGTH) {
      return `argument ${key} is too long`;
    }
  }
  if (JSON.stringify(intent).length > MAX_INTENT_BYTES) return "intent is too large";
  return null;
}

async function readBlob(url) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token()}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`blob read failed: ${response.status}`);
  return await response.json();
}

/** Enqueue one intent. Returns its id. */
export async function enqueue({ kind, args = {}, requestedBy = "founder", now = new Date().toISOString() }) {
  // token() before the package load, so an unconfigured deployment reports a
  // missing token rather than a missing module.
  const authorization = token();
  const { list, put } = await blob();
  const pending = await list({ prefix: PENDING, token: authorization, limit: MAX_PENDING + 1 });
  if ((pending.blobs || []).length > MAX_PENDING) {
    const error = new Error("intent queue is full");
    error.code = "queue_full";
    throw error;
  }

  // Time-ordered id so a listing is roughly chronological without an index.
  const id = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  const record = { version: 1, id, kind, args, requestedBy, requestedAt: now, status: "pending" };

  await put(`${PENDING}${id}.json`, JSON.stringify(record), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 0,
    token: authorization,
  });
  return id;
}

/** Every pending intent, oldest first. */
export async function listPending({ limit = 50 } = {}) {
  const authorization = token();
  const { list } = await blob();
  const pending = await list({ prefix: PENDING, token: authorization, limit });
  const blobs = (pending.blobs || []).slice().sort((a, b) => a.pathname.localeCompare(b.pathname));
  const out = [];
  for (const blob of blobs) {
    try {
      out.push(await readBlob(blob.downloadUrl || blob.url));
    } catch {
      // A single unreadable entry must not stop the queue draining.
    }
  }
  return out;
}

/**
 * Claim one intent. Once-only: the store refuses a second write to the same
 * claimed key, so a duplicate delivery or a replayed poll loses rather than
 * running the action twice.
 */
export async function claim(id, { claimedBy = "factory-machine", now = new Date().toISOString() } = {}) {
  const authorization = token();
  const { del, head, put } = await blob();
  let record;
  try {
    const meta = await head(`${PENDING}${id}.json`, { token: authorization });
    record = await readBlob(meta.downloadUrl || meta.url);
  } catch (error) {
    if (isNotFound(error)) return null; // already claimed, or never existed
    throw error;
  }

  const claimed = { ...record, status: "claimed", claimedBy, claimedAt: now };
  try {
    await put(`${CLAIMED}${id}.json`, JSON.stringify(claimed), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      // The whole point: the store, not this code, decides who claimed it.
      allowOverwrite: false,
      cacheControlMaxAge: 0,
      token: authorization,
    });
  } catch {
    return null; // someone already claimed it
  }

  // Only after the claim is durable. If this delete fails the intent is claimed
  // and still listed, which a second claim attempt then refuses — noisy, but
  // never a double execution.
  await del(`${PENDING}${id}.json`, { token: authorization }).catch(() => {});
  return claimed;
}

/** Record what happened. Terminal; never read back into the pending queue. */
export async function report(id, { status, detail = null, now = new Date().toISOString() }) {
  const authorization = token();
  const { del, put } = await blob();
  const record = { version: 1, id, status, detail: detail ? String(detail).slice(0, 2000) : null, reportedAt: now };
  await put(`${RESULTS}${id}.json`, JSON.stringify(record), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
    token: authorization,
  });
  await del(`${CLAIMED}${id}.json`, { token: authorization }).catch(() => {});
  return record;
}

/** Recent results, for the founder to see what became of what they asked. */
export async function listResults({ limit = 50 } = {}) {
  const authorization = token();
  const { list } = await blob();
  const results = await list({ prefix: RESULTS, token: authorization, limit });
  const blobs = (results.blobs || []).slice().sort((a, b) => b.pathname.localeCompare(a.pathname));
  const out = [];
  for (const blob of blobs) {
    try {
      out.push(await readBlob(blob.downloadUrl || blob.url));
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

export const PREFIXES = { PENDING, CLAIMED, RESULTS };
export const LIMITS = { MAX_INTENT_BYTES, MAX_ARG_LENGTH, MAX_ARGS, MAX_PENDING };
