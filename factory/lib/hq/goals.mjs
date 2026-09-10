// Adapted from Paperclip's hierarchical goals model at pinned commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). HQ goal status is a
// projection of canonical objective/task state, never a second workflow state.
const LEVELS = ["company", "project", "objective"];
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const COMPLETE = new Set(["completed", "complete", "merged", "merge-ready", "satisfied"]);
const BLOCKED = new Set(["blocked", "failed", "needs-attention", "blocked-by-dep"]);
const ACTIVE = new Set(["active", "running", "building", "ready"]);

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

function objectiveProgress(objective, tasks) {
  if (!objective && !tasks.length) return { state: "unavailable", percent: 0, total: 0, complete: 0, blocked: 0, active: 0 };
  const statuses = tasks.length ? tasks.map((task) => task.status) : [objective.status6 || objective.status];
  const total = statuses.length; const complete = statuses.filter((s) => COMPLETE.has(String(s))).length; const blocked = statuses.filter((s) => BLOCKED.has(String(s))).length; const active = statuses.filter((s) => ACTIVE.has(String(s))).length;
  return { state: complete === total ? "completed" : blocked ? "blocked" : active ? "active" : "pending", percent: total ? Math.round(complete / total * 100) : 0, total, complete, blocked, active };
}
function aggregate(items) { const leaves = items.flatMap((item) => item.children?.length ? flattenLeaves(item) : [item]); const progress = leaves.map((item) => item.progress || item); const total = progress.reduce((sum, p) => sum + (p.total || 0), 0); const complete = progress.reduce((sum, p) => sum + (p.complete || 0), 0); const blocked = progress.reduce((sum, p) => sum + (p.blocked || 0), 0); const active = progress.reduce((sum, p) => sum + (p.active || 0), 0); return { state: total && complete === total ? "completed" : blocked ? "blocked" : active ? "active" : total ? "pending" : "unavailable", percent: total ? Math.round(complete / total * 100) : 0, total, complete, blocked, active }; }
function flattenLeaves(item) { return item.children?.length ? item.children.flatMap(flattenLeaves) : [item]; }
function visit(id, byId, path) { if (path.has(id)) throw new Error(`goal cycle detected at '${id}'`); const goal = byId.get(id); if (!goal?.parentId) return; const next = new Set(path); next.add(id); visit(goal.parentId, byId, next); }
function safe(value, label) { if (!SAFE.test(String(value || ""))) throw new Error(`${label} is invalid`); }
