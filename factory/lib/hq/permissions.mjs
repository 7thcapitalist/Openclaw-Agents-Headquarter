// Scoped, deny-by-default capabilities for factory mutation entrypoints.
//
// Adapted from Paperclip's `agent-permissions` and `authorization` services at
// pinned commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
//
// Three properties make this safe to put in front of the factory.
//
// 1. STRICTLY SUBTRACTIVE. This module can only ever deny. It grants nothing
//    that policy did not already allow, and the capability vocabulary is a
//    closed list that deliberately contains no merge, deploy, billing, secret,
//    or production capability. A registry that names one is REJECTED rather
//    than partially honoured, so a permissions file can never become a back
//    door around `prohibitedAutonomousActions`.
//
// 2. FOUNDER AUTHORITY IS SUPERIOR. A human founder actor is always allowed,
//    and a task carrying a verified founder approval is always allowed. This
//    module cannot be used to lock the founder out of their own factory. Both
//    bypasses are audited, so "the founder did it" is a recorded fact rather
//    than a silent hole.
//
// 3. DENY-BY-DEFAULT INSIDE AN OPT-IN ENVELOPE, WITH AN OBSERVE STEP.
//    There are three modes:
//
//      off      no `factory/permissions.json`. Every check allows, with
//               `reason: "enforcement-disabled"`. A factory with no permissions
//               file must keep working exactly as before, or this is an outage
//               rather than a control.
//      report   the file exists (the default when it does). Every decision is
//               computed and audited exactly as it would be under `enforce`,
//               and then ALLOWED anyway. This is how an operator finds out what
//               a grant table would have broken before it breaks anything.
//      enforce  denials are real.
//
//    Inside `report` and `enforce` the rule is identical and there is no
//    implicit grant: an actor with no matching grant is denied. The only
//    difference is whether the denial stops the work. `wouldDeny` on the
//    decision is what `report` mode exists to surface.
//
// Every denial is auditable by the caller: `authorize()` returns a fully
// attributed decision, and `recordPermissionDecision()` writes it to the
// append-only audit log.

import { existsSync, readFileSync } from "fs";
import { assertSupportedVersion } from "../store/durable-version.mjs";
import { join, resolve } from "path";
import { appendAuditEvent, createAuditEvent } from "../audit/envelope.mjs";
import { observeSubject } from "./blast-radius.mjs";

// The complete capability vocabulary. Adding to this list is a deliberate,
// reviewed act. Note what is absent and must stay absent: anything that merges,
// deploys, spends, rotates a secret, or touches production. Those are governed
// by factory.config.json `prohibitedAutonomousActions` and the founder approval
// signature, and a permission grant must never be able to confer them.
export const CAPABILITIES = Object.freeze([
  "task.initialize",     // create a task branch and worktree
  "task.dispatch",       // run a pipeline stage for a task
  "objective.run",       // schedule an objective's nodes
  "objective.recover",   // resume blocked/failed objective nodes
  "github.open-pr",      // publish a branch and open a pull request
  "interaction.post",    // attach a comment or mention to canonical task context
  "wakeup.enqueue",      // place an identifier-only wakeup on the durable queue
]);

// Named here only so a registry that tries to grant one fails loudly with a
// message that says why, instead of being silently ignored.
const FORBIDDEN_CAPABILITIES = Object.freeze([
  "git.push-to-main", "pr.merge", "deploy.production", "data.delete",
  "secret.read", "secret.rotate", "billing.change", "purchase.make", "publish.public",
]);

const SCOPE_TYPES = Object.freeze(["company", "project", "task"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const WILDCARD = "*";
const MAX_GRANTS = 500;

export function permissionsPath(hqRoot) {
  return join(resolve(hqRoot), "factory", "permissions.json");
}

// A missing file is "enforcement off", not "everything denied": a factory with
// no permissions file must keep working exactly as it did before this existed.
export const MODES = Object.freeze(["off", "report", "enforce"]);

export function readPermissionRegistry(hqRoot, { path = null } = {}) {
  const file = path || permissionsPath(hqRoot);
  if (!existsSync(file)) return { version: 1, enforcement: "off", grants: [], present: false, path: file };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`permission registry at ${file} is not valid JSON: ${error.message}`);
  }
  assertSupportedVersion(parsed?.version, { format: "permission-registry", path: file });
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.grants)) {
    throw new Error(`permission registry at ${file} must be an object with a 'grants' array`);
  }
  if (parsed.grants.length > MAX_GRANTS) throw new Error(`permission registry holds more than ${MAX_GRANTS} grants`);

  const seen = new Set();
  for (const grant of parsed.grants) {
    validateGrant(grant);
    const key = `${grant.actorId}|${grant.capability}|${grant.scopeType}|${grant.scopeId}`;
    if (seen.has(key)) throw new Error(`duplicate grant for '${grant.actorId}' on '${grant.capability}'`);
    seen.add(key);
  }
  // Default to `report`. Turning enforcement on is an explicit act, so adding
  // the file can never take the factory down by itself.
  const enforcement = parsed.mode ?? "report";
  if (!MODES.includes(enforcement)) {
    throw new Error(`permission registry mode must be one of ${MODES.join(", ")}`);
  }
  return { version: 1, enforcement, grants: parsed.grants, present: true, path: file };
}

// Decide one request. Never throws for an unknown actor or capability — an
// unknown anything is a denial with a reason, because a permission check that
// crashes is a permission check that gets removed.
export function authorize(request) {
  const verdict = decide(request);
  // `report` mode computes and records the real verdict, then allows anyway.
  if (verdict.allowed || request?.registry?.enforcement !== "report") return verdict;
  return { ...verdict, allowed: true, wouldDeny: true };
}

function decide({ registry, actorType = "agent", actorId, capability, scope = {}, founderApproval = null }) {
  const decision = (allowed, reason, extra = {}) => ({
    allowed,
    reason,
    wouldDeny: false,
    actor: { type: actorType, id: String(actorId || "unknown") },
    capability: String(capability || "unknown"),
    scope: { type: scope?.type || null, id: scope?.id || null, projectId: scope?.projectId || null },
    enforcement: registry?.enforcement || "off",
    ...extra,
  });

  if (!registry || registry.enforcement === "off") return decision(true, "enforcement-disabled");

  // Founder authority is superior to any grant table, and so is an approval the
  // founder actually signed. Both are recorded rather than silent.
  if (actorType === "human") return decision(true, "founder-authority");
  if (founderApproval?.verified === true) return decision(true, "founder-approved-task");

  if (!CAPABILITIES.includes(capability)) return decision(false, "unknown-capability");
  if (!SAFE_ID.test(String(actorId || ""))) return decision(false, "unknown-actor");

  const matching = registry.grants.filter((grant) => grant.actorId === actorId && grant.capability === capability);
  if (matching.length === 0) return decision(false, "no-grant");

  const granted = matching.find((grant) => scopeCovers(grant, scope));
  return granted
    ? decision(true, "granted", { grantScope: { type: granted.scopeType, id: granted.scopeId } })
    : decision(false, "out-of-scope");
}

// Write the decision to the task's append-only audit log. Denials are the point
// — a control nobody can see the effect of is not a control — but grants are
// recorded too, so the log answers "who was allowed to do what" and not only
// "who was stopped".
export function recordPermissionDecision(auditPath, decision, { correlation = {}, now = () => new Date().toISOString() } = {}) {
  try {
    appendAuditEvent(auditPath, createAuditEvent({
      occurredAt: now(),
      actor: decision.actor,
      // A `report`-mode verdict is recorded as what it WOULD have been, so the
      // audit answers "what would enforcement have stopped" and not merely
      // "everything was allowed".
      action: decision.allowed && !decision.wouldDeny ? "permission.allowed" : "permission.denied",
      // The audit envelope's subject vocabulary is a closed set and does not
      // include "capability" — nor should it, because the thing being acted on
      // is the task or project. The capability is what was attempted, and lives
      // in `data`.
      subject: auditSubject(decision),
      correlation: sanitizeCorrelation(correlation),
      data: {
        capability: decision.capability,
        reason: decision.reason,
        enforcement: decision.enforcement,
        wouldDeny: decision.wouldDeny === true ? "true" : "false",
        scopeType: decision.scope.type,
        scopeId: decision.scope.id,
      },
    }, { now }));
    return { recorded: true };
  } catch (error) {
    // Auditing is best-effort in the same sense as dispatch telemetry: failing
    // to record a decision must not turn an allowed action into an outage.
    return { recorded: false, reason: String(error?.message || error) };
  }
}

// The convenience the entrypoints use: decide, record, and throw on denial.
export class PermissionDeniedError extends Error {
  constructor(decision) {
    super(`${decision.actor.id} is not permitted to ${decision.capability} (${decision.reason})`);
    this.name = "PermissionDeniedError";
    this.decision = decision;
  }
}

// `blastRadius` is an optional per-run tracker (#160). It counts how many
// distinct subjects one run has been allowed to act on and alerts when that
// crosses a threshold. It is ALERT-ONLY and cannot refuse anything: scope says
// which work an agent may touch, blast radius says how much, and the second has
// to be observed against real runs before it can stop any of them.
export function enforce({ registry, auditPath = null, correlation = {}, blastRadius = null, ...request }) {
  const decision = authorize({ registry, ...request });
  if (auditPath) recordPermissionDecision(auditPath, decision, { correlation });
  if (blastRadius) observeSubject({ tracker: blastRadius, decision, auditPath, correlation });
  if (!decision.allowed) throw new PermissionDeniedError(decision);
  return decision;
}

// ------------------------------------------------------------------ internals

function validateGrant(grant) {
  if (!grant || typeof grant !== "object") throw new Error("each grant must be an object");
  if (!SAFE_ID.test(String(grant.actorId || ""))) throw new Error("grant.actorId is invalid");
  if (FORBIDDEN_CAPABILITIES.includes(grant.capability)) {
    throw new Error(
      `grant for '${grant.actorId}' names '${grant.capability}', which this system must never confer. `
      + "Merge, deployment, deletion, secret, billing and publishing authority are governed by "
      + "factory.config.json prohibitedAutonomousActions and the founder approval signature.",
    );
  }
  if (!CAPABILITIES.includes(grant.capability)) {
    throw new Error(`grant for '${grant.actorId}' names unknown capability '${grant.capability}'`);
  }
  if (!SCOPE_TYPES.includes(grant.scopeType)) throw new Error(`grant for '${grant.actorId}' has invalid scopeType`);
  if (grant.scopeId !== WILDCARD && !SAFE_ID.test(String(grant.scopeId || ""))) {
    throw new Error(`grant for '${grant.actorId}' has invalid scopeId`);
  }
  if (String(grant.scopeId).split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`grant for '${grant.actorId}' has invalid scopeId`);
  }
}

// A `company` grant covers everything below it; a `project` grant covers tasks
// in that project; a `task` grant covers exactly that task. A request that does
// not say what it is acting on cannot match a narrower grant than `company`,
// so an under-specified request fails closed rather than matching everything.
function scopeCovers(grant, scope) {
  if (grant.scopeType === "company") return grant.scopeId === WILDCARD || grant.scopeId === (scope?.companyId || grant.scopeId);
  if (grant.scopeType === "project") {
    const projectId = scope?.projectId || (scope?.type === "project" ? scope.id : null);
    return Boolean(projectId) && (grant.scopeId === WILDCARD || grant.scopeId === projectId);
  }
  const taskId = scope?.type === "task" ? scope.id : scope?.taskId;
  return Boolean(taskId) && (grant.scopeId === WILDCARD || grant.scopeId === taskId);
}

const AUDIT_SUBJECT_TYPES = new Set(["task", "objective", "project", "agent", "run", "decision", "system"]);

function auditSubject(decision) {
  const type = decision.scope?.type;
  if (AUDIT_SUBJECT_TYPES.has(type) && SAFE_ID.test(String(decision.scope.id || ""))) {
    return { type, id: String(decision.scope.id) };
  }
  if (SAFE_ID.test(String(decision.scope?.projectId || ""))) {
    return { type: "project", id: String(decision.scope.projectId) };
  }
  return { type: "system", id: "factory" };
}

function sanitizeCorrelation(correlation) {
  const out = {};
  for (const [key, value] of Object.entries(correlation || {})) {
    if (value != null && SAFE_ID.test(key) && SAFE_ID.test(String(value))) out[key] = String(value);
  }
  return out;
}
