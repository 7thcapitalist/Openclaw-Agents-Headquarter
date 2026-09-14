import test from "node:test";
import assert from "node:assert/strict";
import { integrationOutcome } from "../lib/objective/orchestrator.mjs";
import { GATE_SATISFIED } from "../lib/objective/graph.mjs";
import { classifyBlocker, classifyObjectiveNodeBlocker } from "../lib/hq/blocker-class.mjs";

// obj-c58897c0, 2026-09-14: the kernel OOM-killed the openclaw gateway and took
// the orchestrator with it, leaving a dispatch claimed but never run. The next
// orchestrator pass returned a non-merge-ready status while the task itself
// carried no blocker, and the integration node was written as
// `status: "blocked", blocker: null`.
//
// Blocked with no cause is the worst shape this system can produce: the founder
// sees a dead objective with an empty explanation, classifyBlocker has nothing
// to classify, and the retry sweep has nothing to decide on. The build-node path
// has always synthesized a fallback; integration was the odd one out.
const healthy = { status: "active", currentStage: "reviewer", blocker: null };

test("a runner that stops with no blocker still yields a stated reason", () => {
  const out = integrationOutcome({ resp: { status: "dispatch" }, state: healthy });
  assert.equal(out.status, "blocked");
  assert.ok(out.blocker, "a blocked node must never carry a null blocker");
  assert.match(out.blocker.summary, /reviewer/, "it names where the runner stopped");
  assert.match(out.blocker.summary, /dispatch/, "and the status it returned");
  assert.equal(out.blocker.stage, "reviewer");
});

test("the synthesized blocker is classifiable by the layers that must read it", () => {
  const { blocker } = integrationOutcome({ resp: { status: "dispatch" }, state: healthy });
  // A null blocker made both of these return null, so nothing downstream could
  // decide who owned the failure.
  assert.equal(classifyBlocker(blocker), "hard");
  assert.equal(classifyObjectiveNodeBlocker(blocker), "hard");
});

// Rule 1: waiting is not blocked.
test("a task still waiting on a dispatch keeps the node running", () => {
  const out = integrationOutcome({ resp: { status: "dispatch", waiting: true }, state: healthy });
  assert.equal(out.status, "running", "work still in flight must not stop the objective");
  assert.equal(out.blocker, null);
  assert.equal(out.waiting, true);
});

test("a real blocker is preserved exactly, never replaced by the fallback", () => {
  const real = { stage: "reviewer", outcome: "decision-required", founderAction: true, summary: "merge conflict integrating factory/x: .gitignore" };
  const out = integrationOutcome({ resp: { status: "blocked" }, state: { ...healthy, status: "blocked", blocker: real } });
  assert.equal(out.blocker, real);
  assert.equal(out.status, "blocked");
});

test("a runner-supplied blocker summary is preferred over the generic fallback", () => {
  const out = integrationOutcome({ resp: { status: "blocked", blocker: { summary: "release stage rejected the tag" } }, state: healthy });
  assert.equal(out.blocker.summary, "release stage rejected the tag");
});

test("merge-ready satisfies the gate and carries no blocker", () => {
  const out = integrationOutcome({ resp: { status: "merge-ready" }, state: { ...healthy, status: "merge-ready" } });
  assert.equal(out.status, GATE_SATISFIED);
  assert.equal(out.blocker, null);
});

test("an unknown runner status still produces a reason rather than a null", () => {
  const out = integrationOutcome({ resp: {}, state: { status: "active", currentStage: null, blocker: null } });
  assert.ok(out.blocker.summary.length > 0);
  assert.match(out.blocker.summary, /unknown/);
  assert.equal(out.blocker.stage, "builder", "falls back to a real stage name, not undefined");
});
