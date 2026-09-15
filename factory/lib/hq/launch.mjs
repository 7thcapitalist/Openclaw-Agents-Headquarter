// What the console needs in order to hand the factory work.
//
// Two lists, and nothing that acts:
//
//   * the projects that can actually be launched into — registered, pointing
//     at a real git tree, and not paused. A picker that offers a project the
//     machine will refuse is worse than a shorter picker, because the founder
//     only finds out after pressing a button that spends money.
//   * the overnight queue as it stands, so "Plan the night" can show what is
//     already planned rather than asking blind.
//
// Read-only, like every other panel. Starting work is an intent, executed by
// the machine after it polls; nothing on this side of the boundary runs
// anything. The console renders these lists and enqueues intents against them.
//
// It reads the dashboard's data files but imports no dashboard code:
// `factory/` must not depend on `dashboard/`, and the queue's own module lives
// there. The one thing it shares is the store primitive, which is a factory
// library that `overnightQueue.mjs` itself imports.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { readTransactionalState } from "../store/transactional-json.mjs";
import { readRegistry, resolveRepoPath } from "../intel/registry.mjs";
import { defaultStateRoot } from "./tasks.mjs";

export const LAUNCH_CONTRACT = "hq.launch/1";

// Mirrors dashboard/backend/lib/overnightQueue.mjs. Kept as constants rather
// than imported for the boundary reason above; the test asserts they agree.
export const OVERNIGHT_LIMIT = 8;
export const MAX_OBJECTIVE_LENGTH = 1000;

function controlPath(hqRoot) {
  return join(defaultStateRoot(hqRoot), "control-plane.json");
}

function queuePath(hqRoot) {
  return join(defaultStateRoot(hqRoot), "overnight-queue.json");
}

function pausedProjects(hqRoot) {
  try {
    const control = JSON.parse(readFileSync(controlPath(hqRoot), "utf8"));
    return new Set(Object.entries(control?.projects || {})
      .filter(([, value]) => value?.status === "paused")
      .map(([key]) => key));
  } catch {
    return new Set();
  }
}

export function launchableProjects({ hqRoot, warnings = [] }) {
  let entries = [];
  try {
    entries = readRegistry(hqRoot)?.projects || [];
  } catch (error) {
    warnings.push(`project registry unavailable: ${error.message}`);
    return [];
  }
  const paused = pausedProjects(hqRoot);
  return entries
    .filter((project) => project?.key)
    .map((project) => {
      const isPaused = paused.has(project.key);
      let hasRepo = false;
      try {
        hasRepo = existsSync(join(resolveRepoPath(hqRoot, project), ".git"));
      } catch { hasRepo = false; }
      return {
        key: project.key,
        name: project.name || project.key,
        // The factory working on itself is how most of this repository got
        // built, and the tunnel dashboard has always offered it —
        // `workTargets()` appends the headquarters entry and labels it
        // "(factory)". A console that cannot do what the tunnel does is the
        // complaint this screen exists to answer, so it is offered here too,
        // flagged and sorted last so it is never the accidental default.
        //
        // This is a LAUNCH target only. `company-state` still excludes the
        // headquarters from `company.projects`, because that panel feeds the
        // portfolio roll-up and counting the factory there would corrupt every
        // number in it.
        isHeadquarters: project.kind === "headquarters",
        // Why this project cannot be launched into, in the founder's words, or
        // null. The console shows the reason rather than hiding the row: "it
        // is not there" and "it is paused" are different problems.
        blockedReason: isPaused ? "paused" : !hasRepo ? "no git working tree on the machine" : null,
        launchable: !isPaused && hasRepo,
      };
    })
    // The factory sorts last whatever its state, so the thumb never lands on
    // it by accident; otherwise launchable first, then by name.
    .sort((a, b) =>
      Number(a.isHeadquarters) - Number(b.isHeadquarters)
      || Number(b.launchable) - Number(a.launchable)
      || a.name.localeCompare(b.name));
}

export function overnightPlan({ hqRoot, warnings = [] }) {
  let value = null;
  try {
    value = readTransactionalState(queuePath(hqRoot));
  } catch (error) {
    warnings.push(`overnight queue unavailable: ${error.message}`);
  }
  const items = Array.isArray(value?.items) ? value.items : [];
  return {
    status: typeof value?.status === "string" ? value.status : "idle",
    startedAt: value?.startedAt || null,
    stoppedAt: value?.stoppedAt || null,
    currentItemId: value?.currentItemId || null,
    limit: OVERNIGHT_LIMIT,
    // `repo` is deliberately dropped: it is a host path, the mirror would
    // redact it anyway, and the console has no use for it.
    items: items.map((item) => ({
      id: String(item?.id || ""),
      objective: String(item?.objective || ""),
      projectId: String(item?.projectId || ""),
      status: String(item?.status || "queued"),
      addedAt: item?.addedAt || null,
      startedAt: item?.startedAt || null,
      endedAt: item?.endedAt || null,
      error: item?.error || null,
    })),
  };
}

export function buildLaunchSnapshot({ hqRoot, now = new Date().toISOString() } = {}) {
  const warnings = [];
  const root = resolve(hqRoot);
  const projects = launchableProjects({ hqRoot: root, warnings });
  const overnight = overnightPlan({ hqRoot: root, warnings });
  return {
    version: 1,
    contract: LAUNCH_CONTRACT,
    asOf: now,
    available: true,
    readOnly: true,
    maxObjectiveLength: MAX_OBJECTIVE_LENGTH,
    projects,
    overnight,
    summary: {
      launchable: projects.filter((p) => p.launchable).length,
      projects: projects.length,
      queued: overnight.items.filter((item) => item.status === "queued").length,
      running: overnight.status === "running",
    },
    warnings,
  };
}
