// The founder queue must surface `decision-required` blockers, not just
// pending signature requests.
//
// Regression: `npm run approve -- --list` printed "Nothing is waiting for your
// approval" while two tasks sat blocked on the founder. `isAwaitingFounderApproval`
// requires `blocker.stage === "builder"`, but reviewers raise decisions at
// `reviewer`, so every one of them was invisible to the only founder-facing queue.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  isAwaitingFounderApproval,
  isAwaitingFounderDecision,
} from "../lib/task-workflow.mjs";
import { findDecisions, findPending } from "../../scripts/founder-approve.mjs";

const HQ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APPROVE = join(HQ, "scripts", "founder-approve.mjs");

// A task blocked on a founder decision raised at a stage other than `builder`,
// shaped the way the reviewer actually writes one.
function seedDecision(root, id, { stage = "reviewer", risk = "medium" } = {}) {
  const state = {
    version: 1,
    task: { id, issue: `local:${id}`, outcome: `Ship ${id}`, project: "demo", workType: "backend", risk },
    repo: join(root, "repo"),
    branch: `factory/${id}`,
    worktree: join(root, "worktrees", id),
    status: "blocked",
    currentStage: stage,
    blocker: {
      stage,
      outcome: "decision-required",
      summary: `Reviewer will not approve ${id} without a founder call on scope.`,
      actor: "claude",
      at: "2026-09-09T01:59:18.975Z",
    },
    stages: {},
    events: [],
    updatedAt: "2026-09-09T01:59:18.975Z",
  };
  const path = join(root, "state", "demo", "tasks", id, "state.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return { path, state };
}

test("a decision-required blocker outside `builder` is a founder decision", () => {
  const root = mkdtempSync(join(tmpdir(), "fq-pred-"));
  const { state } = seedDecision(root, "task-review-decision");

  // It is not a signature request — nothing here can be signed.
  assert.equal(isAwaitingFounderApproval(state), false);
  // But it IS waiting on the founder, which is what the old queue missed.
  assert.equal(isAwaitingFounderDecision(state), true);
});

test("the two queues stay disjoint: a high-risk builder gate is a signature, not a decision", () => {
  const root = mkdtempSync(join(tmpdir(), "fq-disjoint-"));
  const { state } = seedDecision(root, "task-builder-gate", { stage: "builder", risk: "high" });

  assert.equal(isAwaitingFounderApproval(state), true);
  assert.equal(
    isAwaitingFounderDecision(state),
    false,
    "a task parked at the high-risk gate must be reported once, as a signature request",
  );
});

test("findDecisions discovers what findPending cannot see", () => {
  const root = mkdtempSync(join(tmpdir(), "fq-find-"));
  seedDecision(root, "task-ca3c3cdf-like");
  const stateRoot = join(root, "state");

  assert.deepEqual(findPending(stateRoot).map((p) => p.state.task.id), []);
  assert.deepEqual(findDecisions(stateRoot).map((p) => p.state.task.id), ["task-ca3c3cdf-like"]);
});

test("`approve --list` reports the decision instead of an empty queue", () => {
  const root = mkdtempSync(join(tmpdir(), "fq-cli-"));
  seedDecision(root, "task-ca3c3cdf-like");

  const out = execFileSync(process.execPath, [APPROVE, "--list", "--state-root", join(root, "state")], {
    encoding: "utf8",
  });

  assert.doesNotMatch(
    out,
    /Nothing is waiting for your approval/,
    "the queue read empty while the factory was blocked on the founder — that is the bug",
  );
  assert.match(out, /blocked on a decision from you/);
  assert.match(out, /task-ca3c3cdf-like/);
  assert.match(out, /stuck at: reviewer/);
});
