import { shortObjectiveTitle } from "./objectiveView.mjs";

const PIPELINE = ["product", "architect", "builder", "reviewer", "qa", "security", "release"];

// Every row status emitted by buildRunningNow() is classified here. Founder
// surfaces consume the derived `working` flag instead of maintaining their own
// status strings, so counts, copy and dots cannot drift apart.
export const RUNNING_NOW_STATUS = Object.freeze({
  running: Object.freeze({ working: true }),
  active: Object.freeze({ working: true }),
  blocked: Object.freeze({ working: false }),
  "blocked-by-dep": Object.freeze({ working: false }),
});

export function isWorkingNow(status) {
  return Boolean(RUNNING_NOW_STATUS[status]?.working);
}

export function buildRunningNow(objectives = [], tasks = [], agents = []) {
  const agentById = byId(agents);
  const rows = [];
  const objTaskIds = new Set();
  for (const o of objectives) {
    for (const n of [...(o.nodes || []), o.integration].filter(Boolean)) objTaskIds.add(n.id);
    if (o.status !== "active") continue;
    for (const n of [...(o.nodes || []), o.integration].filter(Boolean)) {
      if (!["running", "blocked", "blocked-by-dep"].includes(n.status)) continue;
      rows.push({
        kind: "objective-node",
        objectiveId: o.objectiveId,
        title: n.title || n.id.replace(`${o.objectiveId}-`, "").replace(/-/g, " "),
        sub: `part of: ${String(o.objective).slice(0, 60)}${o.objective.length > 60 ? "…" : ""}`,
        role: n.role, agent: n.role, model: n.model, stage: n.stage, status: n.status,
        working: isWorkingNow(n.status),
        elapsedMs: n.elapsedMs, lastResult: n.lastResult, blocker: n.blocker,
        next: n.status === "running" && n.stage ? nextStage(n.stage) : null,
        reportId: n.hasReport ? n.id : null,
      });
    }
  }
  const STALE_ACTIVE_MS = 90 * 60 * 1000;
  for (const t of tasks) {
    if (objTaskIds.has(t.id)) continue;
    if (t.status !== "active" && t.status !== "blocked") continue;
    // Infra-blocked and restart-orphaned tasks are shown in the "recovering"
    // strip, not here.
    if (t.status === "blocked" && t.blockerClass === "infra") continue;
    if (t.status === "active" && Date.now() - (Date.parse(t.updatedAt) || Date.now()) > STALE_ACTIVE_MS) continue;
    const a = agentById[t.agent] || Object.values(agentById).find((x) => x.runtimeAgentId === t.agent);
    rows.push({
      kind: "task", taskId: t.id, title: shortObjectiveTitle(t.objective || t.id), sub: t.project || t.id,
      role: t.agent, agent: a?.name || t.agent, stage: t.stage, status: t.status,
      working: isWorkingNow(t.status),
      elapsedMs: t.elapsedMs, lastResult: t.lastResult, blocker: t.blocker,
      next: t.status === "active" && t.stage ? nextStage(t.stage) : null,
      reportId: t.completionReport ? t.id : null,
    });
  }
  return rows;
}

export function buildLiveFloorRows(liveJobs = [], autoRecovering = [], runningRows = []) {
  return [
    ...liveJobs.map((job) => ({
      title: shortObjectiveTitle(job.objective),
      sub: "Starting the team",
      status: "starting",
      working: false,
    })),
    ...autoRecovering.map((recovery) => ({
      title: shortObjectiveTitle(recovery.objective || recovery.taskId),
      sub: "Recovering a safe infrastructure failure",
      status: "recovering",
      working: false,
    })),
    ...runningRows.map((row) => ({ ...row, title: shortObjectiveTitle(row.title || row.objective || "Factory work") })),
  ];
}

export function objectiveActivityLabel(groups = {}) {
  const running = groups.running?.length || 0;
  const queued = groups.waiting?.length || 0;
  const blocked = groups.blocked?.length || 0;
  return running + queued + blocked
    ? `${running} running · ${queued} queued · ${blocked} blocked`
    : "All clear";
}

function nextStage(stage) {
  const i = PIPELINE.indexOf(stage);
  return i >= 0 && i < PIPELINE.length - 1 ? PIPELINE[i + 1] : (i === PIPELINE.length - 1 ? "merge-ready" : null);
}

function byId(list) {
  return Object.fromEntries((Array.isArray(list) ? list : []).map((item) => [item.id, item]));
}
