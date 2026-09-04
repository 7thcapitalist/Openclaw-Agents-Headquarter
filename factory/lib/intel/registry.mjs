import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { validateRegistry } from "./schema.mjs";

// Path to the committed project registry.
export function registryPath(hqRoot) {
  return join(resolve(hqRoot), "factory", "projects.json");
}

// Read + validate the registry. A missing file is not an error (returns an empty
// registry); a malformed file throws — that is a real misconfiguration.
export function readRegistry(hqRoot) {
  const path = registryPath(hqRoot);
  if (!existsSync(path)) return { version: 1, projects: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`registry: ${path} is not valid JSON: ${error.message}`);
  }
  return validateRegistry(parsed);
}

// One entry by key, or null.
export function resolveProject(hqRoot, key) {
  return readRegistry(hqRoot).projects.find((entry) => entry.key === key) || null;
}

// Resolve an entry's `repo` to an absolute path.
//   "."       -> hqRoot
//   "~/x"     -> home-expanded
//   "/abs/x"  -> unchanged
//   "rel/x"   -> resolved against hqRoot
export function resolveRepoPath(hqRoot, entry) {
  const repo = String(entry.repo || ".");
  if (repo === "." || repo === "./") return resolve(hqRoot);
  if (repo === "~" || repo.startsWith("~/")) return join(homedir(), repo.slice(1).replace(/^\//, ""));
  if (isAbsolute(repo)) return repo;
  return resolve(hqRoot, repo);
}

// The helper handoff.mjs / assemble.mjs use. Never throws for an unknown key.
//   registered key -> the real entry
//   unknown key    -> synthetic { contextDir: null, status: "unregistered" }
//                     pointing at state.repo so the assembler can still degrade cleanly.
export function resolveProjectForState(hqRoot, state) {
  const key = state?.task?.project || null;
  if (key) {
    const entry = resolveProject(hqRoot, key);
    if (entry) return { name: entry.key, contextDir: "context", status: "active", ...entry };
  }
  return {
    key: key || "unknown",
    name: key || "unknown",
    repo: state?.repo || ".",
    contextDir: null,
    status: "unregistered",
  };
}
