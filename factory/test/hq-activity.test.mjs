import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentActivity } from "../lib/hq/activity.mjs";

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
