import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { computeDispatchPaths, prepareDispatch, quarantineStaleResult } from "../lib/openclaw-protocol.mjs";

const hqRoot = process.cwd();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stale-result-"));
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  const statePath = join(root, "state.json");
  const state = createState({
    task: { id: "t", issue: "1", outcome: "Ship it", acceptanceCriteria: ["works"], project: "p", workType: "backend", risk: "low" },
    repo: root, branch: "factory/t", worktree,
  });
  state.currentStage = "qa";
  state.stages.product = { status: "pass", actor: "openclaw", summary: "ok", evidence: [{ path: "evidence/p.md" }] };
  // A recovery cycle whose budget was reset: attempts restart at 1 while the
  // previous cycle's result files are still on disk.
  state.recovery = { maxAttempts: 3, attempts: [], active: { phase: "diagnose", failedStage: "qa", attempt: 1 } };
  writeState(statePath, state);
  return { root, statePath, state };
}

test("a recovery dispatch does not inherit a previous cycle's result file", () => {
  const { statePath, state } = fixture();
  const { resultPath, dispatchId } = computeDispatchPaths({ state, stage: "qa", statePath });

  // The exact hazard: a leftover file at the id the new cycle is about to use,
  // carrying the same stage and actor so the ingest checks would accept it.
  mkdirSync(join(statePath, "..", "results"), { recursive: true });
  writeFileSync(resultPath, JSON.stringify({
    version: 1, dispatchId, stage: "qa", actor: "recovery",
    outcome: "pass", summary: "verified in a previous cycle", evidence: [],
  }));
  assert.equal(existsSync(resultPath), true);

  const response = prepareDispatch({ hqRoot, statePath });
  assert.equal(response.status, "dispatch");
  assert.equal(response.dispatchId, dispatchId);
  // The stale answer is gone, so the new dispatch must actually run.
  assert.equal(existsSync(resultPath), false);

  const parked = readdirSync(join(statePath, "..", "results", "stale"));
  assert.equal(parked.length, 1);
  // Nothing is destroyed — the evidence of what happened is kept.
  assert.match(JSON.parse(readFileSync(join(statePath, "..", "results", "stale", parked[0]), "utf8")).summary, /previous cycle/);
});

test("a stage dispatch keeps a pre-written result, which the review fan-out relies on", () => {
  const { statePath, state } = fixture();
  delete state.recovery;
  writeState(statePath, state);
  const { resultPath, dispatchId } = computeDispatchPaths({ state, stage: "qa", statePath });
  mkdirSync(join(statePath, "..", "results"), { recursive: true });
  writeFileSync(resultPath, JSON.stringify({
    version: 1, dispatchId, stage: "qa", actor: "claude",
    outcome: "pass", summary: "written by the concurrent group", evidence: [],
  }));

  prepareDispatch({ hqRoot, statePath });
  // Untouched: the fan-out writes these deliberately for a later pickup.
  assert.equal(existsSync(resultPath), true);
  assert.equal(existsSync(join(statePath, "..", "results", "stale")), false);
});

test("quarantine is a no-op when there is nothing to quarantine", () => {
  const root = mkdtempSync(join(tmpdir(), "stale-result-none-"));
  assert.equal(quarantineStaleResult(join(root, "absent.json")), null);
});

test("preparing twice does not re-quarantine the live dispatch's own result", () => {
  const { statePath } = fixture();
  const first = prepareDispatch({ hqRoot, statePath });
  // The agent answers.
  writeFileSync(first.resultPath, JSON.stringify({
    version: 1, dispatchId: first.dispatchId, stage: "qa", actor: "recovery",
    outcome: "pass", summary: "this cycle's real answer", evidence: [],
  }));
  // A second prepare returns the same ready dispatch and must not touch it.
  const second = prepareDispatch({ hqRoot, statePath });
  assert.equal(second.dispatchId, first.dispatchId);
  assert.equal(existsSync(first.resultPath), true);
  assert.match(JSON.parse(readFileSync(first.resultPath, "utf8")).summary, /this cycle's real answer/);
  assert.equal(readState(statePath).currentDispatch.id, first.dispatchId);
});
