// Browser-facing hardening for the Headquarters dashboard (FCT-P0-04).
//
// These run against a real express app wired with the same middleware the
// dashboard uses, over a real HTTP socket — a mocked req/res cannot prove that
// cookies, session rotation, and origin checks actually behave.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

// express and express-session are dependencies of the dashboard, not of the
// repo root, so ESM cannot resolve them from factory/test/. Resolve them
// through the dashboard's own package the way the server itself would.
const dashboardRequire = createRequire(new URL("../../dashboard/backend/package.json", import.meta.url));
let express = null;
let session = null;
let depsAvailable = true;
try {
  express = dashboardRequire("express");
  session = dashboardRequire("express-session");
} catch {
  depsAvailable = false;
}

import {
  LoginThrottle,
  contentSecurityPolicy,
  csrfProtection,
  issueCsrfToken,
  regenerateSession,
  securityHeaders,
} from "../../dashboard/backend/lib/httpSecurity.mjs";

// ── a miniature dashboard with the real middleware ───────────────────────────

function buildApp({ password = "correct-horse", throttle } = {}) {
  const app = express();
  app.use(securityHeaders());
  app.use(express.json());
  app.use(
    session({
      name: "agentlab.sid",
      secret: "test-secret-not-a-real-one",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax" },
    })
  );
  app.use(csrfProtection({ exemptPaths: ["/api/auth/login"] }));

  const limiter = throttle || new LoginThrottle();

  app.post("/api/auth/login", async (req, res) => {
    const gate = limiter.check(req.ip || "test");
    if (!gate.allowed) {
      res.setHeader("Retry-After", String(gate.retryAfterSeconds));
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }
    if ((req.body || {}).password !== password) {
      limiter.recordFailure(req.ip || "test");
      return res.status(401).json({ error: "Invalid password" });
    }
    limiter.recordSuccess(req.ip || "test");
    await regenerateSession(req);
    req.session.authenticated = true;
    return res.json({ ok: true, csrfToken: issueCsrfToken(req.session) });
  });

  app.get("/api/auth/me", (req, res) => {
    const authenticated = Boolean(req.session?.authenticated);
    res.json({ authenticated, csrfToken: authenticated ? issueCsrfToken(req.session) : null });
  });

  app.post("/api/founder/approvals/x/submit", (req, res) => res.json({ ok: true, mutated: true }));
  app.get("/api/founder/state", (_req, res) => res.json({ ok: true }));

  return app;
}

async function startServer(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Minimal cookie-aware HTTP client.
function request(port, { method = "GET", path = "/", headers = {}, body = null, cookie = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => { text += c; });
        res.on("end", () => {
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON is fine */ }
          const setCookie = res.headers["set-cookie"] || [];
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json,
            text,
            cookie: setCookie.map((c) => c.split(";")[0]).join("; ") || null,
            rawSetCookie: setCookie,
          });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loggedInClient(port, password = "correct-horse") {
  const res = await request(port, {
    method: "POST",
    path: "/api/auth/login",
    body: { password },
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(res.status, 200, `login should succeed, got ${res.status} ${res.text}`);
  return { cookie: res.cookie, csrfToken: res.body.csrfToken };
}

// ── CSP and security headers ─────────────────────────────────────────────────

// When the dashboard deps are absent (no `npm run setup`) skip the socket-level
// tests rather than failing the suite. The pure-logic tests below still run.
const httpTest = depsAvailable ? test : test.skip;

httpTest("every response carries a restrictive Content-Security-Policy", async () => {
  const server = await startServer(buildApp());
  try {
    const res = await request(server.port, { path: "/api/auth/me" });
    const csp = res.headers["content-security-policy"];
    assert.ok(csp, "CSP header must be present");
    // The line that actually stops injected script from running.
    assert.match(csp, /script-src 'self'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), "script-src must not allow inline script");
    assert.ok(!/script-src[^;]*unsafe-eval/.test(csp), "script-src must not allow eval");
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'self'/);

    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.match(res.headers["cache-control"] || "", /no-store/);
  } finally {
    await server.close();
  }
});

test("the CSP never silently allows inline or eval script", () => {
  const csp = contentSecurityPolicy();
  const scriptDirective = csp.split(";").find((d) => d.trim().startsWith("script-src"));
  assert.equal(scriptDirective.trim(), "script-src 'self'");
});

// ── CSRF ─────────────────────────────────────────────────────────────────────

httpTest("a mutation from another origin is refused", async () => {
  const server = await startServer(buildApp());
  try {
    const { cookie, csrfToken } = await loggedInClient(server.port);
    // The attacker's page has the founder's cookie (the browser sends it) and
    // even guesses a token, but cannot forge the Origin header.
    const res = await request(server.port, {
      method: "POST",
      path: "/api/founder/approvals/x/submit",
      cookie,
      headers: { Origin: "https://evil.example.com", "X-CSRF-Token": csrfToken },
      body: {},
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Cross-origin/i);
  } finally {
    await server.close();
  }
});

httpTest("a mutation with a valid session but no CSRF token is refused", async () => {
  const server = await startServer(buildApp());
  try {
    const { cookie } = await loggedInClient(server.port);
    const res = await request(server.port, {
      method: "POST",
      path: "/api/founder/approvals/x/submit",
      cookie,
      body: {},
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /CSRF/i);
  } finally {
    await server.close();
  }
});

httpTest("a mutation with a token from a DIFFERENT session is refused", async () => {
  const server = await startServer(buildApp());
  try {
    const victim = await loggedInClient(server.port);
    const attacker = await loggedInClient(server.port);
    assert.notEqual(victim.csrfToken, attacker.csrfToken, "sessions must get distinct tokens");

    const res = await request(server.port, {
      method: "POST",
      path: "/api/founder/approvals/x/submit",
      cookie: victim.cookie,
      headers: { "X-CSRF-Token": attacker.csrfToken },
      body: {},
    });
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

httpTest("a same-origin mutation with the session's own token succeeds", async () => {
  const server = await startServer(buildApp());
  try {
    const { cookie, csrfToken } = await loggedInClient(server.port);
    const res = await request(server.port, {
      method: "POST",
      path: "/api/founder/approvals/x/submit",
      cookie,
      headers: { Origin: `http://127.0.0.1:${server.port}`, "X-CSRF-Token": csrfToken },
      body: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.mutated, true);
  } finally {
    await server.close();
  }
});

httpTest("read-only requests are never blocked by CSRF", async () => {
  const server = await startServer(buildApp());
  try {
    const { cookie } = await loggedInClient(server.port);
    const res = await request(server.port, { path: "/api/founder/state", cookie });
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

// ── session fixation ─────────────────────────────────────────────────────────

httpTest("the session id is rotated on login", async () => {
  const server = await startServer(buildApp());
  try {
    // An attacker fixes a session id by getting the victim's browser to hold one
    // before authentication.
    const pre = await request(server.port, { method: "POST", path: "/api/auth/login", body: { password: "wrong" } });
    const planted = pre.cookie;

    const res = await request(server.port, {
      method: "POST",
      path: "/api/auth/login",
      body: { password: "correct-horse" },
      cookie: planted,
    });
    assert.equal(res.status, 200);
    assert.ok(res.cookie, "login must issue a new session cookie");
    assert.notEqual(res.cookie, planted, "the authenticated session id must differ from the planted one");

    // The planted id must not be authenticated.
    if (planted) {
      const replay = await request(server.port, { path: "/api/auth/me", cookie: planted });
      assert.equal(replay.body.authenticated, false, "the pre-login session id must never become authenticated");
    }
  } finally {
    await server.close();
  }
});

httpTest("the session cookie is httpOnly so script cannot read it", async () => {
  const server = await startServer(buildApp());
  try {
    const res = await request(server.port, {
      method: "POST",
      path: "/api/auth/login",
      body: { password: "correct-horse" },
    });
    const raw = res.rawSetCookie.join(";").toLowerCase();
    assert.match(raw, /httponly/);
  } finally {
    await server.close();
  }
});

// ── login throttling ─────────────────────────────────────────────────────────

httpTest("repeated wrong passwords are throttled", async () => {
  const throttle = new LoginThrottle({ maxAttempts: 3, windowMs: 60_000, baseDelayMs: 30_000 });
  const server = await startServer(buildApp({ throttle }));
  try {
    for (let i = 0; i < 3; i += 1) {
      const res = await request(server.port, { method: "POST", path: "/api/auth/login", body: { password: "wrong" } });
      assert.equal(res.status, 401, `attempt ${i + 1} should be a plain rejection`);
    }
    const blocked = await request(server.port, { method: "POST", path: "/api/auth/login", body: { password: "wrong" } });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers["retry-after"], "a throttled response must say when to retry");

    // Critically: the CORRECT password is also refused while locked out, or the
    // throttle would not slow a real guessing attack down at all.
    const correct = await request(server.port, { method: "POST", path: "/api/auth/login", body: { password: "correct-horse" } });
    assert.equal(correct.status, 429);
  } finally {
    await server.close();
  }
});

test("throttle backoff grows and a success clears the counter", () => {
  let now = 0;
  const throttle = new LoginThrottle({ maxAttempts: 2, windowMs: 60_000, baseDelayMs: 1000, maxDelayMs: 60_000, now: () => now });

  throttle.recordFailure("a");
  assert.equal(throttle.check("a").allowed, true, "under the limit stays allowed");

  const first = throttle.recordFailure("a");
  assert.ok(first.lockedUntil > now, "hitting the limit locks the client");
  const firstWait = throttle.check("a").retryAfterSeconds;

  now += firstWait * 1000 + 1;
  throttle.recordFailure("a");
  const secondWait = throttle.check("a").retryAfterSeconds;
  assert.ok(secondWait > firstWait, `backoff must grow: ${firstWait} → ${secondWait}`);

  throttle.recordSuccess("a");
  assert.equal(throttle.check("a").allowed, true, "a successful login clears the lockout");
});

test("a global ceiling limits attempts spread across many addresses", () => {
  const throttle = new LoginThrottle({ maxAttempts: 1000, globalMaxAttempts: 10, windowMs: 60_000 });
  for (let i = 0; i < 10; i += 1) throttle.recordFailure(`client-${i}`);
  // A brand-new address, never seen before, is still refused.
  const gate = throttle.check("client-fresh");
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "global");
});

test("the throttle does not grow without bound", () => {
  let now = 0;
  const throttle = new LoginThrottle({ windowMs: 1000, now: () => now });
  for (let i = 0; i < 500; i += 1) throttle.recordFailure(`client-${i}`);
  assert.equal(throttle.clients.size, 500);
  now += 5000;
  throttle.prune();
  assert.equal(throttle.clients.size, 0, "elapsed windows must be pruned");
});
