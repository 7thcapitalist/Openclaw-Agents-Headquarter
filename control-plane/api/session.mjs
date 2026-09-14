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

import {
  clearedCookie,
  issueSession,
  isViewer,
  passwordMatches,
  refuse,
  sessionCookie,
} from "./_lib/auth.mjs";

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

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export default async function handler(request) {
  try {
    if (request.method === "GET") {
      return json({ authenticated: isViewer(request) });
    }

    if (request.method === "DELETE") {
      return json({ ok: true }, 200, { "set-cookie": clearedCookie() });
    }

    if (request.method === "POST") {
      const client = request.headers.get("x-forwarded-for") || "unknown";
      if (tooMany(client, Date.now())) {
        return json({ error: "too many attempts" }, 429, { "retry-after": "60" });
      }

      let password;
      try {
        ({ password } = await request.json());
      } catch {
        return json({ error: "body is not JSON" }, 400);
      }

      if (typeof password !== "string" || !passwordMatches(password)) {
        // Same answer, same shape, whatever was wrong with it.
        return refuse();
      }

      return json({ ok: true }, 200, { "set-cookie": sessionCookie(issueSession()) });
    }

    return json({ error: "method not allowed" }, 405, { allow: "GET, POST, DELETE" });
  } catch (error) {
    if (error?.code === "unconfigured") {
      return json({ error: "control plane is not configured", detail: error.message }, 503);
    }
    return json({ error: "session unavailable" }, 500);
  }
}
