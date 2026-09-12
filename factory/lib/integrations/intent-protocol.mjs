// Founder intents arriving from the public control plane.
//
// SFD-2026-012 makes the factory machine outbound-only: it polls Vercel for
// pending founder actions and executes them locally. That inverts a property
// this codebase has relied on until now. Every prior queue was fed by the same
// machine that drained it. This one is fed from the internet.
//
// So the central rule, inherited from the wakeup queue and made stricter:
//
//     AN INTENT IDENTIFIES AN ACTION. IT NEVER CARRIES A COMMAND.
//
// An intent names one action from a closed allowlist and supplies typed,
// bounded arguments. There is no field anywhere in this module that becomes a
// shell string, a path, a URL, a module specifier, or a callable. A queue that
// could carry a command would be remote code execution on a home machine, which
// is the single thing this design must not become.
//
// Two further properties follow from the same threat model:
//
//   - Nothing here EXECUTES anything. This module validates and records; the
//     worker that acts on an intent maps `kind` to an existing local handler.
//     The mapping lives with the worker, so this file cannot be edited into a
//     dispatcher.
//   - Nothing here escalates. An intent can only ask for something the founder
//     could already do in the local dashboard. `prohibitedAutonomousActions`
//     and the founder-approval gate are unchanged and still apply on execution;
//     an intent is a request to run a gate, never a way around one.
//
// This module performs no network I/O, asserted from the source by test.

import { createHash, randomUUID } from "node:crypto";

export const INTENT_CONTRACT = "hq.intent/1";

// The closed allowlist. Every entry corresponds to an action the founder can
// already take in the local dashboard. Adding one is a deliberate edit here
// plus a handler in the worker — a new intent kind cannot arrive by data.
//
// `args` declares the exact argument names permitted. An intent carrying any
// other key is rejected rather than trimmed, because silently dropping a field
// is how a caller's intent and the executed action diverge.
export const INTENT_KINDS = Object.freeze({
  "objective.start":     { args: ["objective", "projectId"], maxLen: { objective: 1000, projectId: 100 } },
  "objective.retry":     { args: ["objectiveId"],            maxLen: { objectiveId: 100 } },
  "task.retry":          { args: ["taskId"],                 maxLen: { taskId: 100 } },
  "approval.submit":     { args: ["taskId", "assertion"],    maxLen: { taskId: 100, assertion: 8000 } },
  "approval.reject":     { args: ["taskId", "reason"],       maxLen: { taskId: 100, reason: 2000 } },
  "decision.resolve":    { args: ["decisionId", "choice"],   maxLen: { decisionId: 100, choice: 2000 } },
  "inbox.dismiss":       { args: ["itemId"],                 maxLen: { itemId: 200 } },
  "overnight.add":       { args: ["objective", "projectId"], maxLen: { objective: 1000, projectId: 100 } },
  "overnight.remove":    { args: ["itemId"],                 maxLen: { itemId: 200 } },
  "overnight.start":     { args: [],                         maxLen: {} },
  "overnight.stop":      { args: [],                         maxLen: {} },
  "task.comment":        { args: ["taskId", "body"],         maxLen: { taskId: 100, body: 4000 } },
});

export const INTENT_STATUSES = Object.freeze(["pending", "claimed", "done", "failed", "rejected"]);

// Shapes that must never appear in an argument, whatever the kind. These are
// not sanitised — an argument matching one is rejected outright, because a
// founder typing an objective has no reason to produce any of them and an
// attacker probing for a dispatcher has every reason to.
const COMMAND_SHAPES = [
  { name: "shell-metacharacters", re: /[;&|`$><\n\r]|\$\(|\$\{/ },
  { name: "path-traversal", re: /\.\.[/\\]/ },
  { name: "absolute-path", re: /^(?:[/\\]|[A-Za-z]:[/\\])/ },
  { name: "url-or-scheme", re: /^[a-z][a-z0-9+.-]*:\/\//i },
  { name: "module-specifier", re: /\b(?:require|import)\s*\(/ },
];

export function isKnownIntentKind(kind) {
  return Object.prototype.hasOwnProperty.call(INTENT_KINDS, kind);
}

/**
 * Validate an intent as received. Returns { ok, reason } and never throws — a
 * malformed intent arriving from the network must be recorded and rejected, not
 * allowed to break the poller that found it.
 */
export function validateIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    return { ok: false, reason: "intent must be an object" };
  }
  const { kind, args } = intent;
  if (typeof kind !== "string" || !isKnownIntentKind(kind)) {
    return { ok: false, reason: `unknown intent kind: ${String(kind).slice(0, 60)}` };
  }
  const spec = INTENT_KINDS[kind];

  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
    return { ok: false, reason: "args must be an object" };
  }
  const supplied = args ? Object.keys(args) : [];

  // Unknown keys are rejected, never trimmed: dropping a field silently is how
  // the caller's intent and the executed action come apart.
  const unexpected = supplied.filter((key) => !spec.args.includes(key));
  if (unexpected.length) return { ok: false, reason: `unexpected argument(s): ${unexpected.join(", ")}` };

  const missing = spec.args.filter((key) => !supplied.includes(key));
  if (missing.length) return { ok: false, reason: `missing argument(s): ${missing.join(", ")}` };

  for (const key of spec.args) {
    const value = args[key];
    if (typeof value !== "string") return { ok: false, reason: `${key} must be a string` };
    if (!value.trim()) return { ok: false, reason: `${key} must not be empty` };
    const limit = spec.maxLen[key] ?? 1000;
    if (value.length > limit) return { ok: false, reason: `${key} exceeds ${limit} characters` };
    for (const shape of COMMAND_SHAPES) {
      if (shape.re.test(value)) return { ok: false, reason: `${key} contains ${shape.name}` };
    }
  }
  return { ok: true, reason: null };
}

/**
 * Build a durable intent record. `requestedBy` is an identity the control plane
 * asserts; it is recorded for audit and is never itself trusted to authorize
 * anything — the founder-approval gate does that, on execution, locally.
 */
export function createIntent({ kind, args = {}, requestedBy = null, now = new Date().toISOString(), id = randomUUID }) {
  const validation = validateIntent({ kind, args });
  if (!validation.ok) throw new Error(`invalid intent: ${validation.reason}`);
  const intentId = id();
  const normalized = {};
  for (const key of INTENT_KINDS[kind].args) normalized[key] = args[key];
  return {
    version: 1,
    contract: INTENT_CONTRACT,
    intentId,
    kind,
    args: normalized,
    requestedBy: requestedBy ? String(requestedBy).slice(0, 200) : null,
    createdAt: now,
    status: "pending",
    attempts: 0,
    claimedBy: null,
    claimedAt: null,
    resolvedAt: null,
    error: null,
    // Binds the record to its content, so a store that mutates an intent
    // between claim and execution is detectable rather than silently obeyed.
    digest: intentDigest({ kind, args: normalized, intentId, createdAt: now }),
  };
}

export function intentDigest({ kind, args, intentId, createdAt }) {
  const canonical = JSON.stringify([intentId, kind, createdAt, Object.entries(args).sort()]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** True when the record still matches the digest taken at creation. */
export function intentIsIntact(intent) {
  if (!intent?.digest) return false;
  return intent.digest === intentDigest({
    kind: intent.kind, args: intent.args || {},
    intentId: intent.intentId, createdAt: intent.createdAt,
  });
}

/**
 * Claim an intent for execution. Only a pending, valid, intact intent may be
 * claimed — the three checks are deliberately all here, so a worker cannot
 * execute something this module has not agreed to.
 */
export function claimIntent(intent, { actorId, now = new Date().toISOString(), maxAttempts = 3 }) {
  if (!intent || intent.status !== "pending") return { ok: false, reason: "intent is not pending", intent };
  if (!intentIsIntact(intent)) return { ok: false, reason: "intent digest does not match its content", intent };
  const validation = validateIntent(intent);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason, intent: { ...intent, status: "rejected", error: validation.reason, resolvedAt: now } };
  }
  if (intent.attempts >= maxAttempts) {
    return { ok: false, reason: "attempt budget exhausted", intent: { ...intent, status: "failed", error: "attempt budget exhausted", resolvedAt: now } };
  }
  return {
    ok: true, reason: null,
    intent: { ...intent, status: "claimed", claimedBy: String(actorId), claimedAt: now, attempts: intent.attempts + 1 },
  };
}

/** Record the local outcome. A failure returns to pending until its budget is spent. */
export function resolveIntent(intent, { actorId, outcome, error = null, now = new Date().toISOString(), maxAttempts = 3 }) {
  if (!intent || intent.status !== "claimed") throw new Error("only a claimed intent can be resolved");
  if (intent.claimedBy !== String(actorId)) throw new Error("only the claiming worker may resolve an intent");
  if (outcome === "succeeded") return { ...intent, status: "done", resolvedAt: now, error: null };
  const exhausted = intent.attempts >= maxAttempts;
  return {
    ...intent,
    status: exhausted ? "failed" : "pending",
    claimedBy: null, claimedAt: null,
    resolvedAt: exhausted ? now : null,
    error: error ? String(error).slice(0, 500) : "execution failed",
  };
}

export { COMMAND_SHAPES };
