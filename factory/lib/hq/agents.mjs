// The agent registry — the company's awareness of its own employees.
//
// factory/agents.json is the committed source of truth for the WORKFORCE: one
// entry per agent (a role/employee), never one per model. Models — Claude,
// Codex, Cursor, OpenClaw — are the tools that power an agent; each agent
// declares the `harness` (model/tool family) that powers its default work and
// the OpenClaw `runtimeAgentId` that executes it.
//
// Live activity ("what is this employee doing right now?") is derived separately
// in activity.mjs from structured task-state events + the OpenClaw runtime.
//
// Same style as intel/schema.mjs: a hand-rolled validator is the runtime check,
// factory/schemas/agents.schema.json is the reference contract. No dependency.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

// Kept for backward compatibility with older registries; new registries use
// `harness` instead. "learning" was a legacy value that meant the R&D agent.
export const AGENT_KINDS = new Set(["claude", "codex", "openclaw", "cursor", "learning", "other"]);
// The model / tool families that can power an agent. `multiple` = the agent is
// deliberately routed to whichever model is NOT the builder (reviewer, qa).
// `none` = the agent is not model-backed on a schedule (e.g. Research Agent).
export const AGENT_HARNESSES = new Set(["claude", "codex", "cursor", "openclaw", "multiple", "none"]);
export const AGENT_STATUSES = new Set(["working", "idle", "waiting", "blocked", "needs-founder", "offline", "disabled"]);
export const AGENT_AVAILABILITY = new Set(["available", "busy", "paused", "offline"]);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function agentRegistryPath(hqRoot) {
  return join(resolve(hqRoot), "factory", "agents.json");
}

// Read + validate. A missing file returns an empty registry (not an error); a
// malformed file throws — that is a real misconfiguration.
export function readAgentRegistry(hqRoot) {
  const path = agentRegistryPath(hqRoot);
  if (!existsSync(path)) return { version: 1, agents: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`agents: ${path} is not valid JSON: ${error.message}`);
  }
  return validateAgentRegistry(parsed);
}

export function validateAgentRegistry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agents: must be a JSON object.");
  }
  if (value.version !== 1) throw new Error("agents: version must be 1.");
  if (!Array.isArray(value.agents)) throw new Error("agents: agents must be an array.");
  const seen = new Set();
  for (const [i, agent] of value.agents.entries()) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      throw new Error(`agents: agents[${i}] must be an object.`);
    }
    if (!ID_RE.test(String(agent.id || ""))) {
      throw new Error(`agents: agents[${i}].id must be a lowercase slug.`);
    }
    if (seen.has(agent.id)) throw new Error(`agents: duplicate id ${agent.id}.`);
    seen.add(agent.id);
    if (typeof agent.name !== "string" || !agent.name.trim()) {
      throw new Error(`agents: agents[${i}].name is required.`);
    }
    if (typeof agent.role !== "string" || !agent.role.trim()) {
      throw new Error(`agents: agents[${i}].role is required.`);
    }
    if (agent.responsibility !== undefined && typeof agent.responsibility !== "string") {
      throw new Error(`agents: agents[${i}].responsibility must be a string.`);
    }
    if (agent.kind !== undefined && !AGENT_KINDS.has(agent.kind)) {
      throw new Error(`agents: agents[${i}].kind is invalid (${[...AGENT_KINDS].join(", ")}).`);
    }
    if (agent.harness !== undefined && !AGENT_HARNESSES.has(agent.harness)) {
      throw new Error(`agents: agents[${i}].harness is invalid (${[...AGENT_HARNESSES].join(", ")}).`);
    }
    if (agent.harnessAvailable !== undefined && typeof agent.harnessAvailable !== "boolean") {
      throw new Error(`agents: agents[${i}].harnessAvailable must be a boolean.`);
    }
    if (agent.harnessFallback !== undefined && agent.harnessFallback !== null && !AGENT_HARNESSES.has(agent.harnessFallback)) {
      throw new Error(`agents: agents[${i}].harnessFallback is invalid (${[...AGENT_HARNESSES].join(", ")}).`);
    }
    if (agent.status !== undefined && !AGENT_STATUSES.has(agent.status)) {
      throw new Error(`agents: agents[${i}].status is invalid (${[...AGENT_STATUSES].join(", ")}).`);
    }
    if (agent.stages !== undefined) {
      if (!Array.isArray(agent.stages) || !agent.stages.every((s) => typeof s === "string")) {
        throw new Error(`agents: agents[${i}].stages must be an array of stage names.`);
      }
    }
    if (agent.capabilities !== undefined) {
      if (!Array.isArray(agent.capabilities) || !agent.capabilities.every((c) => ID_RE.test(String(c)))) {
        throw new Error(`agents: agents[${i}].capabilities must be an array of strings.`);
      }
    }
    if (agent.availability !== undefined && !AGENT_AVAILABILITY.has(agent.availability)) {
      throw new Error(`agents: agents[${i}].availability is invalid.`);
    }
    if (agent.adapter !== undefined) validateAdapter(agent.adapter, i);
    if (agent.budgetPolicy !== undefined) validateBudgetPolicy(agent.budgetPolicy, i);
    if (agent.currentProject !== undefined && agent.currentProject !== null &&
      !ID_RE.test(String(agent.currentProject))) {
      throw new Error(`agents: agents[${i}].currentProject must be a project key or null.`);
    }
    if (agent.runtimeAgentId !== undefined && agent.runtimeAgentId !== null &&
      typeof agent.runtimeAgentId !== "string") {
      throw new Error(`agents: agents[${i}].runtimeAgentId must be a string or null.`);
    }
    if (agent.harnessAgentId !== undefined && typeof agent.harnessAgentId !== "string") {
      throw new Error(`agents: agents[${i}].harnessAgentId must be a string.`);
    }
    if (agent.harnessAgentIds !== undefined) {
      if (!Array.isArray(agent.harnessAgentIds) || !agent.harnessAgentIds.every((x) => typeof x === "string")) {
        throw new Error(`agents: agents[${i}].harnessAgentIds must be an array of strings.`);
      }
    }
    if (agent.reportsTo !== undefined && agent.reportsTo !== null && !ID_RE.test(String(agent.reportsTo))) {
      throw new Error(`agents: agents[${i}].reportsTo must be an agent id, founder, or null.`);
    }
  }
  validateReportingGraph(value.agents, seen);
  return value;
}

// Non-throwing check, for lint-style callers.
export function isAgentRegistryShape(value) {
  try {
    validateAgentRegistry(value);
    return true;
  } catch {
    return false;
  }
}

// Normalised agent rows with defaults filled in. Never throws — a broken file
// yields an empty list plus a warning so the company view still renders.
export function listAgents(hqRoot) {
  let registry;
  try {
    registry = readAgentRegistry(hqRoot);
  } catch (error) {
    return { agents: [], warnings: [{ code: "agent-registry-invalid", message: error.message }] };
  }
  const agents = registry.agents.map((a) => {
    // `harness` is the modern field; fall back to the legacy `kind` value, which
    // used to double as the model family.
    const harness = a.harness
      || (a.kind && AGENT_HARNESSES.has(a.kind) ? a.kind : null)
      || (a.kind === "learning" ? "openclaw" : null)
      || "none";
    const harnessAgentIds = dedupe([
      ...(a.runtimeAgentId ? [a.runtimeAgentId] : []),
      ...(a.harnessAgentId ? [a.harnessAgentId] : []),
      ...(Array.isArray(a.harnessAgentIds) ? a.harnessAgentIds : []),
    ]);
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      responsibility: a.responsibility || a.role,
      kind: a.kind || (a.harness === "multiple" || a.harness === "none" ? "other" : a.harness) || "other",
      harness,
      // `harnessAvailable: false` means the declared `harness` above is the
      // *intended* one but does not currently work reliably (e.g. an ACP
      // integration that silently falls back) — `harnessFallback` names what
      // actually executes the role's work today. Real, verified state, not a
      // guess: see the agent's `notes` for how this was confirmed.
      harnessAvailable: a.harnessAvailable !== false,
      harnessFallback: a.harnessFallback || null,
      stages: Array.isArray(a.stages) ? a.stages : [],
      capabilities: Array.isArray(a.capabilities) ? a.capabilities : [],
      availability: a.availability || (a.status === "offline" ? "offline" : a.status === "disabled" ? "paused" : "available"),
      adapter: a.adapter || null,
      budgetPolicy: a.budgetPolicy || null,
      currentProject: a.currentProject || null,
      status: a.status || "idle",
      runtimeAgentId: a.runtimeAgentId !== undefined ? a.runtimeAgentId : (harnessAgentIds[0] || a.id),
      harnessAgentId: a.harnessAgentId || null,
      harnessAgentIds,
      reportsTo: a.reportsTo || null,
      orgMetadataIsAuthority: false,
      notes: a.notes || null,
    };
  });
  return { agents, warnings: [] };
}

function validateAdapter(adapter, index) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter) || typeof adapter.type !== "string" || !adapter.type.trim()) throw new Error(`agents: agents[${index}].adapter.type is required.`);
  if (adapter.secretRefs !== undefined && (!Array.isArray(adapter.secretRefs) || !adapter.secretRefs.every((x) => ID_RE.test(String(x))))) throw new Error(`agents: agents[${index}].adapter.secretRefs must contain reference ids only.`);
  for (const key of Object.keys(adapter)) if (!["type", "secretRefs"].includes(key)) throw new Error(`agents: agents[${index}].adapter.${key} is not allowed.`);
}

function validateBudgetPolicy(policy, index) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error(`agents: agents[${index}].budgetPolicy must be an object.`);
  if (policy.monthlyCents !== undefined && (!Number.isInteger(policy.monthlyCents) || policy.monthlyCents < 0)) throw new Error(`agents: agents[${index}].budgetPolicy.monthlyCents is invalid.`);
  if (policy.alertPercent !== undefined && (!Number.isInteger(policy.alertPercent) || policy.alertPercent < 1 || policy.alertPercent > 100)) throw new Error(`agents: agents[${index}].budgetPolicy.alertPercent is invalid.`);
  if (policy.hardStop !== undefined && typeof policy.hardStop !== "boolean") throw new Error(`agents: agents[${index}].budgetPolicy.hardStop must be boolean.`);
}

function validateReportingGraph(agents, ids) {
  for (const agent of agents) if (agent.reportsTo && agent.reportsTo !== "founder" && !ids.has(agent.reportsTo)) throw new Error(`agents: ${agent.id} reports to unknown agent ${agent.reportsTo}.`);
  for (const agent of agents) {
    const path = new Set([agent.id]); let current = agent;
    while (current?.reportsTo && current.reportsTo !== "founder") {
      if (path.has(current.reportsTo)) throw new Error(`agents: reporting cycle includes ${current.reportsTo}.`);
      path.add(current.reportsTo); current = agents.find((candidate) => candidate.id === current.reportsTo);
    }
  }
}

export function resolveAgent(hqRoot, id) {
  return listAgents(hqRoot).agents.find((a) => a.id === id) || null;
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}
