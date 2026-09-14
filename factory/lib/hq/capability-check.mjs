// One place that asks the permission registry a question.
//
// `task-initializer.mjs` has carried this ten lines since scoped permissions
// landed, and every capability wired after it needs the same ten: read the
// registry, refuse loudly if it is unreadable, return early when enforcement is
// off, then `enforce`. Six hand-written copies of a policy decision is how one
// of them quietly ends up missing the early return — and a permission check
// that denies when its config is absent is an outage, not a control.
//
// Nothing here is new authority. This module only calls `enforce`, which is
// strictly subtractive: it can deny, never grant. See hq/permissions.mjs.

import { join, resolve } from "node:path";

import { enforce, readPermissionRegistry } from "./permissions.mjs";

/** Where permission decisions are recorded, for a given HQ root. */
export function permissionAuditPath(hqRoot) {
  return join(resolve(hqRoot), ".openclaw-factory", "telemetry", "permissions.ndjson");
}

/**
 * Ask whether `actor` may exercise `capability` in `scope`.
 *
 * Returns the decision when one was computed, or `null` when the question was
 * not asked at all — no `hqRoot` to find a registry with, or a factory running
 * with enforcement off. Callers do not need to branch on that: the point of
 * this function is the throw that does not happen in `report` mode.
 *
 * Throws `PermissionDeniedError` only under `mode: "enforce"`. Under `report`
 * the decision is computed and audited exactly as it would be, then allowed —
 * so a wired call site changes nothing about how the factory behaves until the
 * founder deliberately switches modes.
 *
 * @param {object}    input
 * @param {string}    input.hqRoot          HQ root; without it no check is possible
 * @param {string}    input.capability      one of hq/permissions.mjs CAPABILITIES
 * @param {object}    input.scope           `{ type, id, projectId? }`
 * @param {object}   [input.actor]          `{ type, id }`; defaults to the factory itself
 * @param {object}   [input.founderApproval] a verified approval always allows
 * @param {object}   [input.correlation]    ids recorded alongside the decision
 * @param {string}   [input.action]         what is being refused, for the unreadable-registry message
 */
export function checkCapability({
  hqRoot,
  capability,
  scope,
  actor = null,
  founderApproval = null,
  correlation = {},
  action = capability,
}) {
  if (!hqRoot) return null;

  let registry;
  try {
    registry = readPermissionRegistry(hqRoot);
  } catch (error) {
    // A registry that exists but will not parse is the one case worth stopping
    // for: the operator meant to constrain this factory and we cannot tell how.
    throw new Error(`permission registry is unreadable, refusing to ${action}: ${error.message}`);
  }
  if (registry.enforcement === "off") return null;

  return enforce({
    registry,
    auditPath: permissionAuditPath(hqRoot),
    // The factory itself is the actor when no agent is named. Kept identical to
    // the value task-initializer.mjs has always sent, so the grant table that
    // covers task.initialize covers these too.
    actorType: actor?.type || "agent",
    actorId: actor?.id || "openclaw-factory",
    capability,
    scope,
    founderApproval,
    correlation,
  });
}
