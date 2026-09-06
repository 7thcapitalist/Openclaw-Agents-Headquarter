// A minimal, read-only projection of factory task state for the Integration
// Layer's CLI and any non-dashboard caller.
//
// The Founder Control Plane's `taskView` (dashboard/backend/lib/
// founderControlPlane.mjs) is the RICHER canonical projection — it also parses
// Decision Cards and recent events. This is intentionally just the handful of
// fields hq/activity.mjs and hq/company-state.mjs consume, so the factory
// library has no dependency on the dashboard.

import { existsSync, readdirSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { readState } from "../task-workflow.mjs";

// Default location the dashboard/factory writes task state to.
export function defaultStateRoot(hqRoot) {
  return join(resolve(hqRoot), "dashboard", "backend", "data", "factory");
}

export function discoverTaskViews({ hqRoot, stateRoot = null } = {}) {
  const root = stateRoot ? resolve(stateRoot) : defaultStateRoot(hqRoot);
  const views = [];
  for (const path of walkStateFiles(root)) {
    try {
      views.push(project(readState(path), path));
    } catch (error) {
      views.push({ id: basename(dirname(path)), statePath: path, status: "invalid", error: error.message });
    }
  }
  return views.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function project(state, path) {
  const dispatch = state.currentDispatch || null;
  return {
    id: state.task?.id,
    objective: state.task?.outcome || null,
    project: state.task?.project || (state.repo ? basename(state.repo) : null),
    repo: state.repo || null,
    statePath: path,
    status: state.status,
    stage: state.currentStage || null,
    agent: dispatch?.actor || (state.currentStage ? state.assignments?.[state.currentStage] : null) || null,
    agentStatus: dispatch?.status || (state.status === "active" ? "waiting" : state.status),
    blocker: state.blocker || null,
    branch: state.branch || null,
    risk: state.task?.risk || null,
    createdAt: state.createdAt || null,
    updatedAt: state.updatedAt || safeMtime(path),
  };
}

function walkStateFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkStateFiles(path, out);
    else if (entry.isFile() && entry.name === "state.json") out.push(path);
  }
  return out;
}

function safeMtime(path) {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}
