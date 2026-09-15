// The retention report could not see the file that actually grows.
//
// `state.json` is an EXPORT. The SQLite store beside it is the authority, and
// on 2026-09-14 one task's `state.sqlite` reached 403 GiB while its
// `state.json` stayed at 195 KiB. `classify()` had no case for it, so it fell
// through to `protected` — correctly undeletable, but labelled "Unrecognised or
// sensitive file", and its bytes were absent from every storage total the
// founder reads. A storage report that cannot see the largest file in the tree
// is how a disk fills with nobody warned.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { RETENTION_CLASSES, classify, planRetention } from "../lib/hq/retention.mjs";

const NOW = Date.parse("2026-09-15T00:00:00.000Z");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hq-retention-store-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({ learning: { evidenceRetentionDays: 90 } }));
  return root;
}

function put(root, relPath, { ageDays = 0, bytes = 1 } = {}) {
  const path = join(root, "dashboard", "backend", "data", "factory", relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x".repeat(bytes));
  const seconds = (NOW - ageDays * 86_400_000) / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

const stateRoot = (root) => join(root, "dashboard", "backend", "data", "factory");

test("the SQLite store and its WAL/SHM siblings classify as canonical", () => {
  const root = "/state";
  for (const name of [
    "state.sqlite", "state.sqlite-wal", "state.sqlite-shm",
    "objective-state.sqlite", "objective-state.sqlite-wal",
    "control-plane.sqlite",
  ]) {
    assert.equal(classify(`${root}/proj/tasks/t1/${name}`, { stateRoot: root }), "canonical", name);
  }
});

test("an unrelated .sqlite file is not swept up by the new rule", () => {
  const root = "/state";
  // Only the three canonical stems. A dashboard session store or anything else
  // that happens to end in .sqlite keeps its protected default.
  assert.equal(classify(`${root}/sessions.sqlite`, { stateRoot: root }), "protected");
  assert.equal(classify(`${root}/proj/tasks/t1/scratch.sqlite`, { stateRoot: root }), "protected");
});

test("the store is counted in the storage report instead of being invisible", () => {
  const root = fixture();
  put(root, "proj/tasks/t1/state.json", { bytes: 2_000 });
  put(root, "proj/tasks/t1/state.sqlite", { bytes: 900_000 });
  put(root, "proj/tasks/t1/state.sqlite-wal", { bytes: 100_000 });

  const view = planRetention({ hqRoot: root, stateRoot: stateRoot(root), now: NOW });
  const canonical = view.storage.canonical;

  assert.equal(canonical.files, 3);
  assert.equal(canonical.bytes, 1_002_000, "the store's bytes must be in the canonical total, not missing");
  assert.equal(view.storage.protected, undefined, "nothing here is unrecognised any more");
  assert.equal(view.totals.bytes, 1_002_000);
});

test("naming it canonical does not make it deletable", () => {
  const root = fixture();
  put(root, "proj/tasks/t1/state.sqlite", { ageDays: 3650, bytes: 500 });

  const view = planRetention({ hqRoot: root, stateRoot: stateRoot(root), now: NOW });
  assert.equal(view.eligible.length, 0, "a decade-old store is still the authority");
  assert.equal(RETENTION_CLASSES.canonical.prunable, false);

  // And it says why, in terms that explain the file rather than shrug at it.
  assert.match(RETENTION_CLASSES.canonical.reason, /SQLite store that is its authority/);
  assert.doesNotMatch(RETENTION_CLASSES.canonical.reason, /Unrecognised/);
});
