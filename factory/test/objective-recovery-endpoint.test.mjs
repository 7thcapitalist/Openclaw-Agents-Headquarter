import assert from "node:assert/strict";
import { existsSync, utimesSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  handleObjectiveRetry,
  listFounderJobs,
} from "../../dashboard/backend/lib/founderControlPlane.mjs";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";

function writeTask(root, { id, project = "app", outcome, status = "blocked", blocker, updatedAt, risk = "low", events = [] }) {
  const worktree = join(root, "wt", id);
  mkdirSync(worktree, { recursive: true });
  const state = createState({
    task: { id, issue: `local:${id}`, outcome: outcome || id, acceptanceCriteria: ["ok"], project, workType: "backend", risk },
    repo: join(root, "repo"),
    branch: `factory/${id}`,
    worktree,
  });
  state.status = status;
  if (blocker) state.blocker = blocker;
  if (updatedAt) state.updatedAt = updatedAt;
  if (status === "blocked" && blocker) {
    const stage = blocker.stage || "builder";
    state.currentStage = stage;
    state.stages[stage] = { status: blocker.outcome === "decision-required" ? "decision-required" : "failed" };
  }
  state.events = [...(state.events || []), ...events];
  const statePath = join(root, "dashboard/backend/data/factory", project, "tasks", id, "state.json");
  writeState(statePath, state);
  return statePath;
}

function writeObjectiveFixture(root, { objectiveId = "obj-aabbccdd-demo", nodes }) {
  const project = "app";
  const dir = join(root, "dashboard/backend/data/factory", project, "objectives", objectiveId);
  mkdirSync(dir, { recursive: true });
  const obj = {
    version: 1,
    objectiveId,
    objective: "Demo objective",
    project,
    repo: join(root, "repo"),
    status: "blocked",
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    nodes: {},
    integration: {
      id: `${objectiveId}-integration`,
      role: "integration",
      status: "pending",
      branch: `factory/${objectiveId}-integration`,
    },
    events: [],
  };
  for (const n of nodes) {
    const id = n.id.startsWith(objectiveId) ? n.id : `${objectiveId}-${n.id}`;
    const statePath = writeTask(root, {
      id,
      project,
      outcome: n.title || n.role,
      status: n.taskStatus || (n.status === "running" ? "active" : "blocked"),
      blocker: n.taskBlocker || (n.blocker?.infra ? { ...n.blocker, outcome: "fail" } : n.blocker),
      updatedAt: n.updatedAt,
      risk: n.risk || "low",
    });
    obj.nodes[id] = {
      id,
      role: n.role || "backend-builder",
      status: n.status,
      branch: `factory/${id}`,
      statePath,
      worktree: join(root, "wt", id),
      contract: { outcome: n.title || "Build step" },
      blocker: n.blocker || null,
      dependsOn: n.dependsOn || [],
    };
  }
  const path = join(dir, "objective-state.json");
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
  return { objectivePath: path, objectiveId, obj };
}

test("handleObjectiveRetry: mixed infra A + decision B → resumes only A, never auto-answers", async () => {
  const root = mkdtempSync(join(tmpdir(), "obj-rec-ep-"));
  mkdirSync(join(root, "repo"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), "{}\n");
  const { objectiveId, objectivePath, obj } = writeObjectiveFixture(root, {
    nodes: [
      {
        id: "a",
        role: "backend-builder",
        title: "Build API auth",
        status: "blocked",
        blocker: {
          outcome: "decision-required",
          infra: true,
          stage: "builder",
          summary: "The builder for this task could not run (ECONNRESET). Retry the objective later, or adjust model routing for that role.",
        },
      },
      {
        id: "b",
        role: "architect",
        title: "Choose storage",
        status: "blocked",
        blocker: { outcome: "decision-required", stage: "architect", summary: "Choose Postgres or SQLite" },
      },
    ],
  });
  const decisionId = Object.keys(obj.nodes).find((k) => k.endsWith("-b"));
  const decisionStatePath = obj.nodes[decisionId].statePath;
  const beforeDecision = readState(decisionStatePath);

  let runCalls = 0;
  let releaseRun;
  const runObjective = () => {
    runCalls += 1;
    return new Promise((resolve) => { releaseRun = () => resolve({ status: "complete" }); });
  };

  const out = await handleObjectiveRetry({
    root, hqRoot: root, objectiveId, runObjective, now: Date.now(),
  });
  assert.equal(out.status, "recovering");
  assert.equal(out.nodes.length, 1);
  assert.equal(out.nodes[0].title, "Build API auth");
  assert.equal(out.nodes[0].role, "backend-builder");
  assert.equal(out.nodes[0].id, undefined);
  assert.equal(runCalls, 1);

  // B stays blocked/decision-required; no founder-decision-recorded events.
  const afterDecision = readState(decisionStatePath);
  assert.equal(afterDecision.status, "blocked");
  assert.equal(afterDecision.blocker?.outcome, "decision-required");
  assert.ok(!(afterDecision.events || []).some((e) => /founder-decision|founder-approval|founder-decision-recorded/.test(e.type)));
  assert.equal(beforeDecision.blocker.summary, afterDecision.blocker.summary);

  // Duplicate while recovery.inFlight is fresh → 409, spy not called again.
  await assert.rejects(
    () => handleObjectiveRetry({ root, hqRoot: root, objectiveId, runObjective, now: Date.now() }),
    (err) => err.statusCode === 409 && /already in progress/i.test(err.message),
  );
  assert.equal(runCalls, 1);

  releaseRun();
  await new Promise((r) => setTimeout(r, 20));
  const jobs = listFounderJobs(root);
  assert.ok(jobs.some((j) => j.kind === "objective-recovery" && j.objectiveId === objectiveId));
  assert.ok(JSON.parse(readFileSync(objectivePath, "utf8")).recovery?.attempts >= 1);
});

test("handleObjectiveRetry: nothing recoverable (decision + hard) → 409, spy not called", async () => {
  const root = mkdtempSync(join(tmpdir(), "obj-rec-none-"));
  mkdirSync(join(root, "repo"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), "{}\n");
  const { objectiveId } = writeObjectiveFixture(root, {
    nodes: [
      {
        id: "b",
        title: "Decide",
        status: "blocked",
        blocker: { outcome: "decision-required", summary: "Choose Postgres or SQLite" },
      },
      {
        id: "c",
        title: "Fix tests",
        status: "failed",
        blocker: { outcome: "fail", summary: "tests fail in suite" },
        taskStatus: "blocked",
      },
    ],
  });
  let calls = 0;
  await assert.rejects(
    () => handleObjectiveRetry({
      root, hqRoot: root, objectiveId,
      runObjective: async () => { calls += 1; return { status: "complete" }; },
    }),
    (err) => err.statusCode === 409 && /Nothing to recover/i.test(err.message),
  );
  assert.equal(calls, 0);
});

test("handleObjectiveRetry: background orchestration receives objectivePath + stateRoot; job completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "obj-rec-bg-"));
  mkdirSync(join(root, "repo"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), "{}\n");
  const { objectiveId, objectivePath } = writeObjectiveFixture(root, {
    nodes: [
      {
        id: "a",
        role: "backend-builder",
        title: "Build API auth",
        status: "blocked",
        blocker: {
          outcome: "decision-required",
          infra: true,
          stage: "builder",
          summary: "The builder for this task could not run (ECONNRESET). Retry the objective later, or adjust model routing for that role.",
        },
      },
    ],
  });

  let received = null;
  const runObjective = async (opts) => {
    received = opts;
    return { status: "complete" };
  };

  const out = await handleObjectiveRetry({
    root, hqRoot: root, objectiveId, runObjective, now: Date.now(),
  });
  assert.equal(out.status, "recovering");
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(received);
  assert.equal(received.objectivePath, objectivePath);
  assert.ok(received.stateRoot);
  const jobs = listFounderJobs(root);
  const job = jobs.find((j) => j.kind === "objective-recovery" && j.objectiveId === objectiveId);
  assert.ok(job);
  assert.equal(job.status, "complete");
  assert.equal(JSON.parse(readFileSync(objectivePath, "utf8")).recovery?.inFlight, undefined);
});

test("recovery cannot launch a second orchestrator while a sibling is still live", async () => {
  const root = mkdtempSync(join(tmpdir(), "obj-live-sibling-"));
  const { objectiveId, obj } = writeObjectiveFixture(root, { nodes: [
    { id: "a", status: "blocked", blocker: { outcome: "fail", stage: "builder", summary: "provider timeout" } },
    { id: "b", status: "running", updatedAt: new Date().toISOString() },
  ] });
  let calls = 0;
  await assert.rejects(handleObjectiveRetry({ root, hqRoot: root, objectiveId, runObjective: async () => { calls++; } }), /still has running work/);
  assert.equal(calls, 0);
  assert.equal(readState(Object.values(obj.nodes)[0].statePath).status, "blocked");
});

test("a stale objective infra tag cannot override a real task decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "obj-task-decision-"));
  const { objectiveId, obj } = writeObjectiveFixture(root, { nodes: [
    { id: "a", status: "blocked", blocker: { outcome: "fail", stage: "builder", summary: "provider timeout", infra: true },
      taskBlocker: { outcome: "decision-required", stage: "builder", summary: "Approve a production change" } },
  ] });
  await assert.rejects(handleObjectiveRetry({ root, hqRoot: root, objectiveId, runObjective: async () => { throw new Error("must not run"); } }), /Nothing to recover/);
  assert.equal(readState(Object.values(obj.nodes)[0].statePath).blocker.outcome, "decision-required");
});


test("recovery rejects a fresh competing lock and reclaims a stale interruption lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "obj-recovery-lock-"));
  const { objectiveId, objectivePath } = writeObjectiveFixture(root, { nodes: [
    { id: "a", status: "blocked", blocker: { outcome: "fail", stage: "builder", summary: "provider timeout" } },
  ] });
  const lock = `${objectivePath}.recovery.lock`;
  writeFileSync(lock, ""); let calls = 0;
  const args = { root, hqRoot: root, objectiveId, runObjective: async () => { calls++; return { status: "complete" }; } };
  await assert.rejects(handleObjectiveRetry(args), /already in progress/);
  assert.equal(calls, 0); assert.equal(existsSync(lock), true);
  const old = new Date(Date.now() - 6 * 60 * 1000); utimesSync(lock, old, old);
  assert.equal((await handleObjectiveRetry(args)).status, "recovering");
  assert.equal(calls, 1); assert.equal(existsSync(lock), false);
});
