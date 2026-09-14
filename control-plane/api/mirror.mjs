// The mirror endpoint. Read by the founder, written by the factory machine.
//
// GET  — requires a viewer session (DC-2026-004)
// POST — requires the write credential (DC-2026-003)
//
// The two are checked by different functions against different secrets, and
// neither falls back to the other. A publisher token cannot read the mirror
// through this route, and a viewer session cannot write it.

import { isPublisher, isViewer, refuse } from "./_lib/auth.mjs";
import { MIRROR_CONTRACT, readSnapshot, writeSnapshot } from "./_lib/store.mjs";

// A projection of the whole dashboard is not small, but it is not a file
// upload either. This bounds what one publish can cost before anything is
// parsed.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export default async function handler(request) {
  try {
    if (request.method === "GET") {
      if (!isViewer(request)) return refuse();
      const snapshot = await readSnapshot();
      if (!snapshot) return json({ error: "no snapshot published" }, 404);
      return json(snapshot);
    }

    if (request.method === "POST") {
      if (!isPublisher(request)) return refuse();

      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) {
        return json({ error: "snapshot too large", maxBytes: MAX_BODY_BYTES }, 413);
      }

      let snapshot;
      try {
        snapshot = JSON.parse(raw);
      } catch {
        return json({ error: "body is not JSON" }, 400);
      }

      // Reject rather than coerce. A snapshot that does not declare the
      // contract is not a snapshot this viewer knows how to render, and
      // storing it anyway would put the renderer in front of data nobody
      // agreed on.
      if (snapshot?.contract !== MIRROR_CONTRACT) {
        return json({ error: `contract must be ${MIRROR_CONTRACT}`, received: snapshot?.contract ?? null }, 422);
      }
      if (typeof snapshot.publishedAt !== "string") {
        return json({ error: "publishedAt is required" }, 422);
      }

      const stored = await writeSnapshot(snapshot);
      return json({ ok: true, publishedAt: snapshot.publishedAt, bytes: stored.size }, 200);
    }

    return json({ error: "method not allowed" }, 405, { allow: "GET, POST" });
  } catch (error) {
    if (error?.code === "unconfigured") {
      // Say which variable is missing, never its value, and never fall open.
      return json({ error: "control plane is not configured", detail: error.message }, 503);
    }
    return json({ error: "mirror unavailable" }, 502);
  }
}
