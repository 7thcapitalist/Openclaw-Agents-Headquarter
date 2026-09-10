// Adapted from Paperclip's hierarchical goals model at pinned commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). HQ goal status is a
// projection of canonical objective/task state, never a second workflow state.
const LEVELS = ["company", "project", "objective"];
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

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

export function validateGoalTree(goals) {
  if (!Array.isArray(goals)) throw new Error("goals must be an array");
  const byId = new Map();
  for (const goal of goals) {
    safe(goal?.id, "goal.id");
    if (byId.has(goal.id)) throw new Error(`duplicate goal '${goal.id}'`);
    if (!LEVELS.includes(goal.level)) throw new Error(`goal '${goal.id}' has invalid level`);
    if (typeof goal.title !== "string" || !goal.title.trim() || goal.title.length > 300) throw new Error(`goal '${goal.id}' title is invalid`);
    if (goal.parentId != null) safe(goal.parentId, "goal.parentId");
    if (goal.projectId != null) safe(goal.projectId, "goal.projectId");
    if (goal.objectiveId != null) safe(goal.objectiveId, "goal.objectiveId");
    byId.set(goal.id, goal);
  }
  for (const goal of goals) {
    if (goal.level === "company" && goal.parentId != null) throw new Error(`company goal '${goal.id}' cannot have a parent`);
    if (goal.level !== "company" && !goal.parentId) throw new Error(`goal '${goal.id}' requires a parent`);
    const parent = goal.parentId ? byId.get(goal.parentId) : null;
    if (goal.parentId && !parent) throw new Error(`goal '${goal.id}' has unknown parent '${goal.parentId}'`);
    if (parent && LEVELS.indexOf(parent.level) >= LEVELS.indexOf(goal.level)) throw new Error(`goal '${goal.id}' parent level is invalid`);
    if (goal.level === "project" && !goal.projectId) throw new Error(`project goal '${goal.id}' requires projectId`);
    if (goal.level === "objective" && (!goal.projectId || !goal.objectiveId)) throw new Error(`objective goal '${goal.id}' requires projectId and objectiveId`);
    if (parent?.projectId && goal.projectId !== parent.projectId) throw new Error(`goal '${goal.id}' crosses project scope`);
  }
  for (const goal of goals) visit(goal.id, byId, new Set());
  return goals;
}

export function projectGoals({ goals, objectives = [], tasks = [] }) {
  validateGoalTree(goals);
  const objectiveById = new Map(objectives.map((item) => [item.objectiveId || item.id, item]));
  const tasksByObjective = new Map();
  for (const task of tasks) {
    const objectiveId = task.objectiveId || task.parentObjectiveId;
    if (objectiveId) (tasksByObjective.get(objectiveId) || tasksByObjective.set(objectiveId, []).get(objectiveId)).push(task);
  }
  const children = new Map(goals.map((goal) => [goal.id, []]));
  for (const goal of goals) if (goal.parentId) children.get(goal.parentId).push(goal.id);
  const projected = new Map();
  const derive = (id) => {
    if (projected.has(id)) return projected.get(id);
    const goal = goals.find((item) => item.id === id);
    const descendants = children.get(id).map(derive);
    const own = goal.level === "objective" ? objectiveProgress(objectiveById.get(goal.objectiveId), tasksByObjective.get(goal.objectiveId) || []) : null;
    const progress = own || aggregate(descendants);
    const value = { id: goal.id, level: goal.level, title: goal.title.trim(), parentId: goal.parentId || null, projectId: goal.projectId || null,
      objectiveId: goal.objectiveId || null, progress, children: descendants, source: "canonical-projection" };
    projected.set(id, value); return value;
  };
  return { version: 1, roots: goals.filter((goal) => !goal.parentId).map((goal) => derive(goal.id)), goals: goals.map((goal) => derive(goal.id)), summary: aggregate(goals.filter((goal) => !goal.parentId).map((goal) => derive(goal.id))) };
}

const normalize = (status) => String(status ?? "").trim().toLowerCase();

function objectiveProgress(objective, tasks) {
  if (!objective && !tasks.length) return { state: "unavailable", percent: 0, total: 0, complete: 0, blocked: 0, active: 0, unknown: 0 };
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
function visit(id, byId, path) { if (path.has(id)) throw new Error(`goal cycle detected at '${id}'`); const goal = byId.get(id); if (!goal?.parentId) return; const next = new Set(path); next.add(id); visit(goal.parentId, byId, next); }
// Identifiers are the natural path segments once these projections are
// persisted (PAPERCLIP_GOALS.md), so traversal is rejected here rather than at
// the first caller that joins one onto a path — the same standard
// third-party/provenance.mjs already holds.
function safe(value, label) {
  const text = String(value || "");
  if (!SAFE.test(text)) throw new Error(`${label} is invalid`);
  if (text.split("/").some((segment) => segment === "." || segment === "..")) throw new Error(`${label} is invalid`);
}
