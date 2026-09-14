import test from "node:test";
import assert from "node:assert/strict";
import { computeDispatchPaths } from "../lib/openclaw-protocol.mjs";
import { createState, recordRecoveryResult, resumeState, startRecovery } from "../lib/task-workflow.mjs";

const task = {
  id: "obj-c58897c0-integration", issue: "local:x", outcome: "Integrate the parallel build tasks.",
  acceptanceCriteria: ["merges cleanly"], project: "lifemaxing", workType: "ops", risk: "medium",
};
const fresh = () => createState({ task, repo: "/tmp/r", branch: "b", worktree: "/tmp/w" });
const idFor = (state) => computeDispatchPaths({ state, stage: state.currentStage, statePath: "/tmp/s/state.json" }).dispatchId;

// obj-c58897c0 wedged for ten hours on this.
//
// `recovery.active.attempt` counts within the OPEN incident, so it restarts at
// 1 whenever an incident closes. computeDispatchPaths built the dispatch id
// from it, so incident 2's first attempt recomputed `-recovery-1-diagnose` —
// an id incident 1 had already spent.
//
// The result-file half of that collision was already mitigated by
// quarantineStaleResult(). The other half was not: markDispatchRunning keys its
// idempotency on `running:<dispatchId>`, so the store replayed the earlier
// committed command instead of applying the mutation. The dispatch stayed
// "ready" forever while the agent call ran, and the runner waited on a dispatch
// the state machine believed had never started. No blocker, no progress.
test("a second incident never reuses the first incident's dispatch id", () => {
  let s = startRecovery(fresh(), { failedStage: "reviewer", actor: "claude", error: "CHANGES REQUIRED", maxRecoveryAttempts: 3 });
  const first = idFor(s);
  assert.equal(first, "obj-c58897c0-integration-recovery-1-diagnose");

  // Repair, verify — which closes the incident and returns the budget.
  s = recordRecoveryResult(s, { outcome: "pass", actor: "claude", summary: "repaired" });
  s = recordRecoveryResult(s, { outcome: "pass", actor: "codex", summary: "verified" });

  // A new, unrelated failure opens incident 2 at attempt 1.
  s = startRecovery(s, { failedStage: "qa", actor: "claude", error: "qa agent could not run: Gateway agent call connection closed", maxRecoveryAttempts: 3 });
  assert.equal(s.recovery.active.attempt, 1, "per-incident numbering still restarts, which is what strategy selection needs");
  assert.notEqual(idFor(s), first, "but the dispatch id must not be reused");
  assert.equal(idFor(s), "obj-c58897c0-integration-recovery-2-diagnose");
});

test("ids stay unique across many incidents, including founder resumes", () => {
  const seen = new Set();
  let s = fresh();
  for (let i = 0; i < 6; i += 1) {
    s = startRecovery(s, { failedStage: "reviewer", actor: "claude", error: `failure ${i}`, maxRecoveryAttempts: 3 });
    const id = idFor(s);
    assert.ok(!seen.has(id), `dispatch id reused across incidents: ${id}`);
    seen.add(id);
    // Alternate the two ways an incident can close.
    if (i % 2 === 0) {
      s = recordRecoveryResult(s, { outcome: "pass", actor: "claude", summary: "repaired" });
      s = recordRecoveryResult(s, { outcome: "pass", actor: "codex", summary: "verified" });
    } else {
      s.status = "blocked";
      s.blocker = { stage: "reviewer", outcome: "decision-required", summary: "needs you" };
      s = resumeState(s);
    }
  }
  assert.equal(seen.size, 6);
});

test("the verify phase keeps the diagnose phase's ordinal", () => {
  let s = startRecovery(fresh(), { failedStage: "reviewer", actor: "claude", error: "CHANGES REQUIRED", maxRecoveryAttempts: 3 });
  s = recordRecoveryResult(s, { outcome: "pass", actor: "claude", summary: "repaired" });
  assert.equal(s.recovery.active.phase, "verify");
  assert.equal(idFor(s), "obj-c58897c0-integration-recovery-1-verify", "diagnose and verify are one attempt, distinguished by phase");
});

test("legacy recovery state with no ordinal still computes an id", () => {
  const s = fresh();
  s.recovery = { maxAttempts: 3, attempts: [{ number: 1 }, { number: 2 }], active: { phase: "diagnose", failedStage: "reviewer", attempt: 2 } };
  s.currentStage = "reviewer";
  assert.equal(idFor(s), "obj-c58897c0-integration-recovery-2-diagnose",
    "tasks written before ordinal existed keep the id they already used");
});

test("a stage dispatch id is unaffected", () => {
  const s = fresh();
  assert.equal(idFor(s), "obj-c58897c0-integration-product-1");
});
