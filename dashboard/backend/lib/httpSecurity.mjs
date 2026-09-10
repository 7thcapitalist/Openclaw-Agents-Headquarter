// Browser-facing hardening for Headquarters (FCT-P0-04).
//
// The dashboard session is not an ordinary login session: it approves
// high-risk builds, retries work, and controls processes. Anything that can
// make a request as the founder can direct the factory. These middlewares close
// the three realistic browser paths to that: script injection (CSP), forged
// cross-origin requests (CSRF), and password guessing (throttling).
//
// Deliberately dependency-free — helmet/csurf would each add a third-party
// artifact to factory/third-party/provenance.json for behaviour that is a few
// dozen lines here, and csurf is deprecated.

import { randomBytes, timingSafeEqual } from "node:crypto";

// Requests that change nothing need no CSRF token.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// ── security headers ─────────────────────────────────────────────────────────

// `script-src 'self'` is the line that matters: it means injected markup cannot
// execute even if something slips past the Markdown sanitizer. The dashboard
// has no inline <script> (index.html/login.html load external modules), so this
// costs nothing.
//
// `style-src` keeps 'unsafe-inline' because app.js builds first-party inline
// style attributes for things like progress-bar widths. That is a real, narrow
// tradeoff: inline CSS cannot execute JavaScript, and the sanitizer strips the
// `style` attribute from all untrusted content, so agent-authored CSS never
// reaches the page.
// `allowHttpsImages` defaults to FALSE. Agent-authored Markdown can embed an
// <img>, so permitting arbitrary https image sources let any report beacon the
// founder's view time and source IP to a host of the author's choosing. Local
// and data: images cover everything Headquarters actually renders.
export function contentSecurityPolicy({ allowHttpsImages = false } = {}) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${allowHttpsImages ? " https:" : ""}`,
    "font-src 'self'",
    "connect-src 'self'",
    // No plugins, no framing, no <base> rewriting, and forms may only post to us.
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function securityHeaders(options = {}) {
  const csp = contentSecurityPolicy(options);
  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=(), usb=()");
    // Never let a browser or proxy cache an authenticated API response.
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.setHeader("Pragma", "no-cache");
    }
    next();
  };
}

// ── CSRF ─────────────────────────────────────────────────────────────────────

export function issueCsrfToken(session) {
  if (!session) return null;
  if (!session.csrfToken) session.csrfToken = randomBytes(32).toString("base64url");
  return session.csrfToken;
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

// Parse the host:port a request claims to be for, so an Origin header can be
// compared against the server the browser actually reached.
function expectedOrigins(req, configured, { trustProxy = false } = {}) {
  const origins = new Set();
  for (const value of configured || []) {
    if (value) origins.add(String(value).replace(/\/$/, "").toLowerCase());
  }

  // `x-forwarded-host` is only consulted when the deployment actually sits
  // behind a proxy it trusts. Reading it unconditionally meant a request could
  // nominate its own allowed origin — the origin check then agreed with
  // whatever the caller claimed and contributed nothing. clientKey() already
  // follows the trust-proxy setting; this now does too.
  const forwarded = trustProxy ? req.headers["x-forwarded-host"] : null;
  const host = forwarded || req.headers.host;
  if (host) {
    const bare = String(host).split(",")[0].trim().toLowerCase();
    // Both schemes: the same deployment is often plain http locally and https
    // through a proxy, and the browser sends the scheme it actually used.
    origins.add(`http://${bare}`);
    origins.add(`https://${bare}`);
  }
  return origins;
}

// Two independent checks, both must pass for a mutation:
//
//   1. Origin/Referer must be this deployment. A classic cross-site form post
//      carries an Origin the browser sets and script cannot forge.
//   2. A session-bound token echoed in the X-CSRF-Token header. This is what
//      protects requests where Origin is absent.
//
// SameSite=lax on the cookie is a third layer, but it is a browser default we
// do not control and does not cover every client, so it is not relied upon.
export function csrfProtection({ allowedOrigins = [], exemptPaths = [], trustProxy = false } = {}) {
  const exempt = new Set(exemptPaths);
  return function csrfMiddleware(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (exempt.has(req.path)) return next();

    const origin = req.headers.origin;
    const referer = req.headers.referer || req.headers.referrer;
    const allowed = expectedOrigins(req, allowedOrigins, { trustProxy });

    if (origin) {
      if (!allowed.has(String(origin).replace(/\/$/, "").toLowerCase())) {
        return res.status(403).json({ error: "Cross-origin request refused." });
      }
    } else if (referer) {
      let refOrigin = null;
      try {
        refOrigin = new URL(String(referer)).origin.toLowerCase();
      } catch {
        refOrigin = null;
      }
      if (!refOrigin || !allowed.has(refOrigin)) {
        return res.status(403).json({ error: "Cross-origin request refused." });
      }
    }

    const expected = req.session?.csrfToken;
    if (!expected) {
      return res.status(403).json({ error: "No CSRF token is bound to this session. Reload Headquarters." });
    }
    const presented = req.headers["x-csrf-token"]
      || (req.body && typeof req.body === "object" ? req.body._csrf : null);
    if (!constantTimeEquals(presented, expected)) {
      return res.status(403).json({ error: "Invalid or missing CSRF token." });
    }
    return next();
  };
}

// ── login throttling ─────────────────────────────────────────────────────────

// Exponential per-client backoff plus a global ceiling.
//
// The global counter matters because the dashboard has ONE password: without it
// an attacker distributed across many source addresses would face no limit at
// all. Counters are in-memory on purpose — a restart clears them, but a restart
// is not something an unauthenticated attacker can cause.
export class LoginThrottle {
  constructor({
    maxAttempts = 5,
    windowMs = 15 * 60 * 1000,
    baseDelayMs = 1000,
    maxDelayMs = 5 * 60 * 1000,
    globalMaxAttempts = 100,
    now = () => Date.now(),
  } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.globalMaxAttempts = globalMaxAttempts;
    this.now = now;
    this.clients = new Map();
    this.global = { failures: 0, windowStart: now() };
  }

  #client(key) {
    let entry = this.clients.get(key);
    if (!entry) {
      entry = { failures: 0, lockedUntil: 0, windowStart: this.now() };
      this.clients.set(key, entry);
    }
    if (this.now() - entry.windowStart > this.windowMs) {
      entry.failures = 0;
      entry.windowStart = this.now();
      entry.lockedUntil = 0;
    }
    return entry;
  }

  #globalWindow() {
    if (this.now() - this.global.windowStart > this.windowMs) {
      this.global = { failures: 0, windowStart: this.now() };
    }
    return this.global;
  }

  // Returns { allowed, retryAfterSeconds, reason }.
  check(key) {
    const entry = this.#client(key);
    const global = this.#globalWindow();
    const now = this.now();

    if (entry.lockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000), reason: "client" };
    }
    if (global.failures >= this.globalMaxAttempts) {
      const retryMs = this.windowMs - (now - global.windowStart);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)), reason: "global" };
    }
    return { allowed: true, retryAfterSeconds: 0, reason: null };
  }

  recordFailure(key) {
    const entry = this.#client(key);
    const global = this.#globalWindow();
    entry.failures += 1;
    global.failures += 1;
    if (entry.failures >= this.maxAttempts) {
      const over = entry.failures - this.maxAttempts;
      const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** over);
      entry.lockedUntil = this.now() + delay;
    }
    return { failures: entry.failures, lockedUntil: entry.lockedUntil };
  }

  recordSuccess(key) {
    this.clients.delete(key);
  }

  // Bound memory: drop client entries whose window has fully elapsed.
  prune() {
    const now = this.now();
    for (const [key, entry] of this.clients) {
      if (now - entry.windowStart > this.windowMs && entry.lockedUntil <= now) {
        this.clients.delete(key);
      }
    }
  }
}

// The identity we throttle on. Behind a proxy this must be the real client, so
// it follows the same trust-proxy setting express uses.
export function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

// Rotate the session id while preserving its contents. Defeats session
// fixation: a session id an attacker planted before login is not the id that
// ends up authenticated.
export function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.regenerate !== "function") return resolve(false);
    const carried = { ...req.session };
    delete carried.cookie;
    req.session.regenerate((err) => {
      if (err) return reject(err);
      Object.assign(req.session, carried);
      // A rotated session gets a fresh CSRF token too.
      req.session.csrfToken = randomBytes(32).toString("base64url");
      resolve(true);
    });
  });
}
