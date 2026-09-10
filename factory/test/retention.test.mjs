import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { RETENTION_CLASSES, buildRetentionSnapshot, classify, inspectBackupHealth, planRetention } from "../lib/hq/retention.mjs";

const NOW = Date.parse("2026-09-10T00:00:00.000Z");
const CLI = new URL("../../scripts/factory-retention.mjs", import.meta.url).pathname;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hq-retention-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({ learning: { evidenceRetentionDays: 90 } }));
  return root;
}

function put(root, relPath, { ageDays = 0, body = "x" } = {}) {
  const path = join(root, "dashboard", "backend", "data", "factory", relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  const seconds = (NOW - ageDays * 86_400_000) / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

const stateRoot = (root) => join(root, "dashboard", "backend", "data", "factory");
const plan = (root, over = {}) => planRetention({ hqRoot: root, now: NOW, ...over });
const entry = (view, relPath) => view.eligible.find((file) => file.path === relPath);

// --- the governing rule ------------------------------------------------------

test("canonical and audit data are never prunable, whatever their age", () => {
  const root = fixture();
  put(root, "proj/tasks/t1/state.json", { ageDays: 3650 });
  put(root, "proj/objectives/o1/objective-state.json", { ageDays: 3650 });
  put(root, "proj/tasks/t1/audit.ndjson", { ageDays: 3650 });
  put(root, "proj/wakeups.json", { ageDays: 3650 });

  const view = plan(root);
  assert.equal(view.eligible.length, 0, "a decade-old canonical record is still the record");
  assert.equal(RETENTION_CLASSES.canonical.prunable, false);
  assert.equal(RETENTION_CLASSES["append-only-audit"].prunable, false);
});

test("an unrecognised file is protected, not swept", () => {
  const root = fixture();
  put(root, "proj/tasks/t1/something-nobody-classified.bin", { ageDays: 3650 });
  assert.equal(classify(join(stateRoot(root), "proj/tasks/t1/something-nobody-classified.bin"), { stateRoot: stateRoot(root) }), "protected");
  assert.equal(plan(root).eligible.length, 0);
});

test("keys and certificates are protected regardless of where they sit", () => {
  const root = fixture();
  for (const name of ["founder-approval-key.pem", "server.key", "chain.crt"]) {
    put(root, `results/${name}`, { ageDays: 3650 });
    assert.equal(classify(join(stateRoot(root), "results", name), { stateRoot: stateRoot(root) }), "protected",
      `${name} sits under results/ but must never be an ephemeral candidate`);
  }
  assert.equal(plan(root).eligible.length, 0);
});

test("a plan is a proposal: producing one deletes nothing", () => {
  const root = fixture();
  const path = put(root, "proj/tasks/t1/results/r1.json", { ageDays: 90 });
  const view = plan(root);
  assert.equal(view.applied, false);
  assert.equal(view.eligible.length, 1);
  assert.equal(existsSync(path), true, "the file the plan proposes to remove is still there");
});

// --- classes and ages --------------------------------------------------------

test("ephemeral results and handoffs age out; recent ones do not", () => {
  const root = fixture();
  put(root, "proj/tasks/t1/results/old.json", { ageDays: 30 });
  put(root, "proj/tasks/t1/results/new.json", { ageDays: 2 });
  put(root, "proj/tasks/t1/handoff-builder.md", { ageDays: 30 });

  const view = plan(root);
  assert.equal(view.eligible.length, 2);
  assert.ok(entry(view, "proj/tasks/t1/results/old.json"));
  assert.ok(entry(view, "proj/tasks/t1/handoff-builder.md"));
  assert.equal(entry(view, "proj/tasks/t1/results/new.json"), undefined);
});

test("a file that is kept says why it is kept", () => {
  const root = fixture();
  put(root, "proj/tasks/t1/results/new.json", { ageDays: 2 });
  put(root, "proj/tasks/t1/state.json", { ageDays: 900 });
  const all = planRetention({ hqRoot: root, now: NOW });
  // `eligible` only lists candidates, so read the storage view for the rest.
  assert.equal(all.storage.ephemeral.eligibleFiles, 0);
  assert.equal(all.storage.canonical.prunable, false);
  assert.equal(all.totals.protectedFiles, 1);
});

test("derived projections age out on a longer clock than ephemeral output", () => {
  const root = fixture();
  put(root, "proj/tasks/t1/liveness.json", { ageDays: 20 });
  put(root, "proj/tasks/t1/results/r.json", { ageDays: 20 });
  const view = plan(root);
  assert.equal(entry(view, "proj/tasks/t1/results/r.json") !== undefined, true, "ephemeral output ages out at 14 days");
  assert.equal(entry(view, "proj/tasks/t1/liveness.json"), undefined, "a projection the dashboard reads is kept longer");
  assert.equal(plan(root, { now: NOW + 20 * 86_400_000 }).eligible.some((file) => file.path.endsWith("liveness.json")), true);
});

test("storage is reported per class so growth has a cause", () => {
  const root = fixture();
  put(root, "proj/tasks/t1/state.json", { body: "y".repeat(100) });
  put(root, "proj/tasks/t1/results/r1.json", { body: "z".repeat(500), ageDays: 30 });
  const view = plan(root);
  assert.equal(view.storage.canonical.bytes, 100);
  assert.equal(view.storage.ephemeral.bytes, 500);
  assert.equal(view.storage.ephemeral.eligibleBytes, 500);
  assert.equal(view.totals.bytes, 600);
});

// --- backups -----------------------------------------------------------------

test("no configured backup directory is reported, not assumed healthy", () => {
  const health = inspectBackupHealth({ backupDir: null });
  assert.equal(health.configured, false);
  assert.equal(health.status, "not-configured");
});

test("a missing backup directory is a warning, not an absence of news", () => {
  const health = inspectBackupHealth({ backupDir: join(fixture(), "no-such-dir") });
  assert.equal(health.status, "missing");
  assert.match(health.warnings.join(" "), /does not exist/);
});

test("a fresh backup is hashed so 'a backup exists' means it could be read", () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-backups-"));
  writeFileSync(join(dir, "hq-2026-09-09.tar.gz"), "archive-bytes");
  const health = inspectBackupHealth({ backupDir: dir, now: Date.now() });
  assert.equal(health.status, "ok");
  assert.equal(health.latest.sha256.length, 64);
  assert.equal(health.backups, 1);
});

test("a stale backup is flagged against its bound", () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-backups-"));
  const path = join(dir, "hq-old.tar.gz");
  writeFileSync(path, "old");
  const seconds = (Date.now() - 72 * 3_600_000) / 1000;
  utimesSync(path, seconds, seconds);
  const health = inspectBackupHealth({ backupDir: dir, maxAgeHours: 24 });
  assert.equal(health.status, "warning");
  assert.match(health.warnings.join(" "), /past the 24h bound/);
});

test("an empty archive is worse than none, and says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-backups-"));
  writeFileSync(join(dir, "hq-empty.tar.gz"), "");
  assert.match(inspectBackupHealth({ backupDir: dir }).warnings.join(" "), /is empty/);
});

test("a backup failure marker surfaces even when a recent archive exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-backups-"));
  writeFileSync(join(dir, "hq-2026-09-09.tar.gz"), "ok");
  writeFileSync(join(dir, "backup.failure"), "upload to object storage failed\nsecond line");
  const health = inspectBackupHealth({ backupDir: dir });
  assert.equal(health.status, "warning");
  assert.equal(health.lastFailure.message, "upload to object storage failed");
});

// --- the snapshot ------------------------------------------------------------

test("the snapshot restates that destruction needs an operator", () => {
  const root = fixture();
  put(root, "proj/tasks/t1/state.json");
  assert.equal(buildRetentionSnapshot({ hqRoot: root, now: NOW }).destructiveActionsRequireOperator, true);
});

test("a missing state root degrades rather than reporting an empty, healthy factory", () => {
  const view = buildRetentionSnapshot({ hqRoot: fixture(), now: NOW });
  assert.equal(view.available, false);
  assert.match(view.warnings.join(" "), /does not exist yet/);
});

// --- the only destructive path -----------------------------------------------

// The CLI resolves hqRoot from its OWN location, so it must be the copy inside
// the fixture. Running the repository's copy pointed every one of these tests
// at the real HQ state tree — the confirmation guard refused, which is why
// nothing was lost, but the tests were asserting against live data.
function cli(root, args) {
  const executable = join(root, "scripts", "factory-retention.mjs");
  try {
    return { code: 0, out: execFileSync(process.execPath, [executable, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

function cliFixture() {
  const root = fixture();
  const scripts = join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  execFileSync("cp", ["-r", new URL("../../factory", import.meta.url).pathname, root]);
  execFileSync("cp", [CLI, join(scripts, "factory-retention.mjs")]);
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({ learning: { evidenceRetentionDays: 90 } }));
  return root;
}

test("--apply refuses a class that is never prunable", () => {
  const root = cliFixture();
  put(root, "proj/tasks/t1/state.json", { ageDays: 900 });
  const result = cli(root, ["--class", "canonical", "--older-than", "30", "--apply", "--confirm", "1"]);
  assert.equal(result.code, 2);
  assert.match(result.out, /never prunable/);
  assert.equal(existsSync(join(stateRoot(root), "proj/tasks/t1/state.json")), true);
});

test("--apply refuses a count that no longer matches the plan", () => {
  const root = cliFixture();
  put(root, "proj/tasks/t1/results/r1.json", { ageDays: 90 });
  const result = cli(root, ["--class", "ephemeral", "--older-than", "30", "--apply", "--confirm", "99"]);
  assert.equal(result.code, 2);
  assert.match(result.out, /you confirmed 99 file\(s\) but the plan now targets 1/);
  assert.equal(existsSync(join(stateRoot(root), "proj/tasks/t1/results/r1.json")), true);
});

test("--apply refuses without an explicit confirmation, and without a single named class", () => {
  const root = cliFixture();
  put(root, "proj/tasks/t1/results/r1.json", { ageDays: 90 });
  assert.match(cli(root, ["--class", "ephemeral", "--older-than", "30", "--apply"]).out, /requires --confirm/);
  assert.match(cli(root, ["--class", "ephemeral", "--class", "derived", "--older-than", "30", "--apply", "--confirm", "1"]).out, /exactly one --class/);
  assert.equal(existsSync(join(stateRoot(root), "proj/tasks/t1/results/r1.json")), true);
});

test("--apply removes exactly the confirmed targets and nothing else", () => {
  const root = cliFixture();
  put(root, "proj/tasks/t1/results/r1.json", { ageDays: 90 });
  put(root, "proj/tasks/t1/results/r2.json", { ageDays: 90 });
  put(root, "proj/tasks/t1/results/recent.json", { ageDays: 1 });
  put(root, "proj/tasks/t1/state.json", { ageDays: 900 });

  const result = cli(root, ["--class", "ephemeral", "--older-than", "30", "--apply", "--confirm", "2"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /"removed": 2/);
  assert.equal(existsSync(join(stateRoot(root), "proj/tasks/t1/results/r1.json")), false);
  assert.equal(existsSync(join(stateRoot(root), "proj/tasks/t1/results/recent.json")), true, "a young file is not swept along");
  assert.equal(existsSync(join(stateRoot(root), "proj/tasks/t1/state.json")), true, "canonical state survives an ephemeral prune");
});

test("the default invocation reports and removes nothing", () => {
  const root = cliFixture();
  put(root, "proj/tasks/t1/results/r1.json", { ageDays: 900 });
  const result = cli(root, []);
  assert.equal(result.code, 0);
  assert.match(result.out, /"applied": false/);
  assert.equal(existsSync(join(stateRoot(root), "proj/tasks/t1/results/r1.json")), true);
});
