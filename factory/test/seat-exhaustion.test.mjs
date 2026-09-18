// An exhausted seat pauses the work; it never spends budget and never loops.
//
// 2026-09-15: six objectives dispatched into seats that were out of session
// credit. Every dispatch that could not start was charged as a failure, recovery
// ran diagnose/verify against the same wall three times per task, and all six
// escalated to the founder within an hour, with nothing wrong with any of them.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { consecutiveSeatPauses, detectSeatExhaustion, parseResetTime, seatExhaustionExcerpt } from "../lib/seat-exhaustion.mjs";
import { countStageAttempts, createState, readState, resumeState, writeState } from "../lib/task-workflow.mjs";
import { computeDispatchPaths, prepareDispatch } from "../lib/openclaw-protocol.mjs";
import { runOneStage } from "../lib/openclaw-runner.mjs";
import { classifyBlocker } from "../lib/hq/blocker-class.mjs";
import { retryStuckTasks } from "../lib/hq/auto-retry.mjs";

const hqRoot = process.cwd();
const SESSION_LIMIT = "[openclaw] Could not start the CLI.\n[openclaw] Reason: All models failed (2): anthropic/claude-sonnet-5: You've hit your session limit · resets 12:40am (America/Indiana/Indianapolis) (unknown) | openai/gpt-5.6-luna: Auth profile \"openai:setup-1\" is temporarily unavailable for openai/gpt-5.6-luna.";

function scaffold(name) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  const statePath = join(root, "tasks", "issue-seats", "state.json");
  mkdirSync(worktree, { recursive: true });
  const task = {
    id: "issue-seats", issue: "seats", outcome: "Prove an exhausted seat pauses the task",
    acceptanceCriteria: ["The task pauses"], project: "sample", workType: "backend", risk: "low",
  };
  const state = createState({ task, repo: root, branch: "factory/issue-seats", worktree, maxRecoveryAttempts: 3 });
  state.currentStage = "builder";
  state.stages.product = { status: "pass", actor: "openclaw", summary: "ok", evidence: [{ path: "evidence/p.md" }] };
  state.stages.architect = { status: "pass", actor: "claude", summary: "ok", evidence: [{ path: "evidence/a.md" }] };
  writeState(statePath, state);
  return { root, worktree, statePath };
}

// execFile rejects with the CLI's stderr attached, which is what the runner reads.
const exhaustedSeat = async () => {
  const error = new Error("Command failed: openclaw agent --agent backend-builder");
  error.stderr = SESSION_LIMIT;
  throw error;
};

test("the detector recognises exhausted and throttled seats, and not review prose", () => {
  const now = Date.parse("2026-09-16T02:29:45Z");
  const exhausted = detectSeatExhaustion(SESSION_LIMIT, { now });
  assert.equal(exhausted.kind, "exhausted");
  // 12:40am in Indianapolis (EDT, UTC-4) is 04:40 UTC — the provider's own reset.
  assert.equal(exhausted.resumeAfter, "2026-09-16T04:40:00.000Z");
  assert.equal(exhausted.fromProvider, true);

  assert.equal(detectSeatExhaustion("Auth profile \"openai:setup-1c5e\" is temporarily unavailable for openai/gpt-5.4-mini.", { now }).kind, "exhausted");
  assert.equal(detectSeatExhaustion("HTTP 429 Too Many Requests; retry after 90 seconds", { now }).resumeAfter, "2026-09-16T02:31:15.000Z");

  for (const prose of [
    "reviewer: the rate limit middleware returns 500 instead of 429 for bursts",
    "usage limit banner renders twice on the billing page",
    "[openclaw] Reason: This operation was aborted | 20",
    "builder dispatch wrote no result file",
  ]) assert.equal(detectSeatExhaustion(prose, { now }), null, prose);
});

// 2026-09-18: Codex words it differently from Claude, and prints it only in
// stdout as a JSON "message"; the CLI's own error is a bare "Command failed".
// The detector missed both, so an exhausted seat read as a broken task and
// recovery ran three times against a seat that was gone for five hours.
const CODEX_LIMIT = "You've reached your Codex subscription usage limit. Next reset in 5 hours, Sep 18 at 7:56 PM EDT. Wait until the reset time, use another Codex account if available, or switch to another configured model/provider.";
const CODEX_STDOUT = JSON.stringify({ type: "error", error: { message: CODEX_LIMIT } }, null, 2);

test("Codex's 'reached your ... usage limit' is an exhausted seat, reset at its own clock", () => {
  const now = Date.parse("2026-09-18T15:00:00Z"); // 11:00 EDT
  const exhausted = detectSeatExhaustion(CODEX_LIMIT, { now });
  assert.equal(exhausted.kind, "exhausted");
  // 7:56 PM EDT is 23:56 UTC: the absolute clock wins over the rounded "in 5 hours".
  assert.equal(exhausted.resumeAfter, "2026-09-18T23:56:00.000Z");
  assert.equal(exhausted.fromProvider, true);
  assert.equal(new Date(parseResetTime("Next reset in 2 hours.", { now })).toISOString(), "2026-09-18T17:00:00.000Z");
  for (const prose of [
    "when users reach the usage limit, show a banner",
    "the reviewer reached a limit of three verdicts",
  ]) assert.equal(detectSeatExhaustion(prose, { now }), null, prose);
});

test("the provider's sentence is lifted out of raw executor output", () => {
  assert.equal(seatExhaustionExcerpt(CODEX_STDOUT), CODEX_LIMIT);
  assert.equal(seatExhaustionExcerpt("no seat problem here"), null);
});

for (const [label, execute] of [
  ["the CLI rejects with a bare 'Command failed'", async () => {
    const error = new Error("Command failed: openclaw agent --agent frontend-builder");
    error.stdout = CODEX_STDOUT;
    error.stderr = "";
    throw error;
  }],
  ["the CLI exits cleanly", async () => ({ stdout: CODEX_STDOUT, stderr: "" })],
]) {
  test(`an exhausted Codex seat pauses the stage when ${label} and the message is only in stdout`, async () => {
    const { statePath } = scaffold(`seat-pause-codex-${label.length}`);
    const result = await runOneStage({ hqRoot, statePath, execute, maxAttemptsPerStage: 3 });

    const state = readState(statePath);
    assert.equal(result.status, "blocked");
    assert.equal(state.blocker.outcome, "paused-credits");
    assert.match(state.blocker.resumeAfter, /T(23|00):56:00\.000Z$/, "the provider's own reset, not a guessed cooldown");
    assert.equal(classifyBlocker(state.blocker), "infra", "the system resumes it; the founder is not paged");
    // Field by field, not deepEqual: the counter gains fields over time (e.g.
    // `repeats`), and none of them may move for a paused seat.
    const attempts = countStageAttempts(state, "builder");
    assert.equal(attempts.verdicts, 0, "no verdict charged");
    assert.equal(attempts.infra, 0, "no infrastructure attempt charged");
    assert.equal(attempts.passes, 0);
    assert.equal(state.recovery.attempts.length, 0, "recovery never runs against an exhausted seat");
    assert.equal(state.recovery.active, null);
  });
}

test("a reset clock already past today resolves to tomorrow", () => {
  const now = Date.parse("2026-09-16T05:00:00Z"); // 01:00 EDT, after 12:40am
  assert.equal(new Date(parseResetTime("resets 12:40am (America/New_York)", { now })).toISOString(), "2026-09-17T04:40:00.000Z");
});

test("an exhausted seat pauses the stage without spending any budget", async () => {
  const { statePath } = scaffold("seat-pause-stage");
  const result = await runOneStage({ hqRoot, statePath, execute: exhaustedSeat, maxAttemptsPerStage: 3 });

  const state = readState(statePath);
  assert.equal(result.status, "blocked");
  assert.equal(state.blocker.outcome, "paused-credits");
  // The provider's own reset (12:40am Indianapolis), not a guessed cooldown.
  assert.match(state.blocker.resumeAfter, /T0[45]:40:00\.000Z$/);
  assert.match(state.blocker.summary, /Nothing was charged/);
  assert.equal(classifyBlocker(state.blocker), "infra", "the system resumes it; the founder is not paged");
  // Neither budget moved, and recovery never started.
  assert.deepEqual(countStageAttempts(state, "builder"), { verdicts: 0, infra: 0, passes: 0, total: 1 });
  assert.equal(state.recovery.attempts.length, 0);
  assert.equal(state.recovery.active, null);
  assert.ok(state.events.some((e) => e.type === "dispatch-paused-seats"));
});

test("a paused recovery dispatch resumes the same attempt under a fresh dispatch id", async () => {
  const { statePath } = scaffold("seat-pause-recovery");
  const state = readState(statePath);
  // Recovery is mid-diagnosis when the seat runs out.
  state.recovery = { maxAttempts: 3, maxTotalAttempts: 9, incident: 1, active: { phase: "diagnose", failedStage: "builder", attempt: 1, ordinal: 1 },
    attempts: [{ incident: 1, ordinal: 1, number: 1, strategy: "retry-recover", failedStage: "builder", classification: "INFRASTRUCTURE_ERROR", status: "diagnosing" }] };
  writeState(statePath, state);

  await runOneStage({ hqRoot, statePath, execute: exhaustedSeat, maxAttemptsPerStage: 3 });
  const paused = readState(statePath);
  assert.equal(paused.blocker.outcome, "paused-credits");
  assert.equal(paused.recovery.attempts.length, 1, "no recovery attempt was spent");
  assert.equal(paused.recovery.attempts[0].status, "diagnosing");
  assert.deepEqual(paused.recovery.active, state.recovery.active, "the open attempt is kept, not failed");

  // Resuming continues that attempt. Its first dispatch id is spent, so the
  // re-dispatch must get its own rather than being refused.
  writeState(statePath, resumeState(paused));
  const resumed = readState(statePath);
  assert.ok(resumed.recovery.active, "resume does not close the incident a pause interrupted");
  const prepared = prepareDispatch({ hqRoot, statePath });
  assert.equal(prepared.status, "dispatch");
  assert.equal(prepared.dispatchId, "issue-seats-recovery-1-diagnose-r2");
});

test("an orphaned recovery dispatch gets a fresh id instead of a refusal", () => {
  const state = { task: { id: "t" }, recovery: { active: { phase: "diagnose", failedStage: "reviewer", attempt: 1, ordinal: 1 } },
    dispatches: [{ id: "t-recovery-1-diagnose", status: "failed", error: "orphaned after runner restart" }, { id: "t-recovery-1-diagnose-r2", status: "failed" }] };
  assert.equal(computeDispatchPaths({ state, stage: "reviewer", statePath: "/x/state.json" }).dispatchId, "t-recovery-1-diagnose-r3");
});

test("seats that never come back escalate to the founder instead of pausing forever", async () => {
  const { statePath } = scaffold("seat-pause-bound");
  let final;
  for (let i = 0; i < 10; i += 1) {
    await runOneStage({ hqRoot, statePath, execute: exhaustedSeat, maxAttemptsPerStage: 3 });
    final = readState(statePath);
    if (final.blocker?.outcome !== "paused-credits") break;
    writeState(statePath, resumeState(final));
  }
  assert.equal(final.blocker.outcome, "decision-required");
  assert.equal(final.blocker.seatExhausted, true);
  assert.match(final.blocker.summary, /6 consecutive waits/);
  assert.equal(consecutiveSeatPauses(final.dispatches), 6);
  assert.equal(final.recovery.attempts.length, 0, "and it still spent no recovery budget getting there");
});

test("the sweep waits for the reset, then resumes without spending auto-retries", async () => {
  const { root, statePath } = scaffold("seat-pause-sweep");
  await runOneStage({ hqRoot, statePath, execute: exhaustedSeat, maxAttemptsPerStage: 3 });
  const resumeAfter = readState(statePath).blocker.resumeAfter;
  const stateRoot = join(root, "tasks");
  let ran = 0;
  const runTask = async () => { ran += 1; return { status: "active" }; };

  const early = await retryStuckTasks({ hqRoot, stateRoot, runTask, now: () => new Date(Date.parse(resumeAfter) - 60_000).toISOString() });
  assert.equal(ran, 0);
  assert.match(early.skipped[0].reason, /seats paused until/);

  await retryStuckTasks({ hqRoot, stateRoot, runTask, now: () => new Date(Date.parse(resumeAfter) + 1000).toISOString() });
  assert.equal(ran, 1);
  const after = readState(statePath);
  assert.equal(after.status, "active");
  assert.equal(after.autoRetries || 0, 0, "waking a paused task is not a retry of a failure");
  assert.ok(after.events.some((e) => e.type === "seat-pause-resumed"));
});

test("a paused task reads as paused until its reset, never as a failure for the founder", async () => {
  const { buildOutcome } = await import("../lib/failure-outcome.mjs");
  const outcome = buildOutcome({
    blocker: { stage: "builder", outcome: "paused-credits", resumeAfter: "2026-09-16T04:40:00.000Z", summary: "Paused: no model seat could run builder (You've hit your session limit)." },
    whatFailed: "Your objective",
  });
  assert.equal(outcome.outcomeClass, "paused-credits");
  assert.equal(outcome.resumeAfter, "2026-09-16T04:40:00.000Z");
  assert.equal(outcome.needsFounder, false);
  assert.match(outcome.headline, /paused/);
});
