// Sign in and out of the hosted view.
//
// POST   { password }  -> sets the session cookie
// DELETE               -> clears it
// GET                  -> reports whether this request is signed in
//
// Throttled, because a shared secret on a public URL is exactly the thing worth
// guessing at. The limiter is per-instance and therefore best-effort — a
// serverless deployment has no shared memory — but it makes an unbounded
// guessing loop from one client meaningfully slower, and the password is long
// and random rather than chosen.
//
// Node signature, because that is what Vercel's runtime calls. See _lib/http.mjs.

import { clearedCookie, issueSession, isViewer, passwordMatches, sessionCookie } from "./_lib/auth.mjs";
import { readJson, requestLike, sendJson } from "./_lib/http.mjs";

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;

// Per-instance, and deliberately not a store: a shared counter would be a
// second piece of state to keep consistent for a control plane with one user.
const attempts = new Map();

function tooMany(key, now) {
  const record = attempts.get(key);
  if (!record || now - record.start > WINDOW_MS) {
    attempts.set(key, { start: now, count: 1 });
    return false;
  }
  record.count += 1;
  return record.count > MAX_ATTEMPTS;
}

export default async function handler(req, res) {
  try {
    const request = requestLike(req);

    if (req.method === "GET") {
      return sendJson(res, 200, { authenticated: isViewer(request) });
    }

    if (req.method === "DELETE") {
      return sendJson(res, 200, { ok: true }, { "set-cookie": clearedCookie() });
    }

    if (req.method === "POST") {
      const client = request.headers.get("x-forwarded-for") || "unknown";
      if (tooMany(client, Date.now())) {
        return sendJson(res, 429, { error: "too many attempts" }, { "retry-after": "60" });
      }

      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: "body is not JSON" });
      }

      const password = body?.password;
      if (typeof password !== "string" || !passwordMatches(password)) {
        // Same answer, same shape, whatever was wrong with it.
        return sendJson(res, 401, { error: "unauthorized" });
      }

      return sendJson(res, 200, { ok: true }, { "set-cookie": sessionCookie(issueSession()) });
    }

    return sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, POST, DELETE" });
  } catch (error) {
    if (error?.code === "unconfigured") {
      return sendJson(res, 503, { error: "control plane is not configured", detail: error.message });
    }
    return sendJson(res, 500, { error: "session unavailable" });
  }
}
