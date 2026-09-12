// Durable, append-only audit records for privileged Headquarters actions
// (FCT-P0-04, requirement 12).
//
// Scope: things that change authority or execution — key enrollment, rotation,
// re-key, approval, rejection, retry, process control, and configuration edits.
// A founder must be able to answer "what was authorized, when, by which session,
// and from where?" without reading application logs.
//
// What is deliberately NOT recorded: approval payloads, signatures, passwords,
// session secrets, or private keys. The record proves an action happened and
// attributes it; it is not a copy of the credential (requirement 13).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

// Substrings that mark a field as sensitive, at any nesting depth.
//
// Matching is by SUBSTRING, not exact name. An exact-name list silently passed
// through every plural, compound and env-var spelling — `tokens`, `accessToken`,
// `passwordHash`, `newPassword`, `privKey`, `DASHBOARD_PASSWORD`,
// `secretValue` — which is precisely the shape real config and error payloads
// take. The module promises "never written, at any nesting depth"; it has to
// mean it.
const REDACT_PATTERNS = [
  "signature", "assertion", "secret", "password", "passphrase", "passwd",
  "token", "cookie", "authorization", "auth", "credential", "apikey",
  "privatekey", "privkey", "key", "pem", "sessionid", "bearer", "jwt",
  "dsn", "connectionstring", "databaseurl", "salt",
];

// Names that contain a sensitive substring but carry no secret. Redacting them
// destroys the very evidence a founder-approval audit exists to carry — you
// must still be able to record WHETHER a signature verified and WHICH public
// key approved. A public key is not a secret.
const REDACT_EXCEPTIONS = new Set([
  "tokenized", "passwordless", "hastoken", "haspassword", "tokencount",
  "secretcount", "credentialtype", "signaturealgorithm",
  "signaturevalid", "signatureverified", "signaturepresent",
  "assertionpresent", "assertionvalid", "assertionversion",
  "publickey", "publickeypem", "pempath", "keyfingerprint", "fingerprint",
  "keyid", "keysource", "keyalgorithm", "authority", "authorityfingerprint",
  "authoritysource", "keyrotated", "keyenrolled", "authenticated",
  "typemismatch", "typemap", "monkey", "keyboard",
]);

function isSensitiveKey(key) {
  // Normalise camelCase, snake_case, SCREAMING_CASE and kebab-case alike.
  const normalized = String(key).toLowerCase().replace(/[^a-z]/g, "");
  if (REDACT_EXCEPTIONS.has(normalized)) return false;
  return REDACT_PATTERNS.some((pattern) => normalized.includes(pattern));
}

const MAX_VALUE_LENGTH = 500;

export function auditLogPath(root) {
  return join(root, "dashboard", "backend", "data", "factory", "security-audit.jsonl");
}

// Recursively drop anything sensitive and bound the size of what remains, so a
// large agent-supplied blob cannot bloat or flood the audit file.
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "[depth-limited]";

  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));

  if (typeof value === "object") {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        // Record that a credential was present, and a stable digest so two
        // events can be correlated, but never the credential itself.
        out[key] = raw ? `[redacted:${shortDigest(raw)}]` : "[redacted]";
        continue;
      }
      out[key] = redact(raw, depth + 1);
    }
    return out;
  }

  if (typeof value === "string") {
    // Scan the VALUE too. Checking only key names meant
    // {message:"login failed for DASHBOARD_PASSWORD=hunter2"} was written verbatim.
    return redactText(value);
  }
  return value;
}

// Strip anything that looks like a credential out of free text.
export function redactText(text) {
  let out = String(text ?? "");

  // A PEM block, whether or not the END marker survived the excerpt.
  out = out.replace(
    /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g,
    "[redacted:private-key]",
  );
  // Credentials embedded in a URL: postgres://user:pw@host
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]+)@/gi, "$1:[redacted]@");
  // Authorization headers and bearer tokens.
  out = out.replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
  // key=value / key: value, including SCREAMING_SNAKE env names and quoted
  // values. No \b before the name: "_" is a word character, so \b never
  // matched at the start of DASHBOARD_PASSWORD.
  out = out.replace(
    /([A-Za-z0-9_.-]*(?:password|passphrase|passwd|secret|token|apikey|api[_-]?key|credential|privatekey|priv[_-]?key)[A-Za-z0-9_.-]*)\s*["']?\s*[:=]\s*["']?([^\s"',;}]+)/gi,
    "$1=[redacted]",
  );
  // A sensitive name followed by a QUOTED value, with no : or = between them
  // ("password 'hunter2'"). Restricted to quoted values on purpose: matching a
  // bare whitespace-separated word would mangle ordinary prose such as
  // "password reset requested".
  out = out.replace(
    /([A-Za-z0-9_.-]*(?:password|passphrase|passwd|secret|token|apikey|credential|privatekey)[A-Za-z0-9_.-]*)\s+["']([^"']+)["']/gi,
    "$1 [redacted]",
  );
  // A bare JWT anywhere in the text.
  out = out.replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/g, "[redacted:jwt]");

  return out.length > MAX_VALUE_LENGTH ? `${out.slice(0, MAX_VALUE_LENGTH)}…[truncated]` : out;
}

function shortDigest(value) {
  try {
    return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

// A stable, non-reversible handle for the session that performed an action.
// Lets the founder tie several actions to one session without the audit file
// becoming a list of live session ids an attacker could replay.
export function sessionHandle(sessionId) {
  if (!sessionId) return null;
  return createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16);
}

// Append one record. Never throws into a request path: losing the request
// because the audit file is unwritable would be a worse outcome than the gap,
// and the failure is reported on stderr where the operator will see it.
export function recordSecurityEvent(root, event) {
  const record = {
    id: randomUUID(),
    at: new Date().toISOString(),
    action: String(event?.action || "unknown"),
    actor: String(event?.actor || "founder"),
    outcome: String(event?.outcome || "ok"),
    ...(event?.taskId ? { taskId: String(event.taskId) } : {}),
    ...(event?.objectiveId ? { objectiveId: String(event.objectiveId) } : {}),
    ...(event?.sessionHandle ? { session: String(event.sessionHandle) } : {}),
    ...(event?.ip ? { ip: String(event.ip) } : {}),
    ...(event?.userAgent ? { userAgent: String(event.userAgent).slice(0, 200) } : {}),
    // `reason` carries founder free text and raw error strings, either of which
    // can quote a secret. Length-capping alone was not enough.
    ...(event?.reason ? { reason: redactText(String(event.reason)) } : {}),
    ...(event?.details ? { details: redact(event.details) } : {}),
  };
  const path = auditLogPath(root);
  try {
    mkdirSync(dirname(path), { recursive: true });
    // 0600: the audit trail is operator-only.
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    process.stderr.write(`[security-audit] could not write audit record: ${error.message}\n`);
  }
  return record;
}

// Read recent records, newest first. Used by the dashboard and by tests.
export function readSecurityEvents(root, { limit = 200, action = null } = {}) {
  const path = auditLogPath(root);
  if (!existsSync(path)) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (action && row.action !== action) continue;
      rows.push(row);
    } catch {
      // A corrupt line is surfaced rather than silently skipped, so a tampered
      // or partially written audit file is visible to the founder.
      rows.push({ corrupt: true, raw: line.slice(0, 200) });
    }
  }
  return rows.reverse().slice(0, limit);
}

// Convenience wrapper that pulls attribution off an express request.
export function auditFromRequest(root, req, event) {
  return recordSecurityEvent(root, {
    ...event,
    sessionHandle: sessionHandle(req?.sessionID),
    ip: req?.ip || req?.socket?.remoteAddress || null,
    userAgent: req?.headers?.["user-agent"] || null,
  });
}
