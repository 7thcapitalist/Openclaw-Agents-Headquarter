// The unified project registry.
//
// intel/registry.mjs owns the raw committed file (factory/projects.json). This
// module is the *company-level* view of a project: the registry entry, its
// structured intelligence brief, and — when the dashboard is running — the rich
// runtime project row, merged and keyed by project `key`.
//
// It is the thing that lets the founder ask "what projects do I have?" and get a
// real answer instead of one hard-coded key.
//
// Read-only. Never throws for missing data; a structurally broken
// factory/projects.json is the one real error and it is surfaced as a warning.

import { existsSync } from "fs";
import { readRegistry, resolveRepoPath } from "../intel/registry.mjs";
import { buildProjectBrief } from "../intel/project-brief.mjs";

/**
 * @param {object}  input
 * @param {string}  input.hqRoot
 * @param {Array}  [input.hqProjects]  rows from the dashboard HQ store (readProjects()), optional
 * @param {boolean}[input.withIntelligence=true]  attach the structured brief
 * @param {Date}   [input.now]
 * @returns {{ projects: Array, warnings: Array<{code:string,message:string}> }}
 */
export function listCompanyProjects({ hqRoot, hqProjects = [], withIntelligence = true, now = new Date() }) {
  const warnings = [];
  let registry;
  try {
    registry = readRegistry(hqRoot);
  } catch (error) {
    return { projects: [], warnings: [{ code: "registry-invalid", message: error.message }] };
  }

  const dashboardByKey = indexDashboardProjects(hqProjects);

  const projects = registry.projects.map((entry) => {
    const repo = safeRepoPath(hqRoot, entry, warnings);
    const brief = withIntelligence ? safeBrief({ hqRoot, entry, now, warnings }) : null;
    const dashboard = dashboardByKey.get(entry.key) || null;

    const mission =
      entry.mission ||
      brief?.mission ||
      dashboard?.mission ||
      dashboard?.description ||
      null;

    return {
      key: entry.key,
      name: entry.name || dashboard?.name || entry.key,
      repo,
      repoExists: repo ? existsSync(repo) : false,
      contextDir: entry.contextDir || "context",
      status: entry.status || dashboard?.status || "active",
      owner: entry.owner || "founder",
      mission,
      github: normaliseGithub(entry.github),
      responsibleAgents: Array.isArray(entry.responsibleAgents) ? entry.responsibleAgents : [],
      registered: true,
      hasContext: Boolean(brief?.registered && !hasCriticalContextGap(brief)),
      intelligence: brief,
      dashboard,
      risks: brief?.risks || [],
      openDecisions: brief?.ownership?.openDecisions || [],
      contextFindings: brief?.contextFindings || [],
    };
  });

  return { projects, warnings };
}

export function resolveCompanyProject(hqRoot, key, opts = {}) {
  return listCompanyProjects({ hqRoot, ...opts }).projects.find((p) => p.key === key) || null;
}

// ---- helpers ----

function indexDashboardProjects(hqProjects) {
  const map = new Map();
  for (const row of hqProjects || []) {
    if (!row) continue;
    const key = row.key || row.id;
    if (key) map.set(key, row);
  }
  return map;
}

function safeRepoPath(hqRoot, entry, warnings) {
  try {
    return resolveRepoPath(hqRoot, entry);
  } catch (error) {
    warnings.push({ code: `repo-unresolved:${entry.key}`, message: error.message });
    return null;
  }
}

function safeBrief({ hqRoot, entry, now, warnings }) {
  try {
    return buildProjectBrief({ hqRoot, entry, now });
  } catch (error) {
    warnings.push({ code: `brief-failed:${entry.key}`, message: error.message });
    return null;
  }
}

function normaliseGithub(github) {
  if (!github || typeof github !== "object") return null;
  if (!github.owner || !github.repo) return null;
  return { owner: String(github.owner), repo: String(github.repo) };
}

// "Has context" means the intelligence layer found a real context directory to
// read — not that every file is present. Individual missing/thin/stale files are
// findings surfaced separately, not a reason to call the project context-less.
function hasCriticalContextGap(brief) {
  return (brief.contextFindings || []).some((f) => f.code === "context-dir-missing");
}
