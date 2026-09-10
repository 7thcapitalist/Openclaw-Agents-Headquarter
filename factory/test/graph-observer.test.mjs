import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { objectiveWakeupQueuePath, observeObjectiveGraph } from "../lib/objective/graph-observer.mjs";
import { readWakeupQueue } from "../lib/wakeups/queue.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "graph-observer-"));
  const objectiveDir = join(root, "objectives", "obj-1");
  mkdirSync(objectiveDir, { recursive: true });
  return { root, objectivePath: join(objectiveDir, "objective-state.json"), nodeStateRoot: root };
}

const node = (id, status, dependsOn = [], extra = {}) => ({ id, status, dependsOn, ...extra });
const graph = (nodes) => ({ objectiveId: "obj-1", nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) });

test("a node that became runnable during the run gets one durable wakeup", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  const before = graph([node("a", "running"), node("b", "pending", ["a"])]);
  const after = graph([node("a", "gate-satisfied"), node("b", "pending", ["a"])]);

  const result = observeObjectiveGraph({ objectivePath, nodeStateRoot, before, after });
  assert.equal(result.wakeups.enqueued, 1);

  const items = readWakeupQueue(objectiveWakeupQueuePath(nodeStateRoot)).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].taskRef, "b");
  assert.equal(items[0].source, "dependency");
  assert.equal(items[0].status, "queued");
  // A wakeup identifies work. It must never be able to carry an instruction.
  assert.equal(items[0].command, undefined);
  assert.equal(items[0].payload, undefined);
});

test("observing the same run twice does not enqueue the node twice", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  const before = graph([node("a", "running"), node("b", "pending", ["a"])]);
  const after = graph([node("a", "gate-satisfied"), node("b", "pending", ["a"])]);

  observeObjectiveGraph({ objectivePath, nodeStateRoot, before, after });
  const second = observeObjectiveGraph({ objectivePath, nodeStateRoot, before, after });
  assert.equal(second.wakeups.enqueued, 0);
  assert.equal(second.wakeups.duplicates, 1, "the repeat is recognised as a duplicate, not a new wakeup");
  assert.equal(readWakeupQueue(objectiveWakeupQueuePath(nodeStateRoot)).items.length, 1);
});

test("a genuine retry of the same node is wakeable again", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  const before = graph([node("a", "running"), node("b", "pending", ["a"], { attempts: 0 })]);
  observeObjectiveGraph({ objectivePath, nodeStateRoot, before, after: graph([node("a", "gate-satisfied"), node("b", "pending", ["a"], { attempts: 0 })]) });
  observeObjectiveGraph({ objectivePath, nodeStateRoot, before, after: graph([node("a", "gate-satisfied"), node("b", "pending", ["a"], { attempts: 1 })]) });
  assert.equal(readWakeupQueue(objectiveWakeupQueuePath(nodeStateRoot)).items.length, 2);
});

test("nothing newly runnable enqueues nothing", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  const steady = graph([node("a", "running"), node("b", "pending", ["a"])]);
  const result = observeObjectiveGraph({ objectivePath, nodeStateRoot, before: steady, after: steady });
  assert.equal(result.wakeups.enqueued, 0);
  assert.equal(existsSync(objectiveWakeupQueuePath(nodeStateRoot)), false, "an empty result must not create a queue file");
});

test("graph health is written next to the objective state", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  const after = graph([node("a", "failed"), node("b", "pending", ["a"]), node("c", "pending", ["b"])]);
  const result = observeObjectiveGraph({ objectivePath, nodeStateRoot, before: after, after });

  assert.equal(result.health.recorded, true);
  assert.equal(result.health.healthy, false);
  const health = JSON.parse(readFileSync(join(join(nodeStateRoot, "objectives", "obj-1"), "graph-health.json"), "utf8"));
  assert.equal(health.objectiveId, "obj-1");
  assert.ok(health.recordedAt);
  const stranded = health.findings.find((finding) => finding.code === "blocked-subtree");
  assert.deepEqual(stranded.strandedNodeIds, ["c"], "the transitively stranded node is named");
});

test("an invalid graph is recorded as critical rather than throwing", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  const broken = graph([node("a", "pending", ["does-not-exist"])]);
  const result = observeObjectiveGraph({ objectivePath, nodeStateRoot, before: broken, after: broken });
  assert.equal(result.health.recorded, true);
  assert.equal(result.health.healthy, false);
  // dependencyWakeups asserts acyclicity and would throw; the observer absorbs
  // it, because an unhealthy graph must still be reported, not crash the run.
  assert.equal(result.wakeups.enqueued, 0);
  assert.match(result.wakeups.skipped, /does-not-exist/);
});

// --- the contract that matters: observation can never break the objective ----

test("an unwritable objective directory degrades, it does not throw", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  const readOnly = join(nodeStateRoot, "objectives", "obj-1");
  chmodSync(readOnly, 0o500);
  try {
    const after = graph([node("a", "gate-satisfied")]);
    const result = observeObjectiveGraph({ objectivePath, nodeStateRoot, before: after, after });
    assert.equal(result.health.recorded, false);
    assert.ok(result.health.reason, "the failure is reported, not swallowed silently");
  } finally {
    chmodSync(readOnly, 0o700);
  }
});

test("an unwritable queue degrades, it does not throw", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  writeFileSync(objectiveWakeupQueuePath(nodeStateRoot), "{ not a queue");
  const before = graph([node("a", "running"), node("b", "pending", ["a"])]);
  const after = graph([node("a", "gate-satisfied"), node("b", "pending", ["a"])]);
  const result = observeObjectiveGraph({ objectivePath, nodeStateRoot, before, after });
  assert.equal(result.wakeups.enqueued, 0);
  assert.equal(result.wakeups.errors.length, 1);
  assert.match(result.wakeups.errors[0], /^b: /);
});

test("an objective with no id records health but enqueues nothing", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  const after = { nodes: { a: node("a", "gate-satisfied") } };
  const result = observeObjectiveGraph({ objectivePath, nodeStateRoot, before: { nodes: {} }, after });
  assert.equal(result.health.recorded, true);
  assert.match(result.wakeups.skipped, /no id/);
});

// --- objective/task divergence -----------------------------------------------
// The objective wrapper and its nodes' task states are written by different
// paths. `POST /api/founder/tasks/:id/retry` re-runs one task to terminal
// without touching the objective, so a node can sit `blocked` while the task
// under it has finished — and its dependents stay `blocked-by-dep` forever.

function writeTask(nodeStateRoot, taskId, status) {
  const dir = join(nodeStateRoot, "tasks", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ status }));
}

test("a node left behind by its own finished task is reported, with what it strands", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  writeTask(nodeStateRoot, "a", "merge-ready");
  const after = graph([node("a", "blocked"), node("b", "blocked-by-dep", ["a"]), node("c", "pending", ["b"])]);

  const result = observeObjectiveGraph({ objectivePath, nodeStateRoot, before: after, after });
  assert.equal(result.health.healthy, false, "a divergence is not a healthy graph");

  const health = JSON.parse(readFileSync(join(nodeStateRoot, "objectives", "obj-1", "graph-health.json"), "utf8"));
  const finding = health.findings.find((f) => f.code === "objective-task-divergence");
  assert.ok(finding);
  assert.equal(finding.severity, "high");
  assert.match(finding.message, /node a is 'blocked' but its task is 'merge-ready'/);
  assert.deepEqual(finding.strandedNodeIds.sort(), ["b", "c"], "everything transitively waiting on it is named");
});

test("the divergence report never rewrites objective state", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  writeTask(nodeStateRoot, "a", "merge-ready");
  const after = graph([node("a", "blocked")]);
  writeFileSync(objectivePath, JSON.stringify(after));

  observeObjectiveGraph({ objectivePath, nodeStateRoot, before: after, after });
  assert.equal(JSON.parse(readFileSync(objectivePath, "utf8")).nodes.a.status, "blocked",
    "repairing the divergence is a canonical mutation and must not happen inside a projection");
});

test("a node in step with its task produces no divergence finding", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  writeTask(nodeStateRoot, "a", "blocked");
  const after = graph([node("a", "blocked")]);
  const result = observeObjectiveGraph({ objectivePath, nodeStateRoot, before: after, after });
  const health = JSON.parse(readFileSync(join(nodeStateRoot, "objectives", "obj-1", "graph-health.json"), "utf8"));
  assert.equal(health.findings.filter((f) => f.code === "objective-task-divergence").length, 0);
  assert.equal(result.health.recorded, true);
});

test("a settled node is never reported as diverged", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  for (const status of ["gate-satisfied", "published", "skipped"]) {
    writeTask(nodeStateRoot, "a", "merge-ready");
    const after = graph([node("a", status)]);
    observeObjectiveGraph({ objectivePath, nodeStateRoot, before: after, after });
    const health = JSON.parse(readFileSync(join(nodeStateRoot, "objectives", "obj-1", "graph-health.json"), "utf8"));
    assert.equal(health.findings.filter((f) => f.code === "objective-task-divergence").length, 0, `${status} is settled`);
  }
});

test("an unreadable task state is left to the task layer, not misreported as divergence", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  mkdirSync(join(nodeStateRoot, "tasks", "a"), { recursive: true });
  writeFileSync(join(nodeStateRoot, "tasks", "a", "state.json"), "{ truncated");
  const after = graph([node("a", "blocked")]);
  const result = observeObjectiveGraph({ objectivePath, nodeStateRoot, before: after, after });
  assert.equal(result.health.recorded, true);
  const health = JSON.parse(readFileSync(join(nodeStateRoot, "objectives", "obj-1", "graph-health.json"), "utf8"));
  assert.equal(health.findings.filter((f) => f.code === "objective-task-divergence").length, 0);
});

test("the integration node is checked for divergence too", () => {
  const { objectivePath, nodeStateRoot } = fixture();
  writeTask(nodeStateRoot, "obj-1-integration", "active");
  const after = { ...graph([node("a", "gate-satisfied")]), integration: node("obj-1-integration", "blocked") };
  observeObjectiveGraph({ objectivePath, nodeStateRoot, before: after, after });
  const health = JSON.parse(readFileSync(join(nodeStateRoot, "objectives", "obj-1", "graph-health.json"), "utf8"));
  assert.ok(health.findings.some((f) => f.code === "objective-task-divergence" && f.nodeIds[0] === "obj-1-integration"));
});
