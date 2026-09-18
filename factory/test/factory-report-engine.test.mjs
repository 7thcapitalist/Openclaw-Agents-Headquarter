import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildFactoryReport } from "../../dashboard/backend/lib/factory-report/engine.mjs";
import { writeFactoryReportSnapshot } from "../../dashboard/backend/lib/factory-report/writer.mjs";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "../..");

test("report engine reads SQLite + result files, remains read-only, and writes byte-identical snapshots", () => {
  const fixture = createFixture();
  const before = readFileSync(fixture.dbPath);
  const first = buildFactoryReport({ hqRoot: fixture.hqRoot, stateRoot: fixture.stateRoot, now: "2026-09-17T12:34:56Z" });
  const firstPath = writeFactoryReportSnapshot({ stateRoot: fixture.stateRoot, snapshot: first });
  const firstBytes = readFileSync(firstPath);
  const second = buildFactoryReport({ hqRoot: fixture.hqRoot, stateRoot: fixture.stateRoot, now: "2026-09-17T23:59:59Z" });
  const secondPath = writeFactoryReportSnapshot({ stateRoot: fixture.stateRoot, snapshot: second });
  const secondBytes = readFileSync(secondPath);

  assert.deepEqual(secondBytes, firstBytes);
  assert.deepEqual(readFileSync(fixture.dbPath), before, "SQLite authority must not be modified by the reader");
  assert.equal(first.generatedAt, "2026-09-17T00:00:00.000Z");
  assert.equal(first.metrics.some((metric) => metric.value === null), false);

  const byId = new Map(first.metrics.map((metric) => [metric.id, metric]));
  assert.equal(byId.get("objectives-complete").value, 1);
  assert.equal(byId.get("dispatches-per-merged-task").value, 4);
  assert.equal(byId.get("no-verdict.overall").value, 1);
  assert.equal(byId.get("no-verdict.reviewer").value, 1);
  assert.equal(byId.get("founder-interruptions.infra").value, 1);
  assert.equal(byId.get("founder-interruptions.product").value, 1);
  assert.equal(byId.get("cycle-time.product").value, 750_000);
  assert.equal(byId.get("cycle-time.architect").value, 600_000);
  assert.equal(byId.get("wall-time-per-objective").value, 3_600_000);
  for (const metric of first.metrics) {
    assert.ok(metric.sourcePath.length > 0, metric.id);
    for (const path of metric.sourcePath) assert.equal(existsSync(resolve(fixture.hqRoot, path)), true, `${metric.id}: ${path}`);
  }
});

test("CLI writes a null snapshot and exits non-zero for missing authoritative input", () => {
  const hqRoot = mkdtempSync(join(tmpdir(), "factory-report-empty-"));
  const stateRoot = join(hqRoot, "factory");
  mkdirSync(stateRoot, { recursive: true });
  const run = spawnSync(process.execPath, [join(REPO, "scripts", "factory-report.mjs"), `--state-root=${stateRoot}`], { cwd: REPO, encoding: "utf8" });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const date = new Date().toISOString().slice(0, 10);
  const snapshot = JSON.parse(readFileSync(join(stateRoot, "_metrics", `${date}.json`), "utf8"));
  assert.ok(snapshot.metrics.some((metric) => metric.value === null));
  for (const metric of snapshot.metrics.filter((item) => item.value === null)) {
    assert.ok(metric.reason);
    assert.ok(metric.sourcePath.length > 0, metric.id);
  }
});

test("malformed entity.state_json becomes null metrics instead of a confident zero", () => {
  const hqRoot = mkdtempSync(join(tmpdir(), "factory-report-malformed-"));
  const stateRoot = join(hqRoot, "dashboard", "backend", "data", "factory");
  const dbPath = join(stateRoot, "acme", "objectives", "obj-bad", "objective-state.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  createDb(dbPath, "not-json", []);
  const snapshot = buildFactoryReport({ hqRoot, stateRoot, now: "2026-09-17T00:00:00Z" });
  const metric = snapshot.metrics.find((item) => item.id === "objectives-complete");
  assert.equal(metric.value, null);
  assert.match(metric.reason, /malformed/);
});

function createFixture() {
  const hqRoot = mkdtempSync(join(tmpdir(), "factory-report-"));
  const stateRoot = join(hqRoot, "dashboard", "backend", "data", "factory");
  const dbPath = join(stateRoot, "acme", "objectives", "obj-1", "objective-state.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  const state = {
    objectiveId: "obj-1", status: "complete", createdAt: "2026-09-17T00:00:00Z",
    nodes: {
      "task-1": { id: "task-1", status: "gate-satisfied", attempts: 4, startedAt: "2026-09-17T00:00:00Z" },
      "task-2": { id: "task-2", status: "blocked", attempts: 1, startedAt: "2026-09-17T00:00:00Z" },
    },
    integration: { id: "obj-1-integration", status: "published" },
  };
  const events = [
    { at: "2026-09-17T00:00:00Z", type: "objective-decomposed" },
    { at: "2026-09-17T00:20:00Z", type: "node-blocked", node: "task-2", detail: "Could not start the CLI; retry later" },
    { at: "2026-09-17T00:30:00Z", type: "node-blocked", node: "task-2", detail: "Founder must choose paid tier" },
    { at: "2026-09-17T01:00:00Z", type: "objective-finished", detail: "complete" },
  ];
  createDb(dbPath, JSON.stringify(state), events);
  result(stateRoot, "task-1", "product", 1, "pass", "2026-09-17T00:10:00Z");
  result(stateRoot, "task-1", "architect", 1, "pass", "2026-09-17T00:20:00Z");
  result(stateRoot, "task-1", "builder", 1, "pass", "2026-09-17T00:30:00Z");
  result(stateRoot, "task-1", "reviewer", 1, "Agent DID NOT WRITE ITS RESULT FILE", "2026-09-17T00:40:00Z");
  result(stateRoot, "task-2", "product", 1, "pass", "2026-09-17T00:15:00Z");
  return { hqRoot, stateRoot, dbPath };
}

function createDb(path, stateJson, events) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE entity (id TEXT PRIMARY KEY, state_json TEXT NOT NULL); CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload_json TEXT NOT NULL);");
  db.prepare("INSERT INTO entity (id, state_json) VALUES (?, ?)").run("objective", stateJson);
  const insert = db.prepare("INSERT INTO events (payload_json) VALUES (?)");
  for (const event of events) insert.run(JSON.stringify(event));
  db.close();
}

function result(stateRoot, taskId, stage, attempt, content, at) {
  const path = join(stateRoot, "acme", "tasks", taskId, "results", `${taskId}-${stage}-${attempt}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const time = new Date(at);
  utimesSync(path, time, time);
}
