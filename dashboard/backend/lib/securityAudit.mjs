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
  "token", "cookie", "authorization", "credential", "apikey", "privatekey",
  "privkey", "pem", "sessionid",
];

// Names that contain a sensitive substring but carry no secret, so redacting
// them would only destroy useful audit context.
const REDACT_EXCEPTIONS = new Set([
  "tokenized", "passwordless", "hastoken", "haspassword", "tokencount",
  "secretcount", "credentialtype", "signaturealgorithm",
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
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…[truncated]` : value;
  }
  return value;
}

// Strip anything that looks like a credential out of free text.
export function redactText(text) {
  return String(text ?? "")
    .replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, "[redacted:private-key]")
    .replace(/\b(?:password|passphrase|secret|token|api[_-]?key)\b\s*[:=]\s*\S+/gi, (m) => `${m.split(/[:=]/)[0]}=[redacted]`)
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g, "[redacted:jwt]")
    .slice(0, MAX_VALUE_LENGTH);
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
