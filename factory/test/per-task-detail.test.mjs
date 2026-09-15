// Per-task detail: the seven stages, what each decided, and why it failed.
//
// operations.tasks[] carries a single scalar `stage` — the CURRENT one — so the
// task screen had nothing to draw. This is the document behind GET /api/task.
import test from "node:test";
import assert from "node:assert/strict";

import { buildTaskDetail, TASK_DETAIL_CONTRACT } from "../lib/hq/task-detail.mjs";
import { buildMirrorSnapshot, MAX_FIELD, MAX_LONG_FIELD } from "../lib/hq/mirror.mjs";
import { taskPathname } from "../../control-plane/api/_lib/store.mjs";

function state(overrides = {}) {
  return {
    version: 1,
    task: { id: "obj-c58897c0-integration", project: "lifemaxing", outcome: "Integrate the sub-task branches.", acceptanceCriteria: ["Every branch merges"], risk: "medium" },
    status: "blocked",
    currentStage: "reviewer",
    branch: "factory/integration-obj-c58897c0",
    createdAt: "2026-09-12T06:29:04.712Z",
    updatedAt: "2026-09-14T14:02:00.000Z",
    assignments: { product: "openclaw", architect: "claude", builder: "codex", reviewer: "claude", qa: "claude", security: "claude", release: "openclaw" },
    stages: {
      product: { status: "pass", actor: "openclaw", summary: "product ok", evidence: ["evidence/product.md"], completedAt: "2026-09-12T06:30:00.000Z", evidenceStrength: "asserted" },
      architect: { status: "pass", actor: "claude", summary: "architect ok", evidence: [{ path: "evidence/architect.md" }] },
      builder: { status: "pass", actor: "codex", summary: "builder ok", evidence: ["evidence/builder.md"] },
      reviewer: { status: "pending" },
    },
    dispatches: [
      { id: "t-reviewer-1", stage: "reviewer", actor: "claude", status: "completed", outcome: "fail", attempt: 1, completedAt: "2026-09-14T03:21:36.152Z", usage: { provider: "claude-cli", model: "claude-sonnet-5", tokensIn: 2, tokensOut: 166, cachedInputTokens: 43936 } },
      { id: "t-reviewer-2", stage: "reviewer", actor: "claude", status: "completed", outcome: "fail", attempt: 2, infraFailure: true },
      { id: "t-builder-1", stage: "builder", actor: "codex", status: "completed", outcome: "pass", attempt: 1 },
    ],
    failures: [
      { at: "2026-09-14T03:21:36.152Z", stage: "reviewer", classification: "PROJECT_ERROR", agent: "claude", error: "reviewer agent could not run: Gateway agent call connection closed" },
    ],
    recovery: { incident: 2, maxAttempts: 3, maxTotalAttempts: 9, active: { phase: "diagnose", failedStage: "reviewer", attempt: 1 }, attempts: [{ incident: 1, ordinal: 1, number: 1, strategy: "retry-recover", failedStage: "reviewer", status: "failed", error: "x" }] },
    ...overrides,
  };
}

test("all seven stages appear, pending ones included", () => {
  const d = buildTaskDetail({ state: state() });
  assert.equal(d.contract, TASK_DETAIL_CONTRACT);
  assert.deepEqual(d.stages.map((s) => s.stage), ["product", "architect", "builder", "reviewer", "qa", "security", "release"]);
  // A stage the task never reached is `pending`, not missing — the console
  // needs to draw the whole pipeline, not just the part that ran.
  assert.equal(d.stages.find((s) => s.stage === "qa").status, "pending");
  assert.equal(d.stages.find((s) => s.stage === "product").status, "pass");
});

test("each stage carries its agent, attempts against the limit, and evidence PATHS", () => {
  const d = buildTaskDetail({ state: state(), maxAttemptsPerStage: 3 });
  const reviewer = d.stages.find((s) => s.stage === "reviewer");
  assert.equal(reviewer.attempts, 2);
  assert.equal(reviewer.maxAttempts, 3);
  assert.equal(reviewer.dispatches[1].infraFailure, true);

  const product = d.stages.find((s) => s.stage === "product");
  assert.deepEqual(product.evidence, ["evidence/product.md"]);
  assert.equal(product.agent, "openclaw");
  // Object-shaped evidence is normalised to its path, never its body.
  assert.deepEqual(d.stages.find((s) => s.stage === "architect").evidence, ["evidence/architect.md"]);
});

test("the failure reason is carried on the stage that failed", () => {
  const reviewer = buildTaskDetail({ state: state() }).stages.find((s) => s.stage === "reviewer");
  assert.equal(reviewer.failures.length, 1);
  assert.match(reviewer.failures[0].error, /Gateway agent call connection closed/);
  assert.equal(reviewer.failures[0].classification, "PROJECT_ERROR");
});

test("recovery attempts are carried, with the counters that disagreed", () => {
  const d = buildTaskDetail({ state: state() });
  assert.equal(d.recovery.incident, 2);
  assert.equal(d.recovery.active.phase, "diagnose");
  assert.equal(d.recovery.attempts[0].strategy, "retry-recover");
});

test("a task with no id produces nothing rather than a malformed document", () => {
  assert.equal(buildTaskDetail({ state: { task: {} } }), null);
  assert.equal(buildTaskDetail({ state: null }), null);
});

test("the long ceiling is opt-in: the main mirror is unchanged", () => {
  const long = "x".repeat(MAX_LONG_FIELD + 500);
  // Exactly how the main mirror publishes — no opt-in.
  const mirror = buildMirrorSnapshot({ sources: { panel: { summary: long } } });
  assert.ok(mirror.panels.panel.summary.length <= MAX_FIELD + 200, "the mirror boundary must not move");
});

test("a failure reason gets the long ceiling; a payload field does not", () => {
  // MAX_FIELD exists to stop evidence bodies and diffs travelling. A verdict is
  // not a payload, and truncating it costs the most useful text on the screen.
  const long = "x".repeat(MAX_LONG_FIELD + 500);
  // `notes` is deliberately an ordinary field: not a reason, and not one of the
  // FORBIDDEN_KEYS (which drop outright rather than truncate — `body` is one,
  // and is dropped entirely, as it should be).
  const clean = buildMirrorSnapshot({ sources: { detail: { summary: long, notes: long } }, allowLongFields: true });
  const out = clean.panels.detail;
  assert.ok(out.summary.length > MAX_FIELD, "a reason field gets the higher ceiling");
  assert.ok(out.summary.length <= MAX_LONG_FIELD + 200);
  assert.ok(out.notes.length <= MAX_FIELD + 200, "an ordinary field keeps the payload ceiling");
  // And the marker says where the rest is, rather than trailing off.
  assert.match(out.summary, /truncated at 12000 characters — the full text is on the factory machine/);
});

test("a task id is validated as a path segment before it becomes a blob key", () => {
  assert.equal(taskPathname("obj-c58897c0-integration"), "mirror/tasks/obj-c58897c0-integration.json");
  for (const bad of ["../../etc/passwd", "a/b", "", null, "..", "x".repeat(300)]) {
    assert.equal(taskPathname(bad), null, `${JSON.stringify(bad)} must not become a key`);
  }
});

test("a payload key is dropped outright, not truncated — FORBIDDEN_KEYS is unchanged", () => {
  const clean = buildMirrorSnapshot({ sources: { detail: { summary: "fine", body: "a diff would live here", patch: "so would this" } } });
  assert.equal(clean.panels.detail.body, undefined, "a body never travels, at any length");
  assert.equal(clean.panels.detail.patch, undefined);
  assert.ok(clean.redaction.keysDropped.includes("body"));
});
