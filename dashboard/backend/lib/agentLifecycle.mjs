import { statSync } from "fs";
import { join, resolve } from "path";
import { agentDir, agentKey } from "./paths.mjs";

export const AGENT_LIFECYCLE_STATUSES = [
  "idea",
  "designed",
  "scaffolded",
  "runnable",
  "scheduled",
  "active",
  "disabled",
  "failed",
];

export function normalizeLifecycleStatus(value, fallback = "idea") {
  const status = String(value || fallback).toLowerCase();
  return AGENT_LIFECYCLE_STATUSES.includes(status) ? status : fallback;
}

export function agentFolderReadiness(root, project, id) {
  const dir = agentDir(root, project, id);
  const checks = {
    folder: isDirectory(dir),
    config: isFile(join(dir, "agent.config.json")),
    prompt: isFile(join(dir, "prompt.md")),
    run: isFile(join(dir, "run.sh")),
    logs: isDirectory(join(dir, "logs")),
    outputs: isDirectory(join(dir, "outputs")),
  };
  const runnable = Object.values(checks).every(Boolean);
  return {
    agentKey: agentKey(project, id),
    project,
    id,
    path: dir,
    checks,
    runnable,
    missing: Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name),
  };
}

export function enrichHqAgentsWithLifecycle(root, hqAgents, labAgents) {
  const labByKey = new Map((labAgents || []).map((a) => [a.agentKey, a]));
  return (hqAgents || []).map((agent) => {
    const existingKey =
      typeof agent.existingAgentKey === "string" && agent.existingAgentKey.includes("/")
        ? agent.existingAgentKey
        : agent.projectId && agent.id
          ? `${agent.projectId}/${agent.id}`
          : "";
    const lab = existingKey ? labByKey.get(existingKey) : null;
    const [project, id] = existingKey ? existingKey.split("/") : [];
    const folder =
      project && id ? safeFolderReadiness(root, project, id) : null;
    const isExecutable = Boolean(lab && folder?.runnable);
    const lifecycleStatus = deriveLifecycleStatus(agent, lab, folder);
    return {
      ...agent,
      lifecycleStatus,
      executable: isExecutable,
      agentKind: isExecutable ? "executable-agent" : "conceptual-persona",
      realAgentKey: isExecutable ? existingKey : null,
      promotion: {
        candidateKey: existingKey || null,
        folderExists: Boolean(folder?.checks?.folder),
        runnableFolder: Boolean(folder?.runnable),
        registered: Boolean(lab),
        missing: folder?.missing || [],
      },
      labAgent: lab || null,
    };
  });
}

export function countConceptualAgents(hqAgents) {
  return (hqAgents || []).filter((a) => a.agentKind !== "executable-agent").length;
}

function deriveLifecycleStatus(agent, lab, folder) {
  const raw = normalizeLifecycleStatus(agent.lifecycleStatus || agent.status, "");
  if (raw === "disabled" || raw === "failed") return raw;
  if (lab?.lastRun?.status === "failed") return "failed";
  if (lab && folder?.runnable) {
    const type = String(lab.config?.type || agent.type || "").toLowerCase();
    if (type === "scheduled") return "scheduled";
    if (String(lab.config?.status || agent.status || "").toLowerCase() === "active") {
      return "active";
    }
    return "runnable";
  }
  if (folder?.checks?.folder) return "scaffolded";
  if (raw) return raw;
  if (agent.projectId || agent.role || agent.description) return "designed";
  return "idea";
}

function safeFolderReadiness(root, project, id) {
  try {
    return agentFolderReadiness(root, project, id);
  } catch {
    return null;
  }
}

function isFile(path) {
  try {
    const st = statSync(resolve(path));
    return st.isFile();
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    const st = statSync(resolve(path));
    return st.isDirectory();
  } catch {
    return false;
  }
}
