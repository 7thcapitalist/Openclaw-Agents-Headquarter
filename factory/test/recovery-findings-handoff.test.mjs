import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, writeState } from "../lib/task-workflow.mjs";
import { writeHandoff } from "../lib/handoff.mjs";

const hqRoot = process.cwd();

function fixture({ attempts, active = null, currentStage = "qa" }) {
  const root = mkdtempSync(join(tmpdir(), "recovery-findings-"));
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  const statePath = join(root, "state.json");
  const state = createState({
    task: { id: "t", issue: "1", outcome: "Ship it", acceptanceCriteria: ["works"], project: "p", workType: "backend", risk: "low" },
    repo: root, branch: "factory/t", worktree,
  });
  state.currentStage = currentStage;
  state.stages.product = { status: "pass", actor: "openclaw", summary: "ok", evidence: [{ path: "evidence/p.md" }] };
  state.recovery = { maxAttempts: 3, attempts, active };
  writeState(statePath, state);
  return { statePath, state, root };
}

const VERIFIED = {
  number: 1,
  failedStage: "qa",
  status: "verified",
  error: "qa dispatch wrote no result file",
  classification: "INFRASTRUCTURE_ERROR",
  repairTarget: "factory",
  diagnosis: { summary: "Ran the project's full verify gate; all acceptance criteria hold.", evidence: [{ path: "evidence/recovery-1-diagnosis.md" }] },
  repair: { status: "attempted", summary: "Completed the missing QA verification in the worktree." },
  verification: { outcome: "pass", summary: "Independently re-ran unit, integration and architecture suites; all green.", evidence: [{ path: "evidence/recovery-1-verify.log" }] },
};

// A verified recovery clears `recovery.active`, so the re-dispatched agent used
// to be handed a blank prompt — the diagnosis, repair and independent
// verification were recorded in state.json and shown to nobody.
test("a settled recovery's findings reach the stage that is re-dispatched", () => {
  const { statePath, state } = fixture({ attempts: [VERIFIED] });
  const prompt = readFileSync(writeHandoff({ hqRoot, statePath, state }), "utf8");
  assert.match(prompt, /## What recovery already established/);
  assert.match(prompt, /attempt 1, verified/);
  assert.match(prompt, /Ran the project's full verify gate/);
  assert.match(prompt, /Independently re-ran unit, integration and architecture suites/);
  assert.match(prompt, /evidence\/recovery-1-verify\.log/);
  assert.match(prompt, /evidence\/recovery-1-diagnosis\.md/);
  assert.match(prompt, /do not silently redo the work/);
});

test("a recovery still in flight keeps the existing in-cycle context instead", () => {
  const { statePath, state } = fixture({
    attempts: [VERIFIED],
    active: { phase: "diagnose", failedStage: "qa", attempt: 2 },
  });
  const prompt = readFileSync(writeHandoff({ hqRoot, statePath, state }), "utf8");
  assert.match(prompt, /## Recovery context/);
  assert.doesNotMatch(prompt, /## What recovery already established/);
});

test("findings for a different stage are not shown", () => {
  const { statePath, state } = fixture({
    attempts: [{ ...VERIFIED, failedStage: "builder" }],
    currentStage: "qa",
  });
  const prompt = readFileSync(writeHandoff({ hqRoot, statePath, state }), "utf8");
  assert.doesNotMatch(prompt, /## What recovery already established/);
});

test("a task that never recovered is unchanged", () => {
  const { statePath, state } = fixture({ attempts: [] });
  const prompt = readFileSync(writeHandoff({ hqRoot, statePath, state }), "utf8");
  assert.doesNotMatch(prompt, /## What recovery already established/);
});

test("a failed recovery's findings are carried too, so the retry does not repeat them", () => {
  const failed = { ...VERIFIED, status: "failed", verification: { outcome: "fail", summary: "Repair did not hold: route still produces no artifact." } };
  const { statePath, state } = fixture({ attempts: [failed] });
  const prompt = readFileSync(writeHandoff({ hqRoot, statePath, state }), "utf8");
  assert.match(prompt, /attempt 1, failed/);
  assert.match(prompt, /Repair did not hold/);
});
