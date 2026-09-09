import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, basename, join, resolve } from "path";
import { resolveProject, resolveRepoPath } from "../intel/registry.mjs";

const STATES = new Set(["not_deployed", "deploying", "deployed", "failed", "needs_founder_action"]);

function assertProjectKey(projectKey) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(projectKey || ""))) {
    throw new Error("deployment state: projectKey must be a lowercase slug.");
  }
}

export function deploymentStatePath(hqRoot, projectKey) {
  assertProjectKey(projectKey);
  const root = resolve(hqRoot);
  const entry = resolveProject(root, projectKey);
  const repoBase = entry ? basename(resolveRepoPath(root, entry)) : projectKey;
  return join(root, "dashboard", "backend", "data", "factory", repoBase, "deployments", `${projectKey}.json`);
}

export function readDeploymentState({ hqRoot, projectKey }) {
  const path = deploymentStatePath(hqRoot, projectKey);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || value.version !== 1 || value.projectKey !== projectKey || !STATES.has(value.state)) {
    throw new Error(`deployment state: ${path} is invalid.`);
  }
  return value;
}

export function writeDeploymentState({ hqRoot, projectKey, state }) {
  const path = deploymentStatePath(hqRoot, projectKey);
  if (!state || state.version !== 1 || state.projectKey !== projectKey || !STATES.has(state.state)) {
    throw new Error("deployment state: refusing to write an invalid record.");
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  return path;
}
