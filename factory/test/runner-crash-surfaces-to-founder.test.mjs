// A throw out of `runToTerminal` must leave the task somewhere the founder can
// see it.
//
// #226 turned the 2026-09-14 dispatch-id collision from a silent 403 GiB write
// storm into a loud throw. The throw then landed nowhere: the dashboard's
// manual retry runs the runner in a detached promise whose only handler is
// `console.error`, and the auto-retry sweep recorded the error in its return
// value but left the task `active` with a fresh `updatedAt`. Either way the
// task stayed `active` with no blocker, looking alive to every founder surface,
// and the sweep re-picked it every 90 minutes until its budget ran out and it
// was skipped in silence from then on.
//
// These tests pin the settled shape, both call sites, and the two cases that
// must NOT be overwritten.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { recordRunnerCrash } from "../lib/openclaw-runner.mjs";
import { classifyBlocker, isRetriableInfraBlocker } from "../lib/hq/blocker-class.mjs";
import { retryStuckTasks } from "../lib/hq/auto-retry.mjs";

const task = {
  id: "task-crash",
  issue: "local:crash",
  outcome: "Integrate and verify.",
  acceptanceCriteria: ["It is verified"],
  project: "demo",
  workType: "ops",
  risk: "low",
};

function fixture(patch = (s) => s) {
  const root = mkdtempSync(join(tmpdir(), "runner-crash-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree, { recursive: true });
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/x", worktree }));
  const state = readState(statePath);
  state.status = "active";
  state.currentStage = "reviewer";
  writeState(statePath, patch(state));
  return { root, statePath };
}

// The Founder Inbox's blocked-task item (founderControlPlane.mjs) is built from
// exactly these two fields, plus a class that is not "infra". Asserting the
// predicate rather than the rendered card keeps this test honest about what it
// actually proves: the task reaches the queue.
function reachesFounderInbox(state) {
  return state.status === "blocked"
    && state.blocker?.outcome === "fail"
    && classifyBlocker(state.blocker) !== "infra";
}

test("an escaped runner error blocks the task and puts it in the founder queue", () => {
  const { statePath } = fixture((s) => {
    s.currentDispatch = { id: "task-crash-recovery-1-diagnose", stage: "reviewer", actor: "recovery", status: "ready" };
    return s;
  });

  recordRunnerCrash({
    statePath,
    error: new Error('Refusing to reuse dispatch id "task-crash-recovery-1-diagnose"'),
  });

  const state = readState(statePath);
  assert.equal(state.status, "blocked");
  assert.equal(state.blocker.outcome, "fail");
  assert.equal(state.blocker.actor, "system");
  assert.equal(state.blocker.stage, "reviewer");
  assert.match(state.blocker.summary, /Refusing to reuse dispatch id/);
  assert.equal(state.blocker.runnerCrash, true);
  assert.ok(reachesFounderInbox(state), "the task must reach the Founder Inbox");

  // The dispatch it died on is owned by nobody; leaving it makes the task look
  // like it still has a worker.
  assert.equal(state.currentDispatch, undefined);
  assert.ok(state.events.some((e) => e.type === "runner-crash"));
});

test("an escaped error is never classified as retriable infrastructure", () => {
  // The message deliberately contains phrases INFRA_FAIL_RE matches ("timed
  // out", "no result file"). An error that escapes the runner is deterministic
  // by construction — the same state reproduces it — so it must never be swept
  // on the strength of what the message happens to say.
  const { statePath } = fixture();
  recordRunnerCrash({ statePath, error: new Error("the agent timed out and wrote no result file") });

  const state = readState(statePath);
  assert.equal(classifyBlocker(state.blocker), "decision");
  assert.equal(isRetriableInfraBlocker(state.blocker), false);
});

test("a task already blocked by a control-flow error keeps its own, better reason", () => {
  // `runOneStage` parks a fatal error with `blockDispatch` and rethrows it
  // untouched. That blocker names the real cause (a merge conflict, a founder
  // decision); the generic wrapper must not replace it.
  const { statePath } = fixture((s) => {
    s.status = "blocked";
    s.blocker = { stage: "release", outcome: "decision-required", actor: "openclaw", summary: "merge conflict integrating factory/obj-c58897c0-game-backend", at: "2026-09-14T00:00:00Z" };
    return s;
  });

  recordRunnerCrash({ statePath, error: new Error("generic wrapper that would lose the conflict") });

  const state = readState(statePath);
  assert.equal(state.blocker.outcome, "decision-required");
  assert.match(state.blocker.summary, /merge conflict/);
  assert.equal(state.blocker.runnerCrash, undefined);
});

test("a finished task is not re-opened by a late throw", () => {
  for (const status of ["merge-ready", "verified"]) {
    const { statePath } = fixture((s) => { s.status = status; return s; });
    recordRunnerCrash({ statePath, error: new Error("too late") });
    assert.equal(readState(statePath).status, status);
  }
});

test("a task the size ceiling marked failed is promoted into the founder queue, keeping its reason", () => {
  // #224 stops a runaway writer by marking the task `failed`. Nothing reads a
  // task status of "failed" — the Founder Inbox keys off "blocked" — so the
  // disk was saved and the task still vanished.
  const ceilingSummary = "task state store exceeded its size ceiling and is refusing further writes: /x/state.sqlite is 1073741900 bytes (1.00 GiB), ceiling 1073741824 bytes (1.00 GiB).";
  const { statePath } = fixture((s) => {
    s.status = "failed";
    s.blocker = { stage: "reviewer", outcome: "fail", actor: "system", summary: ceilingSummary, at: "2026-09-14T00:00:00Z" };
    return s;
  });

  recordRunnerCrash({ statePath, error: new Error("task state store exceeded its size ceiling") });

  const state = readState(statePath);
  assert.equal(state.status, "blocked");
  assert.equal(state.blocker.summary, ceilingSummary, "the ceiling's own, more specific reason survives");
  assert.ok(reachesFounderInbox(state));
});

test("settling never replaces the original failure with a worse one", () => {
  const out = recordRunnerCrash({
    statePath: join(tmpdir(), "does-not-exist-" + Date.now(), "state.json"),
    error: new Error("original"),
  });
  assert.equal(out.settled, false);
  assert.ok(out.reason);
});

test("the auto-retry sweep settles a throwing task and never picks it up again", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-crash-sweep-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({ version: 1, openclawIntegration: {} }));
  const stateRoot = join(root, "state");

  const dir = join(stateRoot, "demo", "tasks", "task-throws");
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, "state.json");
  writeState(statePath, createState({ task: { ...task, id: "task-throws" }, repo: join(root, "repo"), branch: "factory/x", worktree: join(root, "wt") }));
  const seeded = readState(statePath);
  seeded.status = "blocked";
  seeded.currentStage = "release";
  seeded.blocker = { outcome: "fail", stage: "release", summary: "Agent did not write its result file: x-release-3.json", at: "2026-09-07T00:00:00Z" };
  writeState(statePath, seeded);

  const runTask = async () => { throw new Error('Refusing to reuse dispatch id "task-throws-recovery-1-diagnose"'); };
  const first = await retryStuckTasks({ hqRoot: root, stateRoot, max: 3, runTask, execute: async () => {} });

  assert.equal(first.retried.length, 1);
  assert.match(first.retried[0].error, /Refusing to reuse dispatch id/);

  const settled = readState(statePath);
  assert.equal(settled.status, "blocked");
  assert.match(settled.blocker.summary, /Refusing to reuse dispatch id/);
  assert.ok(reachesFounderInbox(settled), "the task must reach the Founder Inbox, not just the sweep's return value");

  // The sweep's pick-up condition is `blocked` + an INFRA blocker, or a stale
  // `active`. A settled crash is neither, so the next pass leaves it alone
  // instead of failing it identically every 90 minutes.
  const second = await retryStuckTasks({ hqRoot: root, stateRoot, max: 3, runTask, execute: async () => {} });
  assert.equal(second.retried.length, 0, "a settled crash must not be swept again");
});

// server.mjs starts a listener on import, so it cannot be exercised in-process
// the way auto-retry.mjs can. This is the same wiring guard the repository
// already uses for founder-facing endpoints (founder-questions.test.mjs): it
// proves the detached promise's rejection handler settles the task, which is
// the one thing about that call site that can silently regress.
test("the dashboard's detached manual retry settles the task on rejection", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../../dashboard/backend/server.mjs", import.meta.url), "utf8");

  assert.match(server, /import \{ runToTerminal as runTaskToTerminal, recordRunnerCrash \}/);

  const detached = server.slice(server.indexOf("runTaskToTerminal({"));
  const handler = detached.slice(0, detached.indexOf('res.status(202)'));
  assert.match(handler, /\.catch\(\(error\) => \{/, "the run is detached, so it needs a rejection handler");
  assert.match(handler, /recordRunnerCrash\(\{ statePath, error \}\)/,
    "a rejection that only reaches console.error leaves the task active forever");
});
