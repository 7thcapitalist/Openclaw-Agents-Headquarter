import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLegacyStateFiles, migrateFiles } from "../../../scripts/migrate-factory-state.mjs";
import { readTransactionalState } from "../../lib/store/transactional-json.mjs";

function layout() {
  const root = mkdtempSync(join(tmpdir(), "migrate-"));
  const taskDir = join(root, "proj", "tasks", "issue-1");
  const objDir = join(root, "proj", "objectives", "obj-1");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(objDir, { recursive: true });
  const statePath = join(taskDir, "state.json");
  const objectivePath = join(objDir, "objective-state.json");
  writeFileSync(statePath, JSON.stringify({ status: "active", events: [{ at: "t1", type: "task-created" }] }));
  writeFileSync(objectivePath, JSON.stringify({ objectiveId: "obj-1", nodes: {}, events: [] }));
  return { root, statePath, objectivePath };
}

test("findLegacyStateFiles discovers every state.json and objective-state.json under the root, nothing else", () => {
  const { root, statePath, objectivePath } = layout();
  writeFileSync(join(root, "proj", "not-state.json"), "{}");
  const found = findLegacyStateFiles(root);
  assert.deepEqual(found.sort(), [statePath, objectivePath].sort());
});

test("migrateFiles imports every discovered file exactly once and preserves content verbatim", () => {
  const { root, statePath, objectivePath } = layout();
  const files = findLegacyStateFiles(root);
  const report = migrateFiles(files);
  assert.equal(report.imported.length, 2);
  assert.equal(report.quarantined.length, 0);
  assert.deepEqual(readTransactionalState(statePath).events, [{ at: "t1", type: "task-created" }]);
  assert.equal(readTransactionalState(objectivePath).objectiveId, "obj-1");
});

test("migrateFiles is idempotent: a second run over the same files reports already-current, imports nothing new", () => {
  const { root } = layout();
  const files = findLegacyStateFiles(root);
  migrateFiles(files);
  const second = migrateFiles(files);
  assert.equal(second.imported.length, 0);
  assert.equal(second.alreadyCurrent.length, 2);
});

test("a corrupt legacy file is quarantined and reported, without blocking a good file's migration, and its bytes are never touched", () => {
  const root = mkdtempSync(join(tmpdir(), "migrate-corrupt-"));
  const dir = join(root, "proj", "tasks", "issue-2");
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, "state.json");
  const broken = "{ not valid json at all";
  writeFileSync(statePath, broken);
  const goodDir = join(root, "proj", "tasks", "issue-3");
  mkdirSync(goodDir, { recursive: true });
  const goodPath = join(goodDir, "state.json");
  writeFileSync(goodPath, JSON.stringify({ status: "active", events: [] }));

  const files = findLegacyStateFiles(root);
  const report = migrateFiles(files);
  assert.equal(report.quarantined.length, 1);
  assert.equal(report.quarantined[0].path, statePath);
  assert.ok(report.quarantined[0].reason.length > 0, "an actionable reason must be surfaced");
  // The one corrupt file failing must not stop the good file from migrating.
  assert.deepEqual(report.imported, [goodPath]);
  // And the corrupt file itself is byte-for-byte untouched: a failed
  // migration leaves the original data exactly as it was.
  assert.equal(readFileSync(statePath, "utf8"), broken);
});
