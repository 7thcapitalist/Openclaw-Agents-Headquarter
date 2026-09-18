import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ACTIVE = new Set(["starting", "decomposing", "planned", "active", "running", "recovering", "incomplete", "integration-blocked", "yielded"]);

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function walkObjectives(root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkObjectives(path, out);
    else if (entry.name === "objective-state.json") out.push(readJson(path));
  }
  return out.filter(Boolean);
}

export function shouldYieldSelfImprovement({ objective, objectivePath, hqRoot, stateRoot } = {}) {
  const current = objective || readJson(objectivePath);
  if (current?.origin !== "learning-agent") return false;
  const factoryRoot = stateRoot ? join(stateRoot, "..") : join(hqRoot, "dashboard", "backend", "data", "factory");
  const founderObjective = walkObjectives(factoryRoot).some((item) => item?.objectiveId !== current.objectiveId && item?.origin !== "learning-agent" && ACTIVE.has(item?.status));
  if (founderObjective) return true;
  const control = readJson(join(hqRoot, "dashboard", "backend", "data", "factory", "control-plane.json"), {});
  if ((control.jobs || []).some((job) => job?.origin !== "learning-agent" && ACTIVE.has(job?.status))) return true;
  const overnight = readJson(join(hqRoot, "dashboard", "backend", "data", "factory", "overnight-queue.json"), {});
  return (overnight.items || []).some((item) => item?.status === "queued" || item?.status === "running");
}
