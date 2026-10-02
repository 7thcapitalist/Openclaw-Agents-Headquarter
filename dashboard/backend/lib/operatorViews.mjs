// What an operator sees at GET /api/founder/overview.
//
// The founder's overview carries state-file paths, repo paths, the founder's
// questions to the Chief of Staff, open decisions and company intel. An
// operator needs to know what exists and what is running, nothing more. Every
// field below is copied by name — nothing is spread from a source object — so
// a field added to the founder's view later cannot leak into this one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildObjectivesView, isProjectPaused, listFounderJobs } from "./founderControlPlane.mjs";

function registeredProjects(root) {
  try {
    const registry = JSON.parse(readFileSync(join(root, "factory", "projects.json"), "utf8"));
    return Array.isArray(registry?.projects) ? registry.projects : [];
  } catch {
    return [];
  }
}

export function buildOperatorOverview(root) {
  const projects = registeredProjects(root)
    .filter((project) => typeof project?.key === "string")
    .map((project) => ({
      id: project.key,
      name: typeof project.name === "string" ? project.name : project.key,
      paused: project.status === "paused" || isProjectPaused(root, project.key),
    }));

  const jobs = listFounderJobs(root).map((job) => ({
    id: job.id,
    status: job.status ?? null,
    storedStatus: job.storedStatus ?? null,
    objectiveId: job.objectiveId ?? null,
    taskId: job.taskId ?? null,
    projectId: job.projectId ?? null,
    createdAt: job.createdAt ?? null,
    submittedBy: job.submittedBy ?? null,
  }));

  const objectives = (buildObjectivesView(root).objectives || []).map((objective) => ({
    id: objective.objectiveId,
    status: objective.status ?? null,
    nodes: (objective.nodes || []).map((node) => ({ id: node.id ?? null, status: node.status ?? null })),
  }));

  return { projects, jobs, objectives };
}
