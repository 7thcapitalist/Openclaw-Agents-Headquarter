import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentActivity, buildActivityFeed } from "../lib/hq/activity.mjs";

const agents = [
  { id: "claude-main", name: "Claude", kind: "claude", role: "Architecture", capabilities: ["architecture"], status: "idle", harnessAgentIds: ["architect", "reviewer"] },
  { id: "codex-builder", name: "Codex", kind: "codex", role: "Builder", capabilities: ["coding"], status: "idle", harnessAgentIds: ["backend-builder"] },
  { id: "learning-agent", name: "Learning Agent", kind: "learning", role: "R&D", capabilities: [], status: "idle", harnessAgentIds: ["learning"] },
];

test("joins live tasks to agents by harness id and derives working/blocked/waiting", () => {
  const tasks = [
    { id: "t-1", objective: "Ship endpoint", project: "lifemaxing", stage: "builder", agent: "backend-builder", agentStatus: "running", status: "active", updatedAt: "2026-09-03T10:00:00Z" },
    { id: "t-2", objective: "Design storage", project: "lifemaxing", stage: "architect", agent: "architect", agentStatus: "blocked", status: "blocked", blocker: { outcome: "decision-required", stage: "architect", summary: "storage model" }, updatedAt: "2026-09-03T09:00:00Z" },
  ];
  const { agents: rows, summary, unassignedTasks } = buildAgentActivity({ agents, tasks });

  const codex = rows.find((a) => a.id === "codex-builder");
  assert.equal(codex.status, "working");
  assert.equal(codex.waiting, true);
  assert.equal(codex.currentProject, "lifemaxing");
  assert.equal(codex.currentTask.id, "t-1");

  const claude = rows.find((a) => a.id === "claude-main");
  assert.equal(claude.status, "blocked");
  assert.equal(claude.blocked, true);
  assert.equal(claude.blocker, "storage model");

  const learning = rows.find((a) => a.id === "learning-agent");
  assert.equal(learning.status, "idle");
  assert.equal(learning.currentTask, null);

  assert.deepEqual(unassignedTasks, []);
  assert.equal(summary.working, 1);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.idle, 1);
  assert.equal(summary.waiting, 1);
});

test("a task whose actor matches no registry agent becomes an unassigned task", () => {
  const tasks = [{ id: "t-9", project: "x", stage: "qa", agent: "qa", agentStatus: "waiting", status: "active", updatedAt: "2026-09-03T10:00:00Z" }];
  const { unassignedTasks, summary } = buildAgentActivity({ agents, tasks });
  assert.equal(unassignedTasks.length, 1);
  assert.equal(unassignedTasks[0].actor, "qa");
  assert.equal(summary.unassignedTasks, 1);
});

test("harnessAvailable/harnessFallback pass through from the registry row into the activity view", () => {
  const withFallback = [
    { id: "frontend-builder", name: "Frontend Builder", kind: "other", role: "UI", harness: "cursor", harnessAvailable: false, harnessFallback: "openclaw", status: "idle", harnessAgentIds: ["frontend-builder"] },
  ];
  const { agents: rows } = buildAgentActivity({ agents: withFallback, tasks: [] });
  assert.equal(rows[0].harness, "cursor");
  assert.equal(rows[0].harnessAvailable, false);
  assert.equal(rows[0].harnessFallback, "openclaw");

  const { agents: defaultRows } = buildAgentActivity({ agents, tasks: [] });
  assert.equal(defaultRows[0].harnessAvailable, true);
  assert.equal(defaultRows[0].harnessFallback, null);
});

test("no tasks: every agent keeps its registry status", () => {
  const { agents: rows, summary } = buildAgentActivity({ agents, tasks: [] });
  assert.ok(rows.every((a) => a.status === "idle" && a.currentTask === null));
  assert.equal(summary.total, 3);
  assert.equal(summary.working, 0);
});

test("registry currentProject is used when there is no live task", () => {
  const withAssignment = [{ ...agents[1], currentProject: "campuscart" }];
  const { agents: rows } = buildAgentActivity({ agents: withAssignment, tasks: [] });
  assert.equal(rows[0].currentProject, "campuscart");
});

test("task age alone is not activity: an old non-terminal task with no dispatch/runtime signal is STALE, not working", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const tasks = [
    { id: "t-old", objective: "Long-running build", project: "lifemaxing", stage: "builder", agent: "backend-builder", status: "active", updatedAt: "2026-09-03T15:00:00Z" }, // 21h old, no agentStatus
  ];
  const { agents: rows } = buildAgentActivity({ agents, tasks, now, staleAfterMinutes: 120 });
  const codex = rows.find((a) => a.id === "codex-builder");
  assert.equal(codex.status, "stale");
  assert.equal(codex.taskCreatedAt, null); // fixture never set createdAt — distinct from updatedAt/lastActivityAt
  assert.equal(codex.lastActivityAt, "2026-09-03T15:00:00.000Z");
});

test("a task that is merely young (inside the stale window) reports waiting, not stale", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const tasks = [
    { id: "t-fresh", objective: "Recent build", project: "lifemaxing", stage: "builder", agent: "backend-builder", status: "active", updatedAt: "2026-09-04T11:30:00Z" },
  ];
  const { agents: rows } = buildAgentActivity({ agents, tasks, now, staleAfterMinutes: 120 });
  assert.equal(rows.find((a) => a.id === "codex-builder").status, "waiting");
});

test("real OpenClaw runtime activity marks an agent WORKING even without any tracked task", () => {
  const runtime = { byAgent: { architect: { running: true, lastRun: { runId: "r1", status: "running" }, lastActivityAt: "2026-09-04T11:59:00Z" } } };
  const { agents: rows } = buildAgentActivity({ agents, tasks: [], runtime, now: new Date("2026-09-04T12:00:00Z") });
  const claude = rows.find((a) => a.id === "claude-main");
  assert.equal(claude.status, "working");
  assert.equal(claude.runtimeResolved, true);
  assert.equal(claude.currentTask, null, "no tracked factory task exists for this real run");
});

test("a decision-required blocker sets needsFounder without changing the blocked status contract", () => {
  const tasks = [{ id: "t-2", project: "lifemaxing", stage: "architect", agent: "architect", status: "blocked", blocker: { outcome: "decision-required", stage: "architect", summary: "storage model" }, updatedAt: "2026-09-03T09:00:00Z" }];
  const { agents: rows, summary } = buildAgentActivity({ agents, tasks });
  const claude = rows.find((a) => a.id === "claude-main");
  assert.equal(claude.status, "blocked");
  assert.equal(claude.needsFounder, true);
  assert.equal(summary.needsFounder, 1);
});

test("buildActivityFeed flattens and sorts real task events; no tasks means an empty feed, not invented activity", () => {
  assert.deepEqual(buildActivityFeed([], { limit: 10 }), []);
  const tasks = [
    { id: "t-1", project: "lifemaxing", agent: "backend-builder", objective: "Ship endpoint", events: [
      { at: "2026-09-04T14:42:00Z", type: "dispatch-created", stage: "builder", actor: "backend-builder" },
      { at: "2026-09-04T14:51:00Z", type: "stage-completed", stage: "builder", actor: "backend-builder", outcome: "pass" },
    ] },
    { id: "t-2", project: "lifemaxing", agent: "qa", objective: "Ship endpoint", events: [
      { at: "2026-09-04T15:03:00Z", type: "dispatch-created", stage: "qa", actor: "qa" },
    ] },
  ];
  const feed = buildActivityFeed(tasks, { limit: 10 });
  assert.equal(feed.length, 3);
  assert.equal(feed[0].at, "2026-09-04T15:03:00Z", "newest first");
  assert.equal(feed[2].at, "2026-09-04T14:42:00Z");
});
