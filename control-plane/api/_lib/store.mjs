// Where the published mirror lives.
//
// One document, replaced whole on every publish. There is no history here on
// purpose: DC-2026-003 makes the published projection a disposable mirror, not
// a record of origin. The canonical record stays on the factory machine and in
// GitHub, so keeping versions would create a second, weaker copy of company
// history on a third party for no benefit.
//
// The store is a PRIVATE Vercel Blob store. That is load-bearing, not a
// preference: a public blob is readable by anyone who learns its URL, which
// would route around the viewer gate entirely. Verified against the live store
// — an anonymous GET of the exact blob URL returns 403.

// Loaded on demand rather than at module scope.
//
// A static `import { head, put } from "@vercel/blob"` made the whole package a
// prerequisite for merely IMPORTING a route. control-plane/ carries its own
// package.json, its node_modules is gitignored, and nothing in the repository
// installs it — `npm run setup` covers dashboard/backend only. So in any fresh
// checkout, which is exactly what a factory agent worktree is, importing
// api/mirror.mjs threw ERR_MODULE_NOT_FOUND and took TEN tests down with it,
// including every auth guard on this public endpoint: "an unauthenticated read
// is refused", "a wrong write credential is refused", "no response body ever
// contains a credential".
//
// Those tests did not fail, which would have been survivable — they never ran.
// A missing dependency and broken authentication are indistinguishable in that
// state, on the one surface of this system that faces the internet.
//
// Nothing here needs the package until a blob call actually happens, and
// token() already fails closed before that point, so the import moves to the
// call sites and the routes stay importable anywhere.
let blobModule;
async function blob() {
  if (!blobModule) {
    try {
      blobModule = await import("@vercel/blob");
    } catch (error) {
      // Fail closed, like a missing token: `unconfigured` is what mirror.mjs
      // turns into a 503. A store we cannot reach must never read as an empty
      // mirror or an open one.
      const missing = new Error("@vercel/blob is not installed — run `npm install` in control-plane/");
      missing.code = "unconfigured";
      missing.cause = error;
      throw missing;
    }
  }
  return blobModule;
}

// Fixed pathname, overwritten in place. A random suffix would leave the newest
// snapshot unfindable without an index, and an index is a second thing to keep
// consistent.
const PATHNAME = "mirror/current.json";

export const MIRROR_CONTRACT = "hq.mirror/1";

function token() {
  const value = process.env.BLOB_READ_WRITE_TOKEN;
  if (!value) {
    const error = new Error("BLOB_READ_WRITE_TOKEN is not configured");
    error.code = "unconfigured";
    throw error;
  }
  return value;
}

// "Not found" reaches us in more than one shape depending on how the SDK wraps
// the store's response, so this checks the name, the status and the message
// rather than trusting one of them. Deliberately narrow otherwise: anything
// that is not recognisably a miss must keep throwing.
export function isNotFound(error) {
  if (!error) return false;
  if (error.status === 404 || error.statusCode === 404) return true;
  const name = String(error.name || "");
  if (name === "BlobNotFoundError" || name.includes("NotFound")) return true;
  return /\b(not found|no such (?:blob|key|object)|does not exist)\b/i.test(String(error.message || ""));
}

// One blob per task, under a prefix — the same shape _lib/queue.mjs uses for
// intents, and for the same reason: a fixed single document cannot be addressed
// per record, and PATHNAME above is deliberately fixed.
const TASK_PREFIX = "mirror/tasks/";

// A task id reaches this from a query string, so it is validated as a path
// segment before it is ever concatenated into a blob key. Anything else is a
// miss, never a traversal.
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function taskPathname(taskId) {
  const id = String(taskId || "");
  if (!TASK_ID.test(id)) return null;
  return `${TASK_PREFIX}${id}.json`;
}

export async function writeTaskDetail(taskId, detail) {
  const authorization = token();
  const pathname = taskPathname(taskId);
  if (!pathname) throw new Error("invalid task id");
  const { put } = await blob();
  const body = JSON.stringify(detail);
  const result = await put(pathname, body, {
    access: "private", contentType: "application/json", allowOverwrite: true,
    addRandomSuffix: false, cacheControlMaxAge: 0, token: authorization,
  });
  return { pathname: result.pathname, size: body.length };
}

export async function readTaskDetail(taskId) {
  const authorization = token();
  const pathname = taskPathname(taskId);
  if (!pathname) return null;
  const { head } = await blob();
  let meta;
  try {
    meta = await head(pathname, { token: authorization });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (!meta?.downloadUrl && !meta?.url) return null;
  const response = await fetch(meta.downloadUrl || meta.url, {
    headers: { authorization: `Bearer ${authorization}` }, cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`blob read failed: ${response.status}`);
  return await response.json();
}

export async function writeSnapshot(snapshot) {
  // Before the package load, so an unconfigured deployment still reports a
  // missing token rather than a missing module.
  const authorization = token();
  const { put } = await blob();
  const body = JSON.stringify(snapshot);
  const result = await put(PATHNAME, body, {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
    // The mirror must never be served from an edge cache: a viewer reading a
    // cached copy would be told an age that is not the snapshot's own.
    cacheControlMaxAge: 0,
    token: authorization,
  });
  return { pathname: result.pathname, size: body.length };
}

export async function readSnapshot() {
  const authorization = token();
  const { head } = await blob();
  let meta;
  try {
    meta = await head(PATHNAME, { token: authorization });
  } catch (error) {
    // No snapshot yet is an ordinary state, not a failure — it is what the
    // control plane shows until the publisher first runs.
    //
    // Matching on `error.name === "BlobNotFoundError"` alone was not enough:
    // against the live store an empty mirror produced a 502 "mirror
    // unavailable" instead of the empty state, because the thrown error did not
    // carry that exact name. The empty state is the FIRST thing a new
    // deployment shows, so getting it wrong means the control plane looks
    // broken on day one and correct ever after — the hardest kind of bug to
    // notice later.
    //
    // So the match is widened to every shape "not found" arrives in, and only
    // that. A credential or transport failure still throws, because reporting
    // "nothing published yet" for an unreachable store would be a lie that
    // looks like calm.
    if (isNotFound(error)) return null;
    throw error;
  }
  if (!meta?.downloadUrl && !meta?.url) return null;

  // A private blob requires the token on the read as well; the URL alone is
  // not a capability.
  const response = await fetch(meta.downloadUrl || meta.url, {
    headers: { authorization: `Bearer ${authorization}` },
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`blob read failed: ${response.status}`);
  return await response.json();
}
