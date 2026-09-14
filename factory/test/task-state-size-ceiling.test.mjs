// No single task's state store may fill the disk.
//
// On 2026-09-14 one task's state.sqlite reached 403 GiB (105,423,722 pages for
// a task with 15 dispatches) and took the host to 98% of a 468 GB disk in 5h37m.
// Whatever drove that loop, a task dying is recoverable and a full disk is not:
// it takes every other task, the dashboard and the gateway down with it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  StateStoreFullError,
  maxStateBytes,
  mutateEntity,
  openStateDb,
  peekEntity,
  stateStoreBytes,
} from "../lib/store/sqlite-state.mjs";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "state-ceiling-"));
  const path = join(dir, "state.sqlite");
  return { dir, path, handle: openStateDb(path) };
}

function seed(handle, entityId = "task-ceiling") {
  mutateEntity(handle, {
    entityId,
    commandId: "seed",
    mutate: () => ({
      nextState: {
        version: 1,
        task: { id: entityId, risk: "low" },
        status: "active",
        currentStage: "builder",
        stages: {},
        events: [],
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      },
    }),
  });
  return entityId;
}

test("the ceiling defaults to 1 GiB and is overridable by env", () => {
  assert.equal(maxStateBytes({}), 1024 * 1024 * 1024);
  assert.equal(maxStateBytes({ FACTORY_MAX_TASK_STATE_BYTES: "4096" }), 4096);
  assert.equal(maxStateBytes({ FACTORY_MAX_TASK_STATE_BYTES: "0" }), 0, "0 disables the guard");
  // A typo must not silently remove the protection.
  assert.equal(maxStateBytes({ FACTORY_MAX_TASK_STATE_BYTES: "banana" }), 1024 * 1024 * 1024);
  assert.equal(maxStateBytes({ FACTORY_MAX_TASK_STATE_BYTES: "-5" }), 1024 * 1024 * 1024);
});

test("stateStoreBytes counts the WAL, not just the main file", () => {
  const { path, handle } = freshDb();
  seed(handle);
  const main = statSync(path).size;
  writeFileSync(`${path}-wal`, Buffer.alloc(5000));
  assert.ok(stateStoreBytes(path) >= main + 5000, "the WAL must be counted — a runaway write can sit there");
});

test("a store past its ceiling refuses the write and fails the task", (t) => {
  const { path, handle } = freshDb();
  const entityId = seed(handle);

  // An injected ceiling below the seeded file's real size.
  const real = stateStoreBytes(path);
  t.after(() => { delete process.env.FACTORY_MAX_TASK_STATE_BYTES; });
  process.env.FACTORY_MAX_TASK_STATE_BYTES = String(Math.max(1, real - 1));

  assert.throws(
    () => mutateEntity(handle, {
      entityId,
      commandId: "would-grow-the-file",
      mutate: (current) => ({ nextState: { ...current.state, currentStage: "reviewer" } }),
    }),
    (error) => {
      assert.ok(error instanceof StateStoreFullError, "must raise StateStoreFullError");
      // The reason must name the file and its size — that is what makes it
      // actionable at 3am.
      assert.match(error.message, /state\.sqlite/);
      assert.match(error.message, new RegExp(String(error.bytes)));
      assert.match(error.message, /FACTORY_MAX_TASK_STATE_BYTES/);
      assert.equal(error.ceiling, Math.max(1, real - 1));
      return true;
    },
  );

  const after = peekEntity(handle, entityId);
  assert.equal(after.state.status, "failed", "the task must be marked failed, not left active to retry");
  assert.match(after.state.blocker.summary, /size ceiling/);
  assert.equal(after.state.currentStage, "builder", "the refused mutation must not have been applied");
  assert.ok(
    after.state.events.some((e) => e.type === "state-store-full"),
    "the state-store-full event must be recorded",
  );
});

test("an already-failed task throws nothing further and stops rewriting itself", (t) => {
  const { path, handle } = freshDb();
  const entityId = seed(handle);
  const real = stateStoreBytes(path);
  t.after(() => { delete process.env.FACTORY_MAX_TASK_STATE_BYTES; });
  process.env.FACTORY_MAX_TASK_STATE_BYTES = String(Math.max(1, real - 1));

  assert.throws(() => mutateEntity(handle, {
    entityId, commandId: "first", mutate: (c) => ({ nextState: { ...c.state, currentStage: "reviewer" } }),
  }), StateStoreFullError);

  const revisionAfterFailure = peekEntity(handle, entityId).revision;

  // Once failed, the guard steps aside: the task is already stopped, so there is
  // nothing to protect against and no new failure marker to write.
  mutateEntity(handle, {
    entityId, commandId: "second", mutate: (c) => ({ nextState: { ...c.state, currentStage: "qa" } }),
  });
  assert.equal(peekEntity(handle, entityId).revision, revisionAfterFailure + 1);
});

test("under the ceiling, writes proceed untouched", (t) => {
  const { handle } = freshDb();
  const entityId = seed(handle);
  t.after(() => { delete process.env.FACTORY_MAX_TASK_STATE_BYTES; });
  process.env.FACTORY_MAX_TASK_STATE_BYTES = String(1024 ** 3);

  mutateEntity(handle, {
    entityId, commandId: "ordinary", mutate: (c) => ({ nextState: { ...c.state, currentStage: "reviewer" } }),
  });
  const after = peekEntity(handle, entityId);
  assert.equal(after.state.status, "active");
  assert.equal(after.state.currentStage, "reviewer");
});
