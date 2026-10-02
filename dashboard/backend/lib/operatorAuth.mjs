// A separate, revocable identity for an external operator assistant ("dot").
//
// The dashboard has exactly one principal today: the founder, holding a session
// cookie. That principal can approve high-risk builds, retry, cancel, control
// pm2 and edit config. An assistant that only needs to read progress and file
// work must not hold it. This module adds a second, much smaller principal:
//
//   - Authorization: Bearer <token>, checked against SHA-256 hashes stored in
//     ~/.config/openclaw-hq/operators.json (0600, outside the repo). The raw
//     token is never stored, logged, or written to the audit trail.
//   - Off unless HQ_OPERATOR_ENABLED=1, read per request so flipping it back
//     off takes effect without a restart.
//   - Loopback only, judged by the SOCKET address. req.ip is not used: with
//     DASHBOARD_TRUST_PROXY=1 it is whatever X-Forwarded-For says.
//   - Loopback is not enough on its own. hq-tunnel (cloudflared) runs on this
//     machine and connects to the dashboard over 127.0.0.1, so every request
//     from the public internet ALSO arrives from a loopback socket. What tells
//     them apart is the forwarding headers the tunnel adds, so any request that
//     carries one is refused outright.
//   - Default deny: a valid token reaches only OPERATOR_ROUTES. Everything else
//     is 403, including every retry, cancel, decision, approval, admin and pm2
//     route.
//
// A request with a Bearer header is ALWAYS judged here and never falls through
// to the cookie path: its cookie header is stripped before the session
// middleware runs, so a token holder cannot ride a founder session either.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { recordSecurityEvent } from "./securityAudit.mjs";

export const OPERATOR_SCOPES = Object.freeze(["read", "submit"]);

// The whole of what an operator may reach. Ids are matched tighter than the
// handlers' own checks; anything that does not match exactly is denied.
const ID = "[A-Za-z0-9][A-Za-z0-9-]{0,127}";
export const OPERATOR_ROUTES = Object.freeze([
  { method: "GET", path: "/api/founder/overview", pattern: /^\/api\/founder\/overview$/, scope: "read" },
  { method: "GET", path: "/api/founder/objectives", pattern: /^\/api\/founder\/objectives$/, scope: "read" },
  { method: "GET", path: "/api/founder/objectives/:id/execution", pattern: new RegExp(`^/api/founder/objectives/${ID}/execution$`), scope: "read" },
  { method: "GET", path: "/api/founder/objectives/:id/report", pattern: new RegExp(`^/api/founder/objectives/${ID}/report$`), scope: "read" },
  { method: "GET", path: "/api/founder/tasks/:id/execution", pattern: new RegExp(`^/api/founder/tasks/${ID}/execution$`), scope: "read" },
  { method: "GET", path: "/api/founder/tasks/:id/timeline", pattern: new RegExp(`^/api/founder/tasks/${ID}/timeline$`), scope: "read" },
  { method: "GET", path: "/api/founder/tasks/:id/report", pattern: new RegExp(`^/api/founder/tasks/${ID}/report$`), scope: "read" },
  { method: "GET", path: "/api/founder/tasks/:id/evidence", pattern: new RegExp(`^/api/founder/tasks/${ID}/evidence$`), scope: "read" },
  { method: "POST", path: "/api/founder/tasks", pattern: /^\/api\/founder\/tasks$/, scope: "submit" },
]);

export function matchOperatorRoute(method, path) {
  return OPERATOR_ROUTES.find((route) => route.method === method && route.pattern.test(path)) || null;
}

export function isOperatorEnabled(env = process.env) {
  return env.HQ_OPERATOR_ENABLED === "1";
}

export function defaultOperatorStorePath(env = process.env) {
  return env.HQ_OPERATOR_STORE || join(homedir(), ".config", "openclaw-hq", "operators.json");
}

export function operatorActor(id) {
  return `operator:${id || "unknown"}`;
}

// ── token store ──────────────────────────────────────────────────────────────

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function generateToken() {
  return `hqop_${randomBytes(32).toString("base64url")}`;
}

const OPERATOR_ID = /^[a-z][a-z0-9-]{0,39}$/;

export function assertOperatorId(id) {
  if (!OPERATOR_ID.test(String(id || ""))) {
    throw new Error("Operator id must be lowercase letters, digits and dashes, starting with a letter (max 40).");
  }
  return id;
}

// Fails closed: a store that other users can read is treated as unusable, not
// silently trusted. A hash is not the token, but it is still the verifier.
export function readOperatorStore(path) {
  if (!existsSync(path)) return { version: 1, operators: [] };
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    const error = new Error(`Operator store ${path} is accessible to other users (mode ${mode.toString(8)}); expected 600.`);
    error.code = "OPERATOR_STORE_INSECURE";
    throw error;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return { version: 1, ...parsed, operators: Array.isArray(parsed?.operators) ? parsed.operators : [] };
}

export function writeOperatorStore(path, store) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

// Returns { record, token }. The caller decides where the raw token goes; this
// function never prints it.
export function createOperator(path, { id, scopes = OPERATOR_SCOPES, token = generateToken(), now = new Date() } = {}) {
  assertOperatorId(id);
  const wanted = [...new Set(scopes)];
  for (const scope of wanted) {
    if (!OPERATOR_SCOPES.includes(scope)) throw new Error(`Unknown scope: ${scope}`);
  }
  const store = readOperatorStore(path);
  if (store.operators.some((op) => op.id === id && !op.revokedAt)) {
    throw new Error(`Operator ${id} already has an active token. Revoke it first.`);
  }
  if (!/^hqop_[A-Za-z0-9_-]{43}$/.test(String(token))) throw new Error("Malformed operator token.");
  const record = { id, tokenHash: hashToken(token), scopes: wanted, createdAt: now.toISOString(), revokedAt: null };
  store.operators.push(record);
  writeOperatorStore(path, store);
  return { record: publicRecord(record), token };
}

export function revokeOperator(path, id, { now = new Date() } = {}) {
  assertOperatorId(id);
  const store = readOperatorStore(path);
  const active = store.operators.filter((op) => op.id === id && !op.revokedAt);
  if (!active.length) throw new Error(`Operator ${id} has no active token.`);
  for (const op of active) op.revokedAt = now.toISOString();
  writeOperatorStore(path, store);
  return active.map(publicRecord);
}

export function listOperators(path) {
  return readOperatorStore(path).operators.map(publicRecord);
}

function publicRecord(op) {
  return { id: op.id, scopes: op.scopes || [], createdAt: op.createdAt || null, revokedAt: op.revokedAt || null };
}

// Every stored hash is compared, match or not, so the time taken does not say
// which entry (or whether a revoked one) matched.
export function findOperatorByToken(store, token) {
  const presented = Buffer.from(hashToken(token), "hex");
  let found = null;
  for (const op of store.operators) {
    let stored;
    try {
      stored = Buffer.from(String(op.tokenHash || ""), "hex");
    } catch {
      continue;
    }
    if (stored.length !== presented.length) continue;
    if (timingSafeEqual(stored, presented) && !found) found = op;
  }
  return found;
}

// ── request checks ───────────────────────────────────────────────────────────

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackSocket(req) {
  return LOOPBACK.has(String(req?.socket?.remoteAddress || ""));
}

// Any header a proxy or the cloudflared tunnel adds. Node lowercases names.
export function forwardingHeaderOf(req) {
  for (const name of Object.keys(req?.headers || {})) {
    if (name === "forwarded" || name === "x-real-ip" || name.startsWith("x-forwarded-") || name.startsWith("cf-")) return name;
  }
  return null;
}

function bearerOf(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : (/^Bearer\b/i.test(header) ? "" : null);
}

/**
 * Express middleware. Must run BEFORE express-session, csrfProtection and the
 * login gate. Requests without a Bearer Authorization header pass through
 * untouched, so cookie authentication is unchanged.
 *
 * @param {object} options
 * @param {string} options.root                  HQ root, for the audit trail.
 * @param {() => string} [options.storePath]     Resolved per request.
 * @param {() => boolean} [options.enabled]      Resolved per request.
 */
export function operatorAuthGate({
  root,
  storePath = () => defaultOperatorStorePath(),
  enabled = () => isOperatorEnabled(),
} = {}) {
  return function operatorAuthMiddleware(req, res, next) {
    const token = bearerOf(req);
    if (token === null) return next();

    // From here on this is an operator request, whatever happens to it. The
    // credential leaves the request object now so nothing downstream (error
    // handlers, loggers, audit) can echo it, and the cookie goes so the
    // session middleware never loads a founder session for it.
    delete req.headers.authorization;
    delete req.headers.cookie;

    const audit = { actor: operatorActor(null), reason: null };
    // "close" covers a client that hangs up before the response is finished;
    // a denial must not vanish from the trail because the caller left.
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      recordSecurityEvent(root, {
        action: "operator.request",
        actor: audit.actor,
        outcome: res.statusCode < 400 ? "ok" : "denied",
        reason: audit.reason || res.locals?.operatorReason || null,
        ip: req.socket?.remoteAddress || null,
        userAgent: req.headers["user-agent"] || null,
        details: { method: req.method, path: req.path, status: res.statusCode, ...(res.writableFinished ? {} : { aborted: true }) },
      });
    };
    res.on("finish", record);
    res.on("close", record);
    const deny = (status, reason, error) => {
      audit.reason = reason;
      return res.status(status).json({ error, reason });
    };

    if (!enabled()) return deny(401, "operator_disabled", "Unauthorized");
    const forwarded = forwardingHeaderOf(req);
    if (forwarded) return deny(403, "forwarded_request", "Operator access is local only.");
    if (!isLoopbackSocket(req)) return deny(403, "not_loopback", "Operator access is local only.");
    if (!token) return deny(401, "missing_token", "Unauthorized");

    let store;
    try {
      store = readOperatorStore(storePath());
    } catch (error) {
      process.stderr.write(`[operator-auth] operator store unusable: ${error.code || "read-error"}\n`);
      return deny(503, error.code === "OPERATOR_STORE_INSECURE" ? "store_insecure" : "store_unreadable", "Operator access is unavailable.");
    }
    const operator = findOperatorByToken(store, token);
    if (!operator) return deny(401, "unknown_token", "Unauthorized");
    audit.actor = operatorActor(operator.id);
    if (operator.revokedAt) return deny(401, "revoked_token", "Unauthorized");

    const route = matchOperatorRoute(req.method, req.path);
    if (!route) return deny(403, "route_not_allowed", "This route is not available to operators.");
    if (!(operator.scopes || []).includes(route.scope)) return deny(403, "insufficient_scope", "This route is not available to this operator.");

    req.operator = Object.freeze({ id: operator.id, scopes: [...(operator.scopes || [])], actor: audit.actor });
    return next();
  };
}

// Wrap a session-bound middleware (CSRF, login gate) so an authenticated
// operator skips it. Only req.operator — set above, after the allowlist and
// scope checks — opens this; a header alone never does.
export function unlessOperator(middleware) {
  return function unlessOperatorMiddleware(req, res, next) {
    if (req.operator) return next();
    return middleware(req, res, next);
  };
}
