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

import { head, put } from "@vercel/blob";

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

export async function writeSnapshot(snapshot) {
  const body = JSON.stringify(snapshot);
  const result = await put(PATHNAME, body, {
    access: "private",
    contentType: "application/json",
    allowOverwrite: true,
    addRandomSuffix: false,
    // The mirror must never be served from an edge cache: a viewer reading a
    // cached copy would be told an age that is not the snapshot's own.
    cacheControlMaxAge: 0,
    token: token(),
  });
  return { pathname: result.pathname, size: body.length };
}

export async function readSnapshot() {
  let meta;
  try {
    meta = await head(PATHNAME, { token: token() });
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
    headers: { authorization: `Bearer ${token()}` },
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`blob read failed: ${response.status}`);
  return await response.json();
}
