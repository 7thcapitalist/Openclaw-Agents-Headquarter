import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildRunTimeline } from "../lib/hq/run-timeline.mjs";
import { appendAuditEvent, createAuditEvent } from "../lib/audit/envelope.mjs";
import { acquireTaskLease } from "../lib/leases/task-lease.mjs";
import { enqueueWakeup } from "../lib/wakeups/queue.mjs";
import { appendCostEvent, createCostEvent } from "../lib/hq/cost-ledger.mjs";

const TASK = "obj-abc123-node-one";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hq-timeline-"));
  const stateRoot = join(root, "state");
  const taskDir = join(stateRoot, "proj", "tasks", TASK);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "state.json"), JSON.stringify({
    task: { id: TASK, project: "hq", risk: "low", outcome: "Ship the thing" },
    status: "active", currentStage: "builder", branch: "factory/x",
    createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:05:00.000Z",
    stages: { product: { status: "pass", evidence: [{ path: "evidence/product.md" }] } },
    events: [
      { at: "2026-09-10T00:00:00.000Z", type: "task-created", stage: "product" },
      { at: "2026-09-10T00:02:00.000Z", type: "stage-pass", stage: "product", actor: "openclaw" },
    ],
  }));
  return { root, stateRoot, taskDir };
}

const timeline = (root, stateRoot, over = {}) => buildRunTimeline({ hqRoot: root, taskId: TASK, stateRoot, ...over });
const source = (view, name) => view.sources.find((entry) => entry.name === name);
const kinds = (view) => view.entries.map((entry) => entry.kind);

// --- merging the layers ------------------------------------------------------

test("workflow events alone produce an ordered timeline", () => {
  const { root, stateRoot } = fixture();
  const view = timeline(root, stateRoot);
  assert.equal(view.taskId, TASK);
  assert.deepEqual(kinds(view), ["task-created", "stage-pass"]);
  assert.equal(view.task.outcome, "Ship the thing");
  assert.equal(view.available, true);
});

test("every layer that recorded something appears, in one order, tagged with its source", () => {
  const { root, stateRoot, taskDir } = fixture();

  appendAuditEvent(join(taskDir, "audit.ndjson"), createAuditEvent({
    eventId: "a1", occurredAt: "2026-09-10T00:03:00.000Z",
    actor: { type: "agent", id: "codex" }, action: "dispatch.running",
    subject: { type: "task", id: TASK }, correlation: { stage: "builder" }, data: { kind: "stage" },
  }));
  writeFileSync(join(taskDir, "liveness.json"), JSON.stringify({
    runId: "r1", taskId: TASK, state: "needs-followup", reason: "agent returned no result",
    nextAction: "retry the stage", recordedAt: "2026-09-10T00:04:00.000Z",
  }));
  mkdirSync(join(stateRoot, "proj", "leases"), { recursive: true, mode: 0o700 });
  acquireTaskLease({ root: join(stateRoot, "proj", "leases"), taskId: TASK, actorId: "codex", runId: "r1", ttlMs: 60_000 });
  enqueueWakeup(join(stateRoot, "proj", "wakeups.json"), {
    source: "dependency", taskRef: TASK, actorId: "codex", idempotencyKey: "k1",
  });
  appendCostEvent(join(root, ".openclaw-factory", "telemetry", "cost-events.ndjson"), createCostEvent({
    eventId: "c1", source: "f", sourceEventId: "s1", occurredAt: "2026-09-10T00:03:30.000Z",
    provider: "openai", model: "m", inputTokens: 100, outputTokens: 50, taskId: TASK,
  }));
  mkdirSync(join(stateRoot, "proj", "objectives", "obj-abc123"), { recursive: true });
  writeFileSync(join(stateRoot, "proj", "objectives", "obj-abc123", "graph-health.json"), JSON.stringify({
    objectiveId: "obj-abc123", healthy: false, recordedAt: "2026-09-10T00:06:00.000Z",
    findings: [{ severity: "high", code: "objective-task-divergence", message: "node is blocked but its task is merge-ready", nodeIds: [TASK] }],
  }));

  const view = timeline(root, stateRoot);
  const sources = new Set(view.entries.map((entry) => entry.source));
  for (const name of ["workflow", "audit", "liveness", "lease", "wakeup", "graph"]) {
    assert.ok(sources.has(name), `${name} entries must appear in the merged timeline`);
  }
  const times = view.entries.map((entry) => entry.at);
  assert.deepEqual(times, [...times].sort(), "entries are in chronological order");
  assert.equal(view.cost.inputTokens, 100);
  assert.equal(view.ownership.actorId, "codex");
  assert.equal(view.counts.workflow, 2);
});

test("a graph finding about a different node is not attached to this run", () => {
  const { root, stateRoot } = fixture();
  mkdirSync(join(stateRoot, "proj", "objectives", "obj-abc123"), { recursive: true });
  writeFileSync(join(stateRoot, "proj", "objectives", "obj-abc123", "graph-health.json"), JSON.stringify({
    objectiveId: "obj-abc123", healthy: false, recordedAt: "2026-09-10T00:06:00.000Z",
    findings: [{ code: "stale-running", message: "x", nodeIds: ["some-other-node"] }],
  }));
  assert.equal(timeline(root, stateRoot).entries.some((entry) => entry.source === "graph"), false);
});

test("cost and wakeups from other tasks do not leak into this run", () => {
  const { root, stateRoot } = fixture();
  appendCostEvent(join(root, ".openclaw-factory", "telemetry", "cost-events.ndjson"), createCostEvent({
    eventId: "c9", source: "f", sourceEventId: "s9", occurredAt: "2026-09-10T00:03:00.000Z",
    provider: "openai", model: "m", inputTokens: 999, outputTokens: 999, taskId: "someone-elses-task",
  }));
  enqueueWakeup(join(stateRoot, "proj", "wakeups.json"), { source: "dependency", taskRef: "someone-elses-task", actorId: "x", idempotencyKey: "k9" });
  const view = timeline(root, stateRoot);
  assert.equal(view.cost.inputTokens, 0);
  assert.equal(view.entries.some((entry) => entry.source === "wakeup"), false);
});

// --- honesty about the sources ----------------------------------------------

test("a layer that recorded nothing is shown as absent, not omitted", () => {
  const { root, stateRoot } = fixture();
  const view = timeline(root, stateRoot);
  assert.equal(source(view, "audit").present, false);
  assert.equal(source(view, "audit").available, true);
  assert.match(source(view, "audit").reason, /not recorded/);
  assert.equal(view.sources.length, 7, "every layer is accounted for, present or not");
});

test("a source that cannot be read is named and makes the whole timeline unavailable", () => {
  const { root, stateRoot, taskDir } = fixture();
  writeFileSync(join(taskDir, "audit.ndjson"), "{ truncated\n");
  const view = timeline(root, stateRoot);
  assert.equal(view.available, false);
  assert.equal(source(view, "audit").available, false);
  assert.ok(source(view, "audit").reason);
  assert.equal(view.entries.length, 2, "the readable layers still render");
});

test("an unreadable liveness file does not take the run's own record with it", () => {
  const { root, stateRoot, taskDir } = fixture();
  writeFileSync(join(taskDir, "liveness.json"), "{ nope");
  const view = timeline(root, stateRoot);
  assert.equal(view.available, false);
  assert.deepEqual(kinds(view), ["task-created", "stage-pass"]);
});

// --- the privacy boundary ----------------------------------------------------

test("evidence is referenced by path and never by content", () => {
  const { root, stateRoot } = fixture();
  const view = timeline(root, stateRoot);
  assert.deepEqual(view.evidence, [{ stage: "product", path: "evidence/product.md" }]);
});

test("audit data contributes scalars only, so a future field cannot smuggle a blob", () => {
  const { root, stateRoot, taskDir } = fixture();
  appendAuditEvent(join(taskDir, "audit.ndjson"), createAuditEvent({
    eventId: "a1", occurredAt: "2026-09-10T00:03:00.000Z",
    actor: { type: "agent", id: "codex" }, action: "dispatch.running",
    subject: { type: "task", id: TASK }, correlation: {},
    data: { outcome: "pass", nested: { prompt: "SENSITIVE PROMPT TEXT" } },
  }));
  const view = timeline(root, stateRoot);
  assert.doesNotMatch(JSON.stringify(view), /SENSITIVE PROMPT TEXT/);
  assert.match(view.entries.find((entry) => entry.source === "audit").detail, /outcome=pass/);
});

test("free text from any layer is bounded", () => {
  const { root, stateRoot, taskDir } = fixture();
  writeFileSync(join(taskDir, "liveness.json"), JSON.stringify({
    runId: "r", taskId: TASK, state: "blocked", reason: "x".repeat(5000), recordedAt: "2026-09-10T00:04:00.000Z",
  }));
  const entry = timeline(root, stateRoot).entries.find((item) => item.source === "liveness");
  assert.ok(entry.detail.length <= 300);
});

// --- bounds and inputs -------------------------------------------------------

test("an unknown task is null, not an empty timeline that looks like a clean run", () => {
  const { root, stateRoot } = fixture();
  assert.equal(buildRunTimeline({ hqRoot: root, taskId: "no-such-task", stateRoot }), null);
});

test("a hostile task id is rejected before any path is built", () => {
  const { root, stateRoot } = fixture();
  for (const bad of ["../../etc/passwd", "a/b", "", null]) {
    assert.throws(() => buildRunTimeline({ hqRoot: root, taskId: bad, stateRoot }), /taskId is invalid/);
  }
});

test("the entry list is bounded and says when it was truncated", () => {
  const { root, stateRoot, taskDir } = fixture();
  const events = Array.from({ length: 60 }, (_, index) => ({
    at: new Date(Date.parse("2026-09-10T00:00:00.000Z") + index * 1000).toISOString(),
    type: `event-${index}`, stage: "builder",
  }));
  writeFileSync(join(taskDir, "state.json"), JSON.stringify({
    task: { id: TASK, project: "hq" }, status: "active", stages: {}, events,
  }));
  const view = timeline(root, stateRoot, { limit: 10 });
  assert.equal(view.entries.length, 10);
  assert.equal(view.truncated, true);
  assert.equal(view.entries.at(-1).kind, "event-59", "the newest entries are the ones kept");
});
