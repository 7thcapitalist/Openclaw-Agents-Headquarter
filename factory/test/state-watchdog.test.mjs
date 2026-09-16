import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkStateGrowth, readAutoRetryHalt, writeAutoRetryHalt } from "../lib/hq/state-watchdog.mjs";

function stateRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "state-watchdog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "proj", "tasks", "t1"), { recursive: true });
  return root;
}

test("healthy state files call for no action", (t) => {
  const root = stateRoot(t);
  writeFileSync(join(root, "proj", "tasks", "t1", "state.sqlite"), Buffer.alloc(10));
  assert.deepEqual(checkStateGrowth({ stateRoot: root, haltBytes: 100, stopBytes: 1000 }), { scanned: 1, oversized: [], action: "none" });
});

test("a WAL past the halt threshold halts, and one past the stop threshold stops", (t) => {
  const root = stateRoot(t);
  const wal = join(root, "proj", "tasks", "t1", "state.sqlite-wal");
  writeFileSync(join(root, "proj", "tasks", "t1", "notes.json"), Buffer.alloc(5000));
  writeFileSync(wal, Buffer.alloc(200));
  assert.equal(checkStateGrowth({ stateRoot: root, haltBytes: 100, stopBytes: 1000 }).action, "halt");
  writeFileSync(wal, Buffer.alloc(2000));
  const result = checkStateGrowth({ stateRoot: root, haltBytes: 100, stopBytes: 1000 });
  assert.equal(result.action, "stop");
  assert.equal(result.oversized[0].path, wal);
});

test("the halt switch round-trips, and an unreadable halt file still halts", (t) => {
  const root = stateRoot(t);
  assert.equal(readAutoRetryHalt(root), null);
  writeAutoRetryHalt(root, { haltedAt: "2026-09-16T00:00:00Z", reason: "test" });
  assert.equal(readAutoRetryHalt(root).reason, "test");
  writeFileSync(join(root, "AUTO_RETRY_HALTED.json"), "{ not json");
  assert.ok(readAutoRetryHalt(root), "a corrupt halt file must not resume retries");
});
