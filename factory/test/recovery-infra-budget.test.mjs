// Recovery must not spend the founder's budget on a dead socket.
//
// The failure classifier is already gateway-aware and calls a dropped gateway
// call INFRASTRUCTURE_ERROR, and the STAGE budget already acts on that with a
// separate allowance (DEFAULT_MAX_INFRA_ATTEMPTS against maxAttemptsPerStage).
// The recovery ladder did not: it recorded the classification and then counted
// the attempt exactly like an agent failure.
//
// On 2026-09-15 the OpenClaw Gateway was OOM-killed twice. Every dispatch in
// flight died with it, and two objectives spent eleven recovery attempts between
// them proving a socket was still closed — running "deeper diagnosis" and
// "independent review" against transport, then escalating to the founder as
// though the branch were at fault. One reached 8 of its 9 lifetime attempts on
// work that was correct the whole time.

import test from "node:test";
import assert from "node:assert/strict";

import { createState, openIncidentAttempts, recoveryBudgetFor, startRecovery } from "../lib/task-workflow.mjs";

const task = {
  id: "issue-900", issue: "local:issue-900", outcome: "Ship the thing.",
  acceptanceCriteria: ["it works"], project: "sample", workType: "backend", risk: "low",
};
const fresh = () => createState({ task, repo: "/tmp/repo", branch: "factory/issue-900", worktree: "/tmp/wt" });

// Classified INFRASTRUCTURE_ERROR by the gateway alternatives in the classifier.
const GATEWAY_DOWN = "Gateway not reachable at ws://127.0.0.1:18789 (ECONNREFUSED)";
// Classified FACTORY_ERROR — a real verdict about the work.
const VERDICT = "Acceptance criterion 6 is not satisfied: no unit test covers consistencyPercent";

const drive = (state, error, times) => {
  let s = state;
  for (let i = 0; i < times && s.status !== "blocked"; i += 1) {
    s = startRecovery(s, { failedStage: "builder", actor: "codex", error, maxRecoveryAttempts: 3 });
  }
  return s;
};
const attemptsOf = (s, pred) => openIncidentAttempts(s.recovery).filter(pred);
const isInfra = (a) => a.classification === "INFRASTRUCTURE_ERROR";

test("a fresh task carries a larger infrastructure allowance than its verdict budget", () => {
  const r = fresh().recovery;
  assert.equal(r.maxAttempts, 3, "verdict budget unchanged");
  assert.equal(r.maxInfraAttempts, 6, "infrastructure gets the stage budget's allowance");
});

test("transport failures do not climb the review ladder", () => {
  // Diagnose, look harder, review independently — every rung is a reading of the
  // WORK, and none of them can tell a closed socket anything.
  const s = drive(fresh(), GATEWAY_DOWN, 4);
  const strategies = [...new Set(attemptsOf(s, isInfra).map((a) => a.strategy))];
  assert.deepEqual(strategies, ["retry-recover"], "a dead gateway is retried, never reviewed");
});

test("transport failures do not spend the budget meant for verdicts", () => {
  // Three gateway deaths would have exhausted the whole incident before this
  // change — that is the exact shape that sent obj-d4e18cad to the founder with
  // one attempt left in its life.
  const s = drive(fresh(), GATEWAY_DOWN, 3);
  assert.notEqual(s.status, "blocked", "three transport failures must not escalate");
  assert.equal(attemptsOf(s, isInfra).length, 3);

  const verdict = recoveryBudgetFor(s.recovery, "FACTORY_ERROR");
  assert.equal(verdict.spent, 0, "no verdict budget was consumed by the environment");
  assert.equal(verdict.available, true, "a real failure of the work still gets its full ladder");
});

test("the task-wide verdict ceiling is not eroded by environment failures", () => {
  // obj-d4e18cad reached 8 of its 9 LIFETIME attempts on a crashed gateway. One
  // more environment failure, on any stage, and a task whose work was never at
  // fault would have been unrecoverable.
  const s = drive(fresh(), GATEWAY_DOWN, 9);
  const verdict = recoveryBudgetFor(s.recovery, "FACTORY_ERROR");
  assert.equal(verdict.lifetimeSpent, 0, "the verdict ceiling is untouched");
  assert.equal(verdict.lifetimeLimit, 9);
});

test("the infrastructure allowance is still bounded, and escalates when spent", () => {
  const s = drive(fresh(), GATEWAY_DOWN, 9);
  assert.equal(s.status, "blocked", "it cannot retry a dead gateway forever");
  assert.ok(attemptsOf(s, isInfra).length <= 6, "bounded by maxInfraAttempts");
  assert.equal(s.blocker.classification, "INFRASTRUCTURE_ERROR",
    "and the founder is told it was the environment, not the branch");
});

test("verdict failures behave exactly as before", () => {
  // The regression guard: the ladder and the 3-attempt bound are unchanged for
  // failures that really are about the work.
  const s = drive(fresh(), VERDICT, 5);
  assert.equal(s.status, "blocked");
  const verdicts = attemptsOf(s, (a) => !isInfra(a));
  assert.equal(verdicts.length, 3, "still three attempts per incident");
  assert.deepEqual(verdicts.map((a) => a.strategy),
    ["retry-recover", "deeper-diagnosis", "independent-review"], "still climbs the ladder");
});

test("transport has a task-wide ceiling of its own, so a dead gateway cannot spin forever", () => {
  const state = fresh();
  state.recovery.maxTotalInfraAttempts = 2;
  const s = drive(state, GATEWAY_DOWN, 8);
  assert.ok(attemptsOf(s, isInfra).length <= 2, "bounded by maxTotalInfraAttempts");
  assert.equal(s.status, "blocked");
});
