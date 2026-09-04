// The agent registry — the company's awareness of its own employees.
//
// factory/agents.json is the committed source of truth for *who* the workers
// are (Claude, Codex, OpenClaw agents, the Learning Agent, future agents). It is
// deliberately small: identity, capability, current assignment, status. Live
// activity ("what is this worker doing right now?") is derived separately in
// activity.mjs from structured task-state events.
//
// Same style as intel/schema.mjs: a hand-rolled validator is the runtime check,
// factory/schemas/agents.schema.json is the reference contract. No dependency.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

export const AGENT_KINDS = new Set(["claude", "codex", "openclaw", "cursor", "learning", "other"]);
export const AGENT_STATUSES = new Set(["working", "idle", "blocked", "offline", "disabled"]);
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
    if (agent.kind !== undefined && !AGENT_KINDS.has(agent.kind)) {
      throw new Error(`agents: agents[${i}].kind is invalid (${[...AGENT_KINDS].join(", ")}).`);
    }
    if (agent.status !== undefined && !AGENT_STATUSES.has(agent.status)) {
      throw new Error(`agents: agents[${i}].status is invalid (${[...AGENT_STATUSES].join(", ")}).`);
    }
    if (agent.capabilities !== undefined) {
      if (!Array.isArray(agent.capabilities) || !agent.capabilities.every((c) => typeof c === "string")) {
        throw new Error(`agents: agents[${i}].capabilities must be an array of strings.`);
      }
    }
    if (agent.currentProject !== undefined && agent.currentProject !== null &&
      !ID_RE.test(String(agent.currentProject))) {
      throw new Error(`agents: agents[${i}].currentProject must be a project key or null.`);
    }
    if (agent.harnessAgentId !== undefined && typeof agent.harnessAgentId !== "string") {
      throw new Error(`agents: agents[${i}].harnessAgentId must be a string.`);
    }
    if (agent.harnessAgentIds !== undefined) {
      if (!Array.isArray(agent.harnessAgentIds) || !agent.harnessAgentIds.every((x) => typeof x === "string")) {
        throw new Error(`agents: agents[${i}].harnessAgentIds must be an array of strings.`);
      }
    }
  }
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
  const agents = registry.agents.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind || "other",
    role: a.role,
    capabilities: Array.isArray(a.capabilities) ? a.capabilities : [],
    currentProject: a.currentProject || null,
    status: a.status || "idle",
    harnessAgentId: a.harnessAgentId || null,
    harnessAgentIds: dedupe([
      ...(a.harnessAgentId ? [a.harnessAgentId] : []),
      ...(Array.isArray(a.harnessAgentIds) ? a.harnessAgentIds : []),
    ]),
    reportsTo: a.reportsTo || null,
    notes: a.notes || null,
  }));
  return { agents, warnings: [] };
}

export function resolveAgent(hqRoot, id) {
  return listAgents(hqRoot).agents.find((a) => a.id === id) || null;
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}
