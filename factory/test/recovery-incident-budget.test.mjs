import test from "node:test";
import assert from "node:assert/strict";
import { closeRecoveryIncident, createState, normalizeRecovery, openIncidentAttempts, recordRecoveryResult, resumeState, startRecovery } from "../lib/task-workflow.mjs";

const task = {
  id: "obj-x-integration", issue: "local:obj-x-integration", outcome: "Integrate the parallel build tasks.",
  acceptanceCriteria: ["Every sub-task branch merges without conflict"],
  project: "sample", workType: "ops", risk: "medium",
};
const fresh = () => createState({ task, repo: "/tmp/repo", branch: "factory/obj-x", worktree: "/tmp/wt" });

// Spend a whole incident the way production does: attempts until the budget is
// gone, ending in an escalation to the founder. The escalating call is the one
// AFTER the last attempt — startRecovery escalates when the budget is already
// spent, not when it spends the last one.
function exhaust(state, { stage = "builder", error = "merge conflict integrating factory/obj-x-game-backend" } = {}) {
  let s = state;
  for (let i = 0; i < 5 && s.status !== "blocked"; i += 1) {
    s = startRecovery(s, { failedStage: stage, actor: "codex", error, maxRecoveryAttempts: 3 });
  }
  return s;
}

test("a fresh task opens incident 1 with a task-wide ceiling", () => {
  const r = fresh().recovery;
  assert.equal(r.incident, 1);
  assert.equal(r.maxAttempts, 3);
  assert.equal(r.maxTotalAttempts, 9, "three full incidents");
  assert.deepEqual(r.attempts, []);
});

test("legacy state without incident tags is normalized, not crashed", () => {
  const r = normalizeRecovery({ maxAttempts: 3, attempts: [{ number: 1 }, { number: 2 }], active: null });
  assert.equal(r.incident, 1);
  assert.equal(r.maxTotalAttempts, 9);
  assert.equal(openIncidentAttempts(r).length, 2, "untagged attempts belong to the incident that was open when they were written");
});

// The production failure: obj-c58897c0 spent three attempts on a merge
// conflict, the founder resolved it, and the reviewer's very first failure (a
// crashed OpenClaw Gateway) escalated immediately, never once retried.
test("a founder resume returns the budget to the next failure", () => {
  const spent = exhaust(fresh());
  assert.equal(spent.status, "blocked", "precondition: the incident escalated");
  assert.equal(openIncidentAttempts(spent.recovery).length, 3);

  const resumed = resumeState(spent);
  assert.equal(resumed.recovery.incident, 2);
  assert.equal(openIncidentAttempts(resumed.recovery).length, 0, "the resolved incident must not bind the next failure");

  // A different stage now fails for an unrelated reason. It must be retried,
  // not escalated on sight.
  const next = startRecovery(resumed, { failedStage: "reviewer", actor: "claude", error: "reviewer agent could not run: Gateway agent call connection closed", maxRecoveryAttempts: 3 });
  assert.equal(next.status, "active", "a new failure gets its own attempts");
  assert.equal(openIncidentAttempts(next.recovery).length, 1);
  assert.equal(next.recovery.attempts.at(-1).failedStage, "reviewer");
  assert.equal(next.recovery.attempts.at(-1).strategy, "retry-recover", "the new incident starts at the first strategy");
});

test("nothing is deleted: the full attempt record survives every incident", () => {
  const resumed = resumeState(exhaust(fresh()));
  const after = exhaust(resumed, { stage: "reviewer", error: "Gateway agent call connection closed" });
  assert.equal(after.recovery.attempts.length, 6, "three from each incident, all still on the record");
  assert.equal(after.recovery.attempts.filter((a) => a.incident === 1).length, 3);
  assert.equal(after.recovery.attempts.filter((a) => a.incident === 2).length, 3);
  assert.match(after.recovery.attempts[0].error, /merge conflict/);
  assert.ok(after.events.some((e) => e.type === "recovery-incident-closed" && e.attempts === 3));
});

test("the escalation describes only the incident it is about", () => {
  const resumed = resumeState(exhaust(fresh()));
  const gateway = exhaust(resumed, { stage: "reviewer", error: "Gateway agent call connection closed" });
  assert.equal(gateway.status, "blocked");
  // Before the fix this rendered all six attempts, telling the founder the
  // factory had tried six strategies -- three of them on the merge conflict.
  assert.equal(gateway.blocker.whatFactoryTried.split(";").length, 3);
  assert.match(gateway.blocker.summary, /after 3 bounded attempt\(s\)/);
  assert.match(gateway.blocker.why, /Gateway agent call connection closed/);
  assert.doesNotMatch(gateway.blocker.why, /merge conflict/);
});

test("the task-wide ceiling still bounds a task that keeps needing repair", () => {
  let s = fresh();
  for (let i = 0; i < 3; i += 1) s = resumeState(exhaust(s));
  assert.equal(s.recovery.attempts.length, 9);

  const next = startRecovery(s, { failedStage: "qa", actor: "claude", error: "QA: 3 tests fail", maxRecoveryAttempts: 3 });
  assert.equal(next.status, "blocked", "the ceiling must hold even though each incident was itself in budget");
  assert.equal(next.blocker.classification, "FOUNDER_DECISION_REQUIRED");
  assert.match(next.blocker.why, /task-wide ceiling of 9/);
});

test("closing an incident is a no-op when none is open", () => {
  const closed = closeRecoveryIncident(fresh(), { reason: "nothing" });
  assert.equal(closed.recovery.incident, 1, "no open attempts, so no incident to retire");
  assert.equal(closed.recovery.active, null);
});

// The other way an incident ends, and the one that was never pinned: recovery
// repairs the failure and an independent verifier confirms it.
//
// This is load-bearing. Without it a task that was successfully recovered keeps
// the spent attempts, so the NEXT failure — which may be completely unrelated —
// starts with a budget that is already gone. That is the production shape on
// obj-c58897c0: attempt 2 was verified, the run continued, and the next stage
// failure (a kernel OOM kill of the gateway) arrived at a full counter.
function drive(state, { failedStage = "reviewer", error = "CHANGES REQUIRED: the academics page is unreachable" } = {}) {
  let s = startRecovery(state, { failedStage, actor: "claude", error, maxRecoveryAttempts: 3 });
  s = recordRecoveryResult(s, { outcome: "pass", actor: "claude", summary: "repaired in commit f2ceab6" });
  return recordRecoveryResult(s, { outcome: "pass", actor: "codex", summary: "independently verified" });
}

test("a verified repair closes the incident and returns the budget", () => {
  const verified = drive(fresh());
  assert.equal(openIncidentAttempts(verified.recovery).length, 0, "a repaired failure must not keep charging the task");
  assert.equal(verified.recovery.incident, 2);
  assert.equal(verified.recovery.attempts.length, 1, "the attempt itself stays on the record");
  assert.equal(verified.recovery.attempts[0].status, "verified");
  assert.equal(verified.recovery.active, null);
  assert.ok(verified.events.some((e) => e.type === "recovery-incident-closed" && e.reason === "recovery-verified"));
});

test("the failure after a successful recovery gets a full budget", () => {
  const verified = drive(fresh());
  // A different stage, a different cause — the gateway dying, not the code.
  const next = startRecovery(verified, {
    failedStage: "qa", actor: "claude",
    error: "qa agent could not run: Gateway agent call connection closed",
    maxRecoveryAttempts: 3,
  });
  assert.equal(next.status, "active", "it must be retried, not escalated on sight");
  assert.equal(openIncidentAttempts(next.recovery).length, 1);
  assert.equal(next.recovery.attempts.at(-1).strategy, "retry-recover", "a new incident starts at the first strategy");
  assert.equal(next.recovery.attempts.at(-1).incident, 2);
});

test("repeatedly succeeding does not exhaust the task", () => {
  // Three successful recoveries in a row must leave the task healthy: each one
  // closed, none of them holding budget against the next.
  let s = fresh();
  for (const stage of ["reviewer", "qa", "security"]) s = drive(s, { failedStage: stage });
  assert.equal(openIncidentAttempts(s.recovery).length, 0);
  assert.equal(s.recovery.attempts.length, 3, "one attempt per incident, all preserved");
  assert.equal(s.recovery.incident, 4);
  const next = startRecovery(s, { failedStage: "release", actor: "openclaw", error: "release: tag push rejected", maxRecoveryAttempts: 3 });
  assert.equal(next.status, "active", "a task that keeps being repaired successfully must not be punished for it");
});
