// The operator view of scoped permissions: what mode is in force, who is
// granted what, and — the part that matters — what has actually been denied.
//
// A control nobody can see the effect of is not a control. In `report` mode
// this view is the whole point: it answers "what would enforcement have
// stopped" before enforcement stops anything.

import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { readAuditEvents } from "../audit/envelope.mjs";
import { readPermissionRegistry } from "./permissions.mjs";
import { defaultStateRoot } from "./tasks.mjs";

export function buildPermissionsSnapshot({ hqRoot, stateRoot = null, now = new Date().toISOString(), limit = 20 } = {}) {
  const warnings = [];

  let registry = { version: 1, enforcement: "off", grants: [], present: false, path: null };
  try {
    registry = readPermissionRegistry(hqRoot);
  } catch (error) {
    // An unreadable registry is not "no permissions": task initialization
    // refuses outright in that state, so the operator has to see it as broken.
    warnings.push(`permission registry unreadable: ${error.message}`);
  }

  const decisions = readDecisions({ hqRoot, stateRoot, warnings, limit });
  const denied = decisions.filter((decision) => decision.action === "permission.denied");

  return {
    version: 1,
    asOf: now,
    available: warnings.length === 0,
    enforcement: registry.enforcement,
    configured: registry.present,
    warnings,
    grants: registry.grants.map((grant) => ({
      actorId: grant.actorId, capability: grant.capability, scopeType: grant.scopeType, scopeId: grant.scopeId,
    })),
    summary: {
      grants: registry.grants.length,
      actors: new Set(registry.grants.map((grant) => grant.actorId)).size,
      denials: denied.length,
      wouldDeny: denied.filter((decision) => decision.wouldDeny).length,
    },
    recentDenials: denied.slice(0, limit),
  };
}

// Decisions taken before a task directory exists land in the company-level log;
// per-task decisions land in the task's own audit.ndjson. Read both.
function readDecisions({ hqRoot, stateRoot, warnings, limit }) {
  const paths = [
    join(resolve(hqRoot), ".openclaw-factory", "telemetry", "permissions.ndjson"),
    ...auditFiles(resolve(stateRoot || defaultStateRoot(hqRoot))),
  ];
  const out = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      for (const event of readAuditEvents(path)) {
        if (event.action !== "permission.denied" && event.action !== "permission.allowed") continue;
        out.push({
          occurredAt: event.occurredAt,
          action: event.action,
          actorId: event.actor?.id || "unknown",
          capability: String(event.data?.capability || "unknown"),
          reason: String(event.data?.reason || "unknown"),
          enforcement: String(event.data?.enforcement || "unknown"),
          wouldDeny: event.data?.wouldDeny === "true",
          subject: { type: event.subject?.type || null, id: event.subject?.id || null },
        });
      }
    } catch (error) {
      warnings.push(`permission decisions unavailable at ${path}: ${error.message}`);
    }
  }
  return out.sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))).slice(0, limit * 4);
}

function auditFiles(root, out = []) {
  if (!existsSync(root)) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) auditFiles(path, out);
    else if (entry.isFile() && entry.name === "audit.ndjson") out.push(path);
  }
  return out;
}
