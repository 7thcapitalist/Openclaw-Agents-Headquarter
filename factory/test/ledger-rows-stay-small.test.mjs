// The idempotency ledger stored a full copy of the task's state document on
// every single mutation.
//
// `mutateTransactionalState`'s `toResponse` defaults to returning the next
// state, and whatever it returns is also what `recordCommand` writes into
// `commands.response_json`. No caller in the repository passed a `toResponse`,
// so every mutation — including the no-op early-return path of
// `prepareDispatch`, whose `prepare:<uuid>` key can never be replayed and whose
// stored response can therefore never be read — cost one full state document.
//
// At the 2026-09-14 incident's 195 KiB state and 2.21M mutations, that is
// 403 GiB. It is also quadratic on a healthy long-running task, because
// `state.events[]` grows with every committed revision and every row holds
// another copy of the whole thing.
//
// Two fixes, and the ledger's purpose survives both: a command whose key is a
// fresh UUID keeps its row and drops its payload, and a command with a stable
// key stores the small projection its caller actually consumes — which is then
// exactly what a replay hands back.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { mutateTransactionalState } from "../lib/store/transactional-json.mjs";
import { prepareDispatch, markDispatchRunning, recordDispatchAgentId } from "../lib/openclaw-protocol.mjs";
import { runToTerminal } from "../lib/openclaw-runner.mjs";

const hqRoot = process.cwd();
const task = {
  id: "task-ledger",
  issue: "local:ledger",
  outcome: "Ship it.",
  acceptanceCriteria: ["It works"],
  project: "demo",
  workType: "ops",
  risk: "low",
};

function fixture({ padKiB = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ledger-size-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  const dbPath = join(root, "state", "state.sqlite");
  mkdirSync(worktree, { recursive: true });
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/x", worktree }));
  if (padKiB) {
    const s = readState(statePath);
    s.notes = "x".repeat(padKiB * 1024);
    writeState(statePath, s);
  }
  return { root, worktree, statePath, dbPath };
}

function ledger(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT command_id, entity_id, applied_at, response_json FROM commands ORDER BY rowid").all();
  } finally {
    db.close();
  }
}

function passingExecute() {
  return async ({ dispatch }) => {
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
    }));
    return { stdout: "{}", stderr: "" };
  };
}

test("a no-op prepare keeps its audit row and stops carrying the document", () => {
  const f = fixture({ padKiB: 190 });
  const stateBytes = statSync(f.statePath).size;
  assert.ok(stateBytes > 190 * 1024, "the fixture needs a realistically large state document");

  prepareDispatch({ hqRoot, statePath: f.statePath });
  const afterFirst = ledger(f.dbPath).length;

  // The second call takes the early-return branch: the dispatch is already
  // `ready`, so nothing is committed. This is the path the write storm spun on.
  prepareDispatch({ hqRoot, statePath: f.statePath });
  const rows = ledger(f.dbPath);

  const noop = rows.at(-1);
  assert.equal(rows.length, afterFirst + 1, "the audit row is still written");
  assert.match(noop.command_id, /^prepare:/);
  assert.ok(noop.applied_at, "the audit chain keeps when it ran");
  assert.ok(noop.entity_id, "and against which entity");

  // The whole point: the row costs bytes, not kilobytes.
  assert.ok(noop.response_json.length < 200,
    `a no-op prepare row must be tiny; it is ${noop.response_json.length} bytes against a ${stateBytes} byte state`);
});

test("no ledger row carries a state document, across a whole seven-stage run", async () => {
  const f = fixture({ padKiB: 190 });
  const response = await runToTerminal({
    hqRoot, statePath: f.statePath, execute: passingExecute(), publish: () => ({ published: false }),
  });
  assert.equal(response.status, "merge-ready", JSON.stringify(response.blocker || response));

  const rows = ledger(f.dbPath);
  assert.ok(rows.length >= 20, `a full run should still record its commands; it recorded ${rows.length}`);

  const worst = rows.reduce((a, b) => (a.response_json.length >= b.response_json.length ? a : b));
  const stateBytes = statSync(f.statePath).size;
  assert.ok(worst.response_json.length < 4096,
    `no ledger row may carry a state document; "${worst.command_id}" is ${worst.response_json.length} bytes `
    + `against a ${stateBytes} byte state`);

  // Stated as the invariant that actually matters: the ledger's total size must
  // not scale with the size of the state document.
  const total = rows.reduce((n, r) => n + r.response_json.length, 0);
  assert.ok(total < stateBytes,
    `the entire ledger (${total} bytes) must cost less than one copy of the state (${stateBytes} bytes)`);
});

test("a stable key still replays exactly what it returned the first time", () => {
  const f = fixture();
  const prepared = prepareDispatch({ hqRoot, statePath: f.statePath });

  const first = markDispatchRunning({ statePath: f.statePath, dispatchId: prepared.dispatchId });
  // The same command again: the ledger must short-circuit and hand back the
  // identical response rather than re-running the mutation (which would throw
  // "already running").
  const replayed = markDispatchRunning({ statePath: f.statePath, dispatchId: prepared.dispatchId });
  assert.deepEqual(replayed, first);
  assert.equal(replayed.dispatchId, prepared.dispatchId);
  assert.equal(replayed.status, "dispatch");

  const agentFirst = recordDispatchAgentId({ statePath: f.statePath, dispatchId: prepared.dispatchId, agentId: "mock-agent" });
  const agentReplay = recordDispatchAgentId({ statePath: f.statePath, dispatchId: prepared.dispatchId, agentId: "mock-agent" });
  assert.equal(agentFirst, "mock-agent");
  assert.equal(agentReplay, agentFirst);
});

test("an unreplayable command presented twice fails loudly instead of returning a placeholder", () => {
  const f = fixture();
  const commandId = "test-unreplayable:fixed";
  const once = mutateTransactionalState(f.statePath, {
    commandId,
    replayable: false,
    mutate: (state) => ({ ...state, notes: "first" }),
  });
  assert.equal(once.notes, "first", "the caller still gets the real response on the only call that counts");

  // Callers declare `replayable: false` because their key is a fresh UUID. If
  // that is ever untrue, the placeholder must not be mistaken for a response.
  assert.throws(
    () => mutateTransactionalState(f.statePath, { commandId, replayable: false, mutate: (state) => state }),
    (error) => {
      assert.match(error.message, /recorded as unreplayable/);
      assert.match(error.message, new RegExp(commandId));
      assert.match(error.message, /stable, meaningful commandId/);
      return true;
    },
  );
});
