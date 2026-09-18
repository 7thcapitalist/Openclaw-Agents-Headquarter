import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildObjectiveStateFromNodes } from "../lib/objective/decompose.mjs";
import { cancelObjective } from "../lib/objective/orchestrator.mjs";

test("objective-cancelled launches real learning analysis after returning", async (t) => {
  const hqRoot = mkdtempSync(join(tmpdir(), "learning-trigger-"));
  t.after(() => rmSync(hqRoot, { recursive: true, force: true }));
  const stateRoot = join(hqRoot, "dashboard/backend/data/factory");
  const objective = buildObjectiveStateFromNodes({
    objective: "learn after finish", project: "hq-runtime", repo: hqRoot,
    nodes: [{ id: "a", role: "backend-builder", objective: "a", acceptanceCriteria: ["a"], workType: "backend", risk: "low", dependsOn: [] }],
    objectiveId: "obj-deadbeef",
  });
  const objectiveDir = join(stateRoot, "hq-runtime/objectives/obj-deadbeef");
  mkdirSync(objectiveDir, { recursive: true });
  const objectivePath = join(objectiveDir, "objective-state.json");
  writeFileSync(objectivePath, `${JSON.stringify(objective)}\n`);

  const taskDir = join(stateRoot, "hq-runtime/tasks/obj-deadbeef-a");
  mkdirSync(taskDir, { recursive: true });
  const resultPath = join(taskDir, "results/dispatch-builder-1.json");
  writeFileSync(join(taskDir, "state.json"), `${JSON.stringify({
    version: 1, task: { id: "obj-deadbeef-a", project: "hq-runtime", workType: "backend", risk: "low" },
    repo: hqRoot, worktree: hqRoot, status: "blocked", stages: {}, events: [],
    dispatches: [{ stage: "builder", attempt: 1, outcome: "fail", status: "failed", summary: "did not write its result file", resultPath }],
    createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:01:00.000Z",
  }, null, 2)}\n`);

  const started = Date.now();
  const cancelled = cancelObjective(objectivePath, { reason: "done", hqRoot });
  assert.equal(cancelled.status, "cancelled");
  assert.ok(Date.now() - started < 100, "learning analysis must not delay cancellation");

  const queuePath = join(stateRoot, "_learning/findings.json");
  for (let attempt = 0; attempt < 20 && !existsSync(queuePath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(existsSync(queuePath), "the event hook should write the existing learning queue without a CLI command");
  const queue = JSON.parse(readFileSync(queuePath, "utf8"));
  const finding = queue.findings.find((item) => item.fingerprint === "no-verdict-dispatch:builder");
  assert.equal(finding.objectiveId, "obj-deadbeef");
  assert.deepEqual(finding.taskIds, ["obj-deadbeef-a"]);
  assert.equal(finding.evidence[0].path, resultPath);
});

test("a slow or rejecting learning trigger cannot block or fail cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "learning-trigger-detached-"));
  const objective = buildObjectiveStateFromNodes({
    objective: "detach", project: "hq-runtime", repo: root,
    nodes: [{ id: "a", role: "backend-builder", objective: "a", acceptanceCriteria: ["a"], workType: "backend", risk: "low", dependsOn: [] }],
  });
  const path = join(root, "objective-state.json");
  writeFileSync(path, `${JSON.stringify(objective)}\n`);
  let invoked = false;
  const result = cancelObjective(path, {
    hqRoot: root,
    learningTrigger: async () => { invoked = true; await new Promise((_, reject) => setTimeout(() => reject(new Error("learning failed")), 50)); },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(invoked, false, "the trigger itself starts after the objective call returns");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invoked, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  rmSync(root, { recursive: true, force: true });
});
