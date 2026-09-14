import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { runOneStage } from "../lib/openclaw-runner.mjs";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { classifyBlocker } from "../lib/hq/blocker-class.mjs";

const hqRoot = resolve(".");
const task = {
  id: "issue-902",
  issue: "902",
  outcome: "Propagate deterministic control-flow failures.",
  acceptanceCriteria: ["A merge conflict is not treated as a dropped agent"],
  project: "sample",
  workType: "ops",
  risk: "low",
};

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "runner-control-flow-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree);
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/issue-902", worktree }));
  return { worktree, statePath };
}

// The objective orchestrator performs the integration merge inside its own
// `execute`. When two sub-task branches conflict it throws MergeConflict, which
// carries `fatal: true`. Before this fix the runner caught it like any failed
// agent attempt, so the orchestrator's own handler never fired.
class FatalMergeConflict extends Error {
  constructor() { super("merge conflict integrating factory/obj-c58897c0-game-backend"); this.fatal = true; }
}

test("a fatal control-flow error reaches the caller instead of becoming a missing result", async () => {
  const fixture = makeFixture();
  const execute = async () => { throw new FatalMergeConflict(); };

  await assert.rejects(
    () => runOneStage({ hqRoot, statePath: fixture.statePath, execute }),
    /merge conflict integrating factory\/obj-c58897c0-game-backend/,
    "the orchestrator can only raise its conflict blocker if the error escapes the runner",
  );
});

test("the blocked task names the real cause and never enters the retry ladder", async () => {
  const fixture = makeFixture();
  const execute = async () => { throw new FatalMergeConflict(); };
  await assert.rejects(() => runOneStage({ hqRoot, statePath: fixture.statePath, execute }));

  const state = readState(fixture.statePath);
  assert.equal(state.status, "blocked");
  assert.match(state.blocker.summary, /merge conflict integrating/);
  assert.equal(state.blocker.outcome, "decision-required");
  assert.equal(classifyBlocker(state.blocker), "decision");

  // The two symptoms the founder actually saw on obj-c58897c0.
  assert.equal(state.recovery?.attempts?.length || 0, 0, "a deterministic merge must not spend recovery attempts");
  assert.ok(!state.events.some((e) => e.type === "recovery-diagnosing"), "recovery must not be started for a conflict");
  assert.doesNotMatch(state.blocker.summary, /wrote no result file/,
    "the conflict must not be laundered into the generic missing-result wrapper");

  // No orphaned dispatch left claimed, or a resume would wait on it forever.
  assert.equal(state.currentDispatch, undefined);
  assert.equal(state.dispatches.at(-1).status, "failed");
});

test("an ordinary agent error is still retried, not escalated", async () => {
  const fixture = makeFixture();
  const execute = async () => { throw new Error("model overloaded"); };

  const response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute });
  assert.equal(response.status, "active");
  const state = readState(fixture.statePath);
  assert.notEqual(state.blocker?.outcome, "decision-required");
});
