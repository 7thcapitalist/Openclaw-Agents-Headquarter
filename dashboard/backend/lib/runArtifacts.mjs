import { readFileSync, existsSync } from "fs";
import { join } from "path";

const ARTIFACTS_NAME = ".agent-lab-artifacts.json";

/**
 * Agents may write this file at the end of a run (JSON array).
 * Each item: { kind, title, detail?, path? } — see agents/README.md.
 * @param {string} agentRoot
 * @returns {object[] | null}
 */
export function readArtifactsFile(agentRoot) {
  const p = join(agentRoot, "outputs", ARTIFACTS_NAME);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8").trim();
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/**
 * Merge artifacts from cwd (working dir) and registered agent dir.
 * @param {string} cwd
 * @param {string} agentDir
 */
export function collectArtifactsAfterRun(cwd, agentDir) {
  const a = readArtifactsFile(cwd);
  const b = agentDir !== cwd ? readArtifactsFile(agentDir) : null;
  const merged = [];
  const seen = new Set();
  for (const row of [...(a || []), ...(b || [])]) {
    if (!row || typeof row !== "object") continue;
    const key = `${row.kind}|${row.title}|${row.path || ""}|${row.detail || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      kind: typeof row.kind === "string" ? row.kind : "note",
      title: typeof row.title === "string" ? row.title : "Output",
      detail: typeof row.detail === "string" ? row.detail : undefined,
      path: typeof row.path === "string" ? row.path : undefined,
    });
  }
  return merged;
}

/**
 * @param {string | null | undefined} raw
 * @returns {object[]}
 */
export function parseArtifactsJson(raw) {
  if (!raw || typeof raw !== "string") return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}
