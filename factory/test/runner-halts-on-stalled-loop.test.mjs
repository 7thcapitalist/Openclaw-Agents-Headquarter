// `runToTerminal` loops `while (response.status === "active")` with no sleep,
// no backoff, no iteration cap and no wall-clock budget. That is fine as long
// as every iteration waits on an agent. Under an idempotency-ledger replay it
// does not: `markDispatchRunning` and `ingestResult` return their previously
// committed responses instead of applying the mutation, the result file from
// the earlier dispatch is still on disk so `execute` is skipped entirely
// (`existsSync(prepared.resultPath) ? {} : await execute(...)`), and the body
// completes in milliseconds.
//
// Measured on the 2026-09-14 fixture: 86 iterations per second, 195 KiB written
// per iteration, zero revisions committed. In five and a half hours that was
// 403 GiB and 98% of a 468 GB disk.
//
// #226 refuses a dispatch id that is already in `state.dispatches`. That closes
// the incident's own path, but the guard's evidence lives in the state document
// while the ledger's lives in the `commands` table, and only the first can be
// rewritten — so any repair that shortens `state.dispatches` (an operator fix,
// a recovery-budget reset; see the note above `quarantineStaleResult`) reopens
// it. These tests pin the invariant that catches the class instead of the path:
// an iteration that commits no revision read the same inputs it will read next
// time, so the loop cannot terminate on its own.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { createState, readState, writeState, startRecovery, closeRecoveryIncident } from "../lib/task-workflow.mjs";
import { peekRevision } from "../lib/store/transactional-json.mjs";
import { prepareDispatch } from "../lib/openclaw-protocol.mjs";
import { runOneStage, runToTerminal, DEFAULT_MAX_STALLED_ITERATIONS } from "../lib/openclaw-runner.mjs";

const hqRoot = process.cwd();
const task = {
  id: "task-stall",
  issue: "local:stall",
  outcome: "Integrate and verify.",
  acceptanceCriteria: ["It is verified"],
  project: "demo",
  workType: "ops",
  risk: "low",
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runner-stall-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "evidence.txt"), "diagnosed\n");
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/x", worktree }));
  return { root, worktree, statePath, dbPath: join(root, "state", "state.sqlite") };
}

function ledgerRows(dbPath) {
  const db = new DatabaseSync(dbPath);
  try { return db.prepare("SELECT count(*) c FROM commands").get().c; } finally { db.close(); }
}

// Writes a valid result file for whatever dispatch it is handed.
function passingExecute({ delayMs = 0 } = {}) {
  return async ({ dispatch }) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    mkdirSync(join(dispatch.cwd, "evidence"), { recursive: true });
    writeFileSync(join(dispatch.cwd, "evidence", `${dispatch.stage}.md`), `${dispatch.stage} ok\n`);
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1,
      dispatchId: dispatch.dispatchId,
      stage: dispatch.stage,
      actor: dispatch.actor,
      outcome: "pass",
      summary: `${dispatch.stage} pass`,
      evidence: [`evidence/${dispatch.stage}.md`],
      ...(dispatch.stage === "reviewer" ? {} : {}),
      diagnosis: { cause: "x", fix: "y" },
    }));
    return { stdout: "{}", stderr: "" };
  };
}

// The 2026-09-14 shape, built through the real machinery: an earlier incident
// genuinely spends `-recovery-1-diagnose` (committing `running:<id>`,
// `agent-id:<id>` and `ingest:<id>` to the ledger, and leaving its result file
// on disk), then a second incident recomputes the same id because
// `recovery.active.attempt` restarted at 1 with no `ordinal`.
//
// `repair` removes the spent dispatch from `state.dispatches` the way an
// operator fix or a recovery-budget reset does, which is what carries this past
// #226's guard. The ledger is never rewritten, so the replay still happens.
async function buildCollision({ repair }) {
  const f = fixture();
  const spentId = `${task.id}-recovery-1-diagnose`;

  let s = readState(f.statePath);
  s.status = "active";
  s.currentStage = "reviewer";
  delete s.currentDispatch;
  s.stages = { ...(s.stages || {}), reviewer: { status: "failed", actor: "claude" } };
  s = startRecovery(s, { failedStage: "reviewer", actor: "claude", error: "flaky harness timeout", source: "execution" });
  writeState(f.statePath, s);

  await runOneStage({
    hqRoot, statePath: f.statePath,
    agentIds: { recovery: "mock-agent", "recovery-verify": "mock-agent" },
    execute: passingExecute(), publish: () => ({ published: false }),
  });
  assert.ok(readState(f.statePath).dispatches.some((d) => d.id === spentId), "incident 1 must spend the id");

  s = closeRecoveryIncident(readState(f.statePath), { reason: "operator repair" });
  s.status = "active";
  s.currentStage = "reviewer";
  delete s.currentDispatch;
  delete s.blocker;
  s = startRecovery(s, { failedStage: "reviewer", actor: "claude", error: "flaky harness timeout again", source: "execution" });
  delete s.recovery.active.ordinal; // pre-#219 legacy shape: the counter restarted at 1
  if (repair) s.dispatches = s.dispatches.filter((d) => d.id !== spentId);
  writeState(f.statePath, s);

  return { ...f, spentId };
}

test("a loop that commits nothing is stopped, and says which loop and why", async () => {
  const f = await buildCollision({ repair: true });

  // #226's guard does not fire here: the id is no longer in `state.dispatches`.
  assert.equal(prepareDispatch({ hqRoot, statePath: f.statePath }).dispatchId, f.spentId);

  const before = ledgerRows(f.dbPath);
  // An agent that takes two seconds and writes a valid result, like the real
  // one. It is reached exactly ONCE: the first iteration quarantines the
  // earlier incident's stale result file and dispatches for real, and the
  // agent's answer is then ingested under an id whose `ingest:` key is already
  // spent, so the ledger replays instead of applying it. From the second
  // iteration on the result file is on disk and never removed, so
  // `existsSync(prepared.resultPath) ? {} : await execute(...)` skips the agent
  // entirely and the body completes in under a millisecond.
  //
  // This is the shape the incident actually had: six diagnose dispatches over
  // seventeen hours were the iterations that reached an agent; between them it
  // span.
  let agentCalls = 0;
  const execute = async (args) => {
    agentCalls += 1;
    await new Promise((r) => setTimeout(r, 50));
    return passingExecute()(args);
  };

  await assert.rejects(
    () => runToTerminal({ hqRoot, statePath: f.statePath, agentIds: { recovery: "mock-agent" }, execute, publish: () => ({ published: false }) }),
    (error) => {
      assert.equal(error.stalledLoop, true);
      assert.equal(error.iterations, DEFAULT_MAX_STALLED_ITERATIONS);
      assert.equal(error.dispatchId, f.spentId);
      // It must name the loop and the mechanism, not just "something is wrong".
      assert.match(error.message, /runToTerminal is not making progress/);
      assert.match(error.message, /committed nothing/);
      assert.match(error.message, /idempotency-ledger replay/);
      assert.match(error.message, /running:<dispatchId>/);
      return true;
    },
  );

  assert.equal(agentCalls, 1, "the agent is reached once and then never again — that is the livelock");

  // The point of halting is that the storm never starts. Unbounded, this wrote
  // ~195 KiB per iteration at ~86 iterations/s.
  assert.ok(ledgerRows(f.dbPath) - before <= 12,
    `the halted loop must not write a storm; it added ${ledgerRows(f.dbPath) - before} ledger rows`);
});

test("the guard is what stops it — the loop body is barren and would repeat forever", async () => {
  // Deliberately NOT a race against a real spin: a spinning `runToTerminal`
  // starves the event loop (every `await` resolves on the microtask queue), so
  // a timer set to cut it short may never fire and would hang the suite.
  //
  // The invariant is provable without running the loop. Drive the loop BODY by
  // hand instead and show that it keeps reporting "active" — which is what
  // `while (response.status === "active")` repeats on — while committing
  // nothing and never reaching an agent. A loop over a body with those three
  // properties cannot terminate.
  const f = await buildCollision({ repair: true });
  let agentCalls = 0;
  const execute = async (args) => { agentCalls += 1; return passingExecute()(args); };

  // The first pass dispatches for real and is not barren; everything after it
  // is. Run one to get past it, then watch the body repeat.
  await runOneStage({ hqRoot, statePath: f.statePath, agentIds: { recovery: "mock-agent" }, execute, publish: () => ({ published: false }) });
  assert.equal(agentCalls, 1);

  const revisions = [];
  for (let i = 0; i < 6; i += 1) {
    const response = await runOneStage({
      hqRoot, statePath: f.statePath, agentIds: { recovery: "mock-agent" }, execute, publish: () => ({ published: false }),
    });
    assert.equal(response.status, "active", `iteration ${i + 1} must report the status the loop repeats on`);
    revisions.push(peekRevision(f.statePath));
  }

  assert.equal(new Set(revisions).size, 1, `the store never advanced: revisions were ${JSON.stringify(revisions)}`);
  assert.equal(agentCalls, 1, "and the agent was never reached again — that is why it spins at CPU speed");
});

test("#226's own path is still refused before the loop guard is reached", async () => {
  // Belt and braces: when the spent id IS still in `state.dispatches`, #226
  // throws at the first `prepareDispatch` and the loop never runs at all.
  const f = await buildCollision({ repair: false });
  await assert.rejects(
    () => runToTerminal({ hqRoot, statePath: f.statePath, agentIds: { recovery: "mock-agent" }, execute: passingExecute(), publish: () => ({ published: false }) }),
    (error) => {
      assert.match(error.message, /Refusing to reuse dispatch id/);
      assert.notEqual(error.stalledLoop, true);
      return true;
    },
  );
});

test("a healthy seven-stage run is untouched", async () => {
  const f = fixture();
  const response = await runToTerminal({
    hqRoot, statePath: f.statePath, execute: passingExecute(), publish: () => ({ published: false }),
  });
  assert.equal(response.status, "merge-ready", JSON.stringify(response.blocker || response));
  for (const stage of ["product", "architect", "builder", "reviewer", "qa", "security", "release"]) {
    assert.equal(readState(f.statePath).stages[stage].status, "pass", `${stage} must have run`);
  }
});

// ── the yielded path ─────────────────────────────────────────────────────────
//
// A yielded dispatch is the one case that legitimately spends a long time
// without finishing: the gateway turn hands off to a delegated worker, and the
// runner waits for that worker's result file, polling for up to an hour. That
// must never look like a stalled loop.
//
// Two independent reasons it cannot, both asserted here: the wait heartbeats
// through `touchState`, which commits a revision per poll; and the yielded
// paths return `waiting` (status "dispatch"), which ends the loop rather than
// continuing it.

function yieldingExecute() {
  return async () => ({ stdout: JSON.stringify({ status: "ok", result: { meta: { yielded: true } } }), stderr: "" });
}

test("a yielded dispatch heartbeats, so a long wait cannot trip the guard", async () => {
  const f = fixture();
  let polls = 0;
  const revisionsDuringWait = [];

  // Stands in for waitForYieldedResult: polls, heartbeats each time exactly as
  // the real one does, then the delegated worker's result lands.
  const waitForResult = async ({ resultPath, heartbeat }) => {
    for (let i = 0; i < 5; i += 1) {
      polls += 1;
      heartbeat();
      revisionsDuringWait.push(peekRevision(f.statePath));
    }
    mkdirSync(join(f.worktree, "evidence"), { recursive: true });
    writeFileSync(join(f.worktree, "evidence", "product.md"), "product ok\n");
    const state = readState(f.statePath);
    writeFileSync(resultPath, JSON.stringify({
      version: 1,
      dispatchId: state.currentDispatch.id,
      stage: state.currentDispatch.stage,
      actor: state.currentDispatch.actor,
      outcome: "pass",
      summary: "delegated worker finished",
      evidence: ["evidence/product.md"],
    }));
    return true;
  };

  // The most aggressive setting the guard offers: one barren iteration is
  // enough to halt. A legitimate yielded wait still must not trip it.
  const response = await runOneStage({
    hqRoot, statePath: f.statePath, execute: yieldingExecute(), waitForResult, publish: () => ({ published: false }),
  });

  assert.equal(polls, 5);
  assert.equal(response.status, "active", "the yielded result must be ingested, not discarded");
  assert.equal(new Set(revisionsDuringWait).size, 5, "every heartbeat must commit a revision");
});

test("an outstanding yielded dispatch ends the loop instead of spinning in it", async () => {
  const f = fixture();
  // The delegated worker has not answered yet: the bounded wait expires.
  const waitForResult = async ({ heartbeat }) => { heartbeat(); return false; };

  const response = await runToTerminal({
    hqRoot, statePath: f.statePath, execute: yieldingExecute(), waitForResult,
    maxStalledIterations: 1, publish: () => ({ published: false }),
  });

  assert.equal(response.waiting, true);
  assert.equal(response.status, "dispatch");
  assert.equal(readState(f.statePath).currentDispatch.yieldedAt !== undefined, true);

  // And the caller that polls by calling again does not accumulate a stall
  // count across calls: each call starts fresh and returns `waiting`.
  for (let i = 0; i < 4; i += 1) {
    const again = await runToTerminal({
      hqRoot, statePath: f.statePath, execute: yieldingExecute(), waitForResult,
      maxStalledIterations: 1, publish: () => ({ published: false }),
    });
    assert.equal(again.waiting, true, `poll ${i + 1} must keep waiting, not halt`);
  }
});
