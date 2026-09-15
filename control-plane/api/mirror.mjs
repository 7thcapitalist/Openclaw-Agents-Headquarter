// The mirror endpoint. Read by the founder, written by the factory machine.
//
// GET  — requires a viewer session (DC-2026-004)
// POST — requires the write credential (DC-2026-003)
//
// The two are checked by different functions against different secrets, and
// neither falls back to the other. A publisher token cannot read the mirror
// through this route, and a viewer session cannot write it.
//
// Node signature, because that is what Vercel's runtime calls. See _lib/http.mjs.

import { isPublisher, isViewer } from "./_lib/auth.mjs";
import { readText, requestLike, sendJson } from "./_lib/http.mjs";
import { MIRROR_CONTRACT, readSnapshot, writeSnapshot } from "./_lib/store.mjs";

// A projection of the whole dashboard is not small, but it is not a file
// upload either. This bounds what one publish can cost before anything is
// parsed.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// A refusal says nothing about why. "wrong password" and "no such credential"
// are the same answer, and a 401 never reports which secret was checked.
function refuse(res) {
  sendJson(res, 401, { error: "unauthorized" });
}

export default async function handler(req, res) {
  try {
    const request = requestLike(req);

    if (req.method === "GET") {
      if (!isViewer(request)) return refuse(res);
      const snapshot = await readSnapshot();
      if (!snapshot) return sendJson(res, 404, { error: "no snapshot published" });
      return sendJson(res, 200, snapshot);
    }

    if (req.method === "POST") {
      if (!isPublisher(request)) return refuse(res);

      let raw;
      try {
        raw = await readText(req, { maxBytes: MAX_BODY_BYTES });
      } catch (error) {
        if (error?.code === "too_large") {
          return sendJson(res, 413, { error: "snapshot too large", maxBytes: MAX_BODY_BYTES });
        }
        throw error;
      }

      let snapshot;
      try {
        snapshot = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: "body is not JSON" });
      }

      // Reject rather than coerce. A snapshot that does not declare the
      // contract is not one this viewer knows how to render, and storing it
      // anyway would put the renderer in front of data nobody agreed on.
      if (snapshot?.contract !== MIRROR_CONTRACT) {
        return sendJson(res, 422, {
          error: `contract must be ${MIRROR_CONTRACT}`,
          received: snapshot?.contract ?? null,
        });
      }
      if (typeof snapshot.publishedAt !== "string") {
        return sendJson(res, 422, { error: "publishedAt is required" });
      }

      const stored = await writeSnapshot(snapshot);
      return sendJson(res, 200, { ok: true, publishedAt: snapshot.publishedAt, bytes: stored.size });
    }

    return sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, POST" });
  } catch (error) {
    if (error?.code === "unconfigured") {
      // Say which variable is missing, never its value, and never fall open.
      return sendJson(res, 503, { error: "control plane is not configured", detail: error.message });
    }
    // The client-facing body stays generic — it faces the internet and must not
    // describe the store's internals. But collapsing the cause to a bare 502
    // server-side is itself a defect: on 2026-09-14 the blob store was
    // suspended and the publisher retried into this exact branch 1,350 times
    // over eleven hours, with the real reason ("This store has been suspended")
    // never written down anywhere. Log enough to diagnose, never the payload.
    console.error("[mirror] unhandled error", JSON.stringify({
      name: error?.name ?? null,
      message: String(error?.message ?? error).slice(0, 500),
      status: error?.status ?? error?.statusCode ?? null,
      code: error?.code ?? null,
      cause: error?.cause ? String(error.cause?.message ?? error.cause).slice(0, 200) : null,
      method: req.method,
    }));
    return sendJson(res, 502, { error: "mirror unavailable" });
  }
}
