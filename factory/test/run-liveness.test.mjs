import test from "node:test";
import assert from "node:assert/strict";
import { applyLivenessToRun, createRunLiveness, decideLivenessContinuation } from "../lib/liveness/run-liveness.mjs";
const make = (state = "plan-only", attempt = 0) => createRunLiveness({ runId: "run-1", taskId: "task-1", state, reason: "No concrete action", continuationAttempt: attempt, recoveryAttempt: 7 }, { now: () => "2026-09-09T20:00:00Z" });

test("liveness is metadata and does not alter durable task status", () => {
  const run = { id: "run-1", status: "succeeded", taskStatus: "building" }; const out = applyLivenessToRun(run, make("empty-response"));
  assert.equal(out.taskStatus, "building"); assert.equal(out.liveness.state, "empty-response"); assert.equal(run.liveness, undefined);
});
test("only plan-only and empty-response enqueue semantic continuations", () => {
  for (const state of ["completed", "advanced", "blocked", "failed", "needs-followup"]) assert.equal(decideLivenessContinuation({ liveness: make(state), taskStatus: "active", assignedActorId: "agent", runActorId: "agent" }).kind, "skip");
  const decision = decideLivenessContinuation({ liveness: make(), taskStatus: "active", assignedActorId: "agent", runActorId: "agent" });
  assert.equal(decision.kind, "enqueue"); assert.equal(decision.nextAttempt, 1); assert.match(decision.idempotencyKey, /run-liveness:task-1:run-1/);
});
test("continuation attempts are independent from recovery attempts and bounded", () => {
  const liveness = make("plan-only", 2); assert.equal(liveness.recoveryAttempt, 7);
  const decision = decideLivenessContinuation({ liveness, taskStatus: "active", assignedActorId: "agent", runActorId: "agent" });
  assert.equal(decision.kind, "exhausted"); assert.equal(decision.audit.action, "run.liveness-exhausted");
});
test("assignment, task state, budget, and idempotency prevent unsafe continuation", () => {
  const liveness = make();
  assert.match(decideLivenessContinuation({ liveness, taskStatus: "merged", assignedActorId: "agent", runActorId: "agent" }).reason, /not continuable/);
  assert.match(decideLivenessContinuation({ liveness, taskStatus: "active", assignedActorId: "new", runActorId: "old" }).reason, /no longer assigned/);
  assert.match(decideLivenessContinuation({ liveness, taskStatus: "active", assignedActorId: "a", runActorId: "a", budgetBlocked: true }).reason, /budget/);
  assert.match(decideLivenessContinuation({ liveness, taskStatus: "active", assignedActorId: "a", runActorId: "a", existingWakeup: true }).reason, /already exists/);
});
