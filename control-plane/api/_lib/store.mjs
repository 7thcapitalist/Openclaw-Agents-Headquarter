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
    if (error?.name === "BlobNotFoundError" || error?.status === 404) return null;
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
