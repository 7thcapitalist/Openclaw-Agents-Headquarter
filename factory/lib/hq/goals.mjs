// Hierarchical company -> project -> objective goals.
//
// Adapted from Paperclip's `goals` service (server/src/services/goals.ts) at
// pinned commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). Paperclip
// stores a goal's `status` as an editable column. HQ deliberately does not:
// a goal here carries founder INTENT (title, level, parent, what canonical
// work it maps to) and nothing else. Every status and percentage in a
// projection is derived from canonical objective/task state, so no agent can
// report a goal complete without delivery evidence, and a goal can never
// become a second, competing workflow state.
//
// Goal definitions live in `factory/goals.json`, tracked in Git, so changing
// company intent is a reviewed pull request like any other change. There is no
// runtime write path.

import { existsSync, readFileSync, readdirSync } from "fs";
import { assertSupportedVersion } from "../store/durable-version.mjs";
import { join, resolve } from "path";
import { defaultStateRoot } from "./tasks.mjs";

const LEVELS = ["company", "project", "objective"];
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const MAX_TITLE = 300;
const MAX_GOALS = 500;

// Status buckets. Canonical state reaches this module in three vocabularies and
// two cases: node statuses written by the objective orchestrator
// (`gate-satisfied`, `published`, `skipped`, `blocked-by-dep`), task workflow
// statuses (`merge-ready`, `blocked`), and the uppercase founder-facing
// `status6` from presenter.mjs (`COMPLETE`, `WAITING_FOR_FOUNDER`, ...).
// Everything is lowercased before lookup, so a projection never depends on
// which layer supplied the value.
const COMPLETE = new Set(["completed", "complete", "merged", "merge-ready", "satisfied", "gate-satisfied", "published", "skipped"]);
const BLOCKED = new Set(["blocked", "failed", "needs-attention", "blocked-by-dep", "waiting_for_founder", "decision-required"]);
const ACTIVE = new Set(["active", "running", "building", "ready", "recovering"]);
const PENDING = new Set(["pending", "queued", "not-started", "waiting"]);

const UNAVAILABLE = Object.freeze({ state: "unavailable", percent: 0, total: 0, complete: 0, blocked: 0, active: 0, unknown: 0 });

// ---------------------------------------------------------------- validation

// Throw on anything that would make a rollup meaningless: unusable ids,
// duplicates, unknown or wrongly-levelled parents, cycles, or a child that
// belongs to a different project than its parent.
export function validateGoalTree(goals) {
  if (!Array.isArray(goals)) throw new Error("goals must be an array");
  if (goals.length > MAX_GOALS) throw new Error(`goal registry holds more than ${MAX_GOALS} goals`);

  const byId = new Map();
  for (const goal of goals) {
    safe(goal?.id, "goal.id");
    if (byId.has(goal.id)) throw new Error(`duplicate goal '${goal.id}'`);
    if (!LEVELS.includes(goal.level)) throw new Error(`goal '${goal.id}' has invalid level`);
    if (typeof goal.title !== "string" || !goal.title.trim() || goal.title.length > MAX_TITLE) throw new Error(`goal '${goal.id}' title is invalid`);
    if (goal.parentId != null) safe(goal.parentId, "goal.parentId");
    if (goal.projectId != null) safe(goal.projectId, "goal.projectId");
    if (goal.objectiveId != null) safe(goal.objectiveId, "goal.objectiveId");
    byId.set(goal.id, goal);
  }

  for (const goal of goals) {
    const parent = goal.parentId ? byId.get(goal.parentId) : null;
    if (goal.level === "company" && goal.parentId != null) throw new Error(`company goal '${goal.id}' cannot have a parent`);
    if (goal.level !== "company" && !goal.parentId) throw new Error(`goal '${goal.id}' requires a parent`);
    if (goal.parentId && !parent) throw new Error(`goal '${goal.id}' has unknown parent '${goal.parentId}'`);
    if (parent && LEVELS.indexOf(parent.level) >= LEVELS.indexOf(goal.level)) throw new Error(`goal '${goal.id}' parent level is invalid`);
    if (goal.level === "project" && !goal.projectId) throw new Error(`project goal '${goal.id}' requires projectId`);
    if (goal.level === "objective" && (!goal.projectId || !goal.objectiveId)) throw new Error(`objective goal '${goal.id}' requires projectId and objectiveId`);
    if (parent?.projectId && goal.projectId !== parent.projectId) throw new Error(`goal '${goal.id}' crosses project scope`);
  }

  for (const goal of goals) visit(goal.id, byId, new Set());
  return goals;
}

// --------------------------------------------------------------- projection

// Derive one goal tree with progress rolled up from canonical work. `objectives`
// and `tasks` are the canonical records; a goal that maps to work HQ cannot see
// reports `unavailable` rather than inventing 0%.
export function projectGoals({ goals, objectives = [], tasks = [] }) {
  validateGoalTree(goals);

  const objectiveById = new Map(objectives.map((item) => [item.objectiveId || item.id, item]));
  const objectivesByProject = new Map();
  for (const objective of objectives) {
    const projectId = objective.projectId || objective.project;
    if (!projectId) continue;
    if (!objectivesByProject.has(projectId)) objectivesByProject.set(projectId, []);
    objectivesByProject.get(projectId).push(objective.objectiveId || objective.id);
  }

  const tasksByObjective = new Map();
  for (const task of tasks) {
    const objectiveId = task.objectiveId || task.parentObjectiveId;
    if (!objectiveId) continue;
    if (!tasksByObjective.has(objectiveId)) tasksByObjective.set(objectiveId, []);
    tasksByObjective.get(objectiveId).push(task);
  }

  const byId = new Map(goals.map((goal) => [goal.id, goal]));
  const childIds = new Map(goals.map((goal) => [goal.id, []]));
  for (const goal of goals) if (goal.parentId) childIds.get(goal.parentId).push(goal.id);

  const projected = new Map();
  const derive = (id) => {
    if (projected.has(id)) return projected.get(id);
    const goal = byId.get(id);
    const children = childIds.get(id).map(derive);
    // A leaf's progress comes from its own canonical work; a parent's is the
    // sum of its leaves, so one blocked task is visible from the company level.
    // A project goal with no objective-goal children is still a leaf: it rolls
    // up every canonical objective in its project, so a founder gets a real
    // number from naming a project alone, without enumerating each objective.
    const scopedObjectiveIds = goal.level === "objective"
      ? [goal.objectiveId]
      : (goal.level === "project" && children.length === 0 ? (objectivesByProject.get(goal.projectId) || []) : null);
    const progress = scopedObjectiveIds
      ? aggregate(scopedObjectiveIds.map((objectiveId) => ({
        progress: objectiveProgress(objectiveById.get(objectiveId), tasksByObjective.get(objectiveId) || []),
      })))
      : aggregate(children);
    const value = {
      id: goal.id,
      level: goal.level,
      title: goal.title.trim(),
      parentId: goal.parentId || null,
      projectId: goal.projectId || null,
      objectiveId: goal.objectiveId || null,
      progress,
      children,
      source: "canonical-projection",
    };
    projected.set(id, value);
    return value;
  };

  const roots = goals.filter((goal) => !goal.parentId).map((goal) => derive(goal.id));
  return {
    version: 1,
    roots,
    goals: goals.map((goal) => derive(goal.id)),
    summary: aggregate(roots),
  };
}

// Read the tracked goal registry. A missing file is a normal, empty state:
// HQ works without goals, it just cannot roll anything up.
export function readGoalRegistry(hqRoot, { path = null } = {}) {
  const file = path || join(resolve(hqRoot), "factory", "goals.json");
  if (!existsSync(file)) return { version: 1, goals: [], present: false, path: file };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`goal registry at ${file} is not valid JSON: ${error.message}`);
  }
  assertSupportedVersion(parsed?.version, { format: "goal-registry", path: file });
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.goals)) {
    throw new Error(`goal registry at ${file} must be an object with a 'goals' array`);
  }
  validateGoalTree(parsed.goals);
  return { version: 1, goals: parsed.goals, present: true, path: file };
}

// The operator-facing snapshot: registry + canonical factory state. Never
// throws for missing or malformed runtime state — a degraded source is
// reported in `warnings` and `available`, because goals are a read-only view
// and must not be able to stop the factory.
export function buildGoalsSnapshot({ hqRoot, stateRoot = null, now = new Date().toISOString() } = {}) {
  const warnings = [];
  let registry = { version: 1, goals: [], present: false, path: null };
  try {
    registry = readGoalRegistry(hqRoot);
  } catch (error) {
    warnings.push(`goal registry unavailable: ${error.message}`);
  }

  const root = resolve(stateRoot || defaultStateRoot(hqRoot));
  const { objectives, tasks } = readCanonicalWork(root, warnings);

  let projection = { version: 1, roots: [], goals: [], summary: { ...UNAVAILABLE } };
  try {
    projection = projectGoals({ goals: registry.goals, objectives, tasks });
  } catch (error) {
    warnings.push(`goal projection unavailable: ${error.message}`);
  }

  return {
    version: 1,
    asOf: now,
    available: warnings.length === 0,
    configured: registry.present && registry.goals.length > 0,
    warnings,
    ...projection,
  };
}

// ------------------------------------------------------------------ internals

// Objective state lives at <stateRoot>/<project>/objectives/<id>/objective-state.json,
// the same layout the founder control plane reads. Each node of an objective is
// one unit of canonical work, so node status is what a goal rolls up.
function readCanonicalWork(root, warnings) {
  const objectives = [];
  const tasks = [];
  if (!existsSync(root)) {
    warnings.push(`factory state root ${root} does not exist yet`);
    return { objectives, tasks };
  }
  for (const project of safeReadDir(root)) {
    if (!project.isDirectory()) continue;
    const objectivesDir = join(root, project.name, "objectives");
    if (!existsSync(objectivesDir)) continue;
    for (const entry of safeReadDir(objectivesDir)) {
      if (!entry.isDirectory()) continue;
      const path = join(objectivesDir, entry.name, "objective-state.json");
      if (!existsSync(path)) continue;
      try {
        const state = JSON.parse(readFileSync(path, "utf8"));
        const objectiveId = state.objectiveId || entry.name;
        // `state.project` is the canonical project key; the containing directory
        // is named after the repo, which is not always the same string.
        objectives.push({ objectiveId, projectId: state.project || project.name, status: state.status || "unknown" });
        const nodes = [...Object.values(state.nodes || {}), state.integration].filter(Boolean);
        for (const node of nodes) tasks.push({ id: node.id, objectiveId, status: node.status });
      } catch (error) {
        warnings.push(`objective ${entry.name} state unavailable: ${error.message}`);
      }
    }
  }
  return { objectives, tasks };
}

const normalize = (status) => String(status ?? "").trim().toLowerCase();

function objectiveProgress(objective, tasks) {
  if (!objective && !tasks.length) return { ...UNAVAILABLE };
  const objectiveStatus = normalize(objective?.status6 ?? objective?.status);
  // Tasks are the unit of progress when there are any: an objective's own
  // status is one fact about the whole, not another item of work, so folding it
  // into the denominator would report half-finished work as a third done.
  const statuses = (tasks.length ? tasks.map((task) => task.status) : [objectiveStatus])
    .filter((status) => status != null && String(status).trim() !== "")
    .map(normalize);
  const total = statuses.length;
  const complete = statuses.filter((s) => COMPLETE.has(s)).length;
  const blocked = statuses.filter((s) => BLOCKED.has(s)).length;
  const active = statuses.filter((s) => ACTIVE.has(s)).length;
  // A status in none of the buckets is counted, never dropped. Silently
  // ignoring it is what turns a vocabulary drift into a confident 0%.
  const unknown = total - complete - blocked - active - statuses.filter((s) => PENDING.has(s)).length;
  // An objective can be blocked above its tasks — a founder gate, a failed
  // publication — while every task under it reads complete. The count stays
  // task-derived, but the state must not claim done for work that cannot
  // proceed, so the objective's own verdict wins over the tasks'.
  const blockedAbove = Boolean(tasks.length) && BLOCKED.has(objectiveStatus);
  const state = blockedAbove ? "blocked" : stateFor({ total, complete, blocked, active, unknown });
  return { state, percent: total ? Math.round(complete / total * 100) : 0, total, complete, blocked: blocked + (blockedAbove && !blocked ? 1 : 0), active, unknown };
}

// Order matters: blocked outranks complete, because a parent holding one
// blocked child is not done. `unknown` never reads as progress.
function stateFor({ total, complete, blocked, active, unknown }) {
  if (!total) return "unavailable";
  if (blocked) return "blocked";
  if (complete === total) return "completed";
  if (active) return "active";
  if (unknown === total) return "unknown";
  return "pending";
}

function aggregate(items) {
  const leaves = items.flatMap((item) => (item.children?.length ? flattenLeaves(item) : [item]));
  const progress = leaves.map((item) => item.progress || item);
  const sum = (key) => progress.reduce((acc, p) => acc + (p[key] || 0), 0);
  const total = sum("total");
  // A leaf with no canonical source has total 0, so summing totals alone would
  // erase it and let a parent claim 100% while half its scope is unaccounted
  // for. Carry the count instead, so "done" always means every leaf answered.
  const unavailable = progress.filter((p) => (p.total || 0) === 0).length;
  const state = unavailable && total === 0 ? "unavailable"
    : unavailable ? "partial"
    : stateFor({ total, complete: sum("complete"), blocked: sum("blocked"), active: sum("active"), unknown: sum("unknown") });
  return { state, percent: total ? Math.round(sum("complete") / total * 100) : 0, total, complete: sum("complete"), blocked: sum("blocked"), active: sum("active"), unknown: sum("unknown"), ...(unavailable ? { unavailable } : {}) };
}

function flattenLeaves(item) { return item.children?.length ? item.children.flatMap(flattenLeaves) : [item]; }

function visit(id, byId, path) {
  if (path.has(id)) throw new Error(`goal cycle detected at '${id}'`);
  const goal = byId.get(id);
  if (!goal?.parentId) return;
  visit(goal.parentId, byId, new Set(path).add(id));
}

// Identifiers are the natural path segments once these projections are
// persisted (PAPERCLIP_GOALS.md), so traversal is rejected here rather than at
// the first caller that joins one onto a path — the same standard
// third-party/provenance.mjs already holds.
function safe(value, label) {
  const text = String(value || "");
  if (!SAFE.test(text)) throw new Error(`${label} is invalid`);
  if (text.split("/").some((segment) => segment === "." || segment === "..")) throw new Error(`${label} is invalid`);
}

function safeReadDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
