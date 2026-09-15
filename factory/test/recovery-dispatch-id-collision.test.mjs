// A dispatch id must never be reused within a task.
//
// Both halves of the dispatch machinery use it as an idempotency key —
// `ingest:<dispatchId>` and `running:<dispatchId>`. The command ledger treats a
// repeat as "already applied, here is the earlier response" and never runs the
// mutation, so a reused id means a real agent result is read, acknowledged and
// silently dropped.
//
// That is the obj-c58897c0-integration livelock: `-recovery-1-diagnose` was
// issued 3 times, `-recovery-2-diagnose` and `-recovery-3-diagnose` twice each;
// six passing diagnoses were discarded and recovery.active stayed pinned at
// {phase: "diagnose", attempt: 1} for 17 hours.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { prepareDispatch } from "../lib/openclaw-protocol.mjs";

const hqRoot = resolve(".");
const task = {
  id: "task-collision",
  issue: "local:collision",
  outcome: "Integrate and verify.",
  acceptanceCriteria: ["It is verified"],
  project: "demo",
  workType: "ops",
  risk: "low",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dispatch-collision-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree, { recursive: true });
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/x", worktree }));
  return { statePath, worktree };
}

test("a fresh dispatch id is issued normally", () => {
  const { statePath } = fixture();
  const d = prepareDispatch({ hqRoot, statePath });
  assert.equal(d.stage, "product");
  assert.match(d.dispatchId, /^task-collision-product-1$/);
});

test("a recovery dispatch whose id was already spent is refused, not silently reused", () => {
  const { statePath } = fixture();
  prepareDispatch({ hqRoot, statePath });

  // The exact pre-#219 shape, taken from the quarantined obj-c58897c0 record:
  // an earlier incident already spent `-recovery-1-diagnose`, and the new
  // incident's `recovery.active` has restarted its counter at 1 with no
  // `ordinal` field, so the id is about to be recomputed identically.
  const state = readState(statePath);
  const spentId = `${task.id}-recovery-1-diagnose`;
  state.status = "active";
  state.currentStage = "reviewer";
  state.dispatches = [{ id: spentId, stage: "reviewer", actor: "recovery", kind: "recovery-diagnose", status: "completed", outcome: "pass" }];
  delete state.currentDispatch;
  state.recovery = {
    incident: 2,
    maxAttempts: 3,
    maxTotalAttempts: 9,
    active: { phase: "diagnose", failedStage: "reviewer", attempt: 1 },
    attempts: [],
  };
  writeState(statePath, state);

  assert.throws(
    () => prepareDispatch({ hqRoot, statePath }),
    (error) => {
      assert.match(error.message, /Refusing to reuse dispatch id/);
      assert.match(error.message, new RegExp(spentId));
      // The reason must name the real consequence, not just "duplicate".
      assert.match(error.message, /silently discard/);
      return true;
    },
    "a reused id must fail loudly rather than produce a dispatch whose result will be dropped",
  );
});

test("a recovery dispatch with a fresh ordinal is unaffected", () => {
  const { statePath } = fixture();
  prepareDispatch({ hqRoot, statePath });
  const state = readState(statePath);
  state.status = "active";
  state.currentStage = "reviewer";
  state.dispatches = [{ id: `${task.id}-recovery-1-diagnose`, stage: "reviewer", actor: "recovery", kind: "recovery-diagnose", status: "completed", outcome: "pass" }];
  delete state.currentDispatch;
  // #219's monotonic ordinal: incident 2, but ordinal 2, so no collision.
  state.recovery = {
    incident: 2, maxAttempts: 3, maxTotalAttempts: 9,
    active: { phase: "diagnose", failedStage: "reviewer", attempt: 1, ordinal: 2 },
    attempts: [],
  };
  writeState(statePath, state);

  const next = prepareDispatch({ hqRoot, statePath });
  assert.equal(next.dispatchId, `${task.id}-recovery-2-diagnose`);
});
