// A founder job's displayed status follows its objective's canonical state.
//
// control-plane.json `jobs` is the dashboard's note about a request; the
// objective's own state is the truth about the work. When the process that
// would have settled a job dies first, or the objective is ended from somewhere
// else, the note says "running" forever. On the live board four jobs did, over
// objectives that were cancelled or complete. The property under test: the
// display reads the canonical terminal state, and reading writes nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildObjectivesView,
  findInFlightDuplicateJob,
  listFounderJobs,
} from "../../dashboard/backend/lib/founderControlPlane.mjs";

const OBJECTIVE = "Build a Cost & Limits view";

function hq() {
  const root = mkdtempSync(join(tmpdir(), "hq-jobs-canonical-"));
  const dataDir = join(root, "dashboard", "backend", "data", "factory");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({ openclawIntegration: {} }));
  return { root, dataDir, controlPath: join(dataDir, "control-plane.json") };
}

function writeObjective(dataDir, objectiveId, status, nodes = {}) {
  const dir = join(dataDir, "Openclaw-Agents-Headquarter", "objectives", objectiveId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "objective-state.json");
  writeFileSync(path, `${JSON.stringify({
    objectiveId, objective: OBJECTIVE, project: "openclaw-factory", status,
    createdAt: "2026-09-08T01:47:00.000Z", updatedAt: "2026-09-15T21:11:11.000Z",
    nodes, events: [],
  }, null, 2)}\n`);
  return path;
}

function writeJobs(controlPath, jobs) {
  writeFileSync(controlPath, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`);
}

const job = (id, objectiveId, status, createdAt = new Date().toISOString()) => ({
  id, kind: "objective", projectId: "openclaw-factory", objective: OBJECTIVE,
  repo: "/tmp/repo", status, objectiveId, createdAt, updatedAt: createdAt,
});

test("a job whose objective is cancelled displays cancelled", () => {
  const { root, dataDir, controlPath } = hq();
  writeObjective(dataDir, "obj-842f30eb", "cancelled");
  writeJobs(controlPath, [job("founder-mts0ecy8", "obj-842f30eb", "running")]);

  const [shown] = listFounderJobs(root);
  assert.equal(shown.status, "cancelled");
  assert.equal(shown.storedStatus, "running", "what was recorded stays visible");
  assert.equal(shown.statusSource, "objective");
});

test("a job whose objective is complete displays complete — recovery jobs included", () => {
  const { root, dataDir, controlPath } = hq();
  writeObjective(dataDir, "obj-154e9b39", "complete");
  writeJobs(controlPath, [
    job("founder-mu4cbjmf", "obj-154e9b39", "running", "2026-09-16T16:53:58.935Z"),
    { ...job("founder-recovery-mu4gigsh", "obj-154e9b39", "recovering", "2026-09-16T18:51:20.297Z"), kind: "objective-recovery" },
  ]);

  const byId = Object.fromEntries(listFounderJobs(root).map((j) => [j.id, j]));
  assert.equal(byId["founder-mu4cbjmf"].status, "complete");
  assert.equal(byId["founder-recovery-mu4gigsh"].status, "complete");
  assert.equal(byId["founder-recovery-mu4gigsh"].storedStatus, "recovering");
});

test("a truly running job still displays running", () => {
  const { root, dataDir, controlPath } = hq();
  writeObjective(dataDir, "obj-live0001", "running", { n1: { id: "n1", status: "running", dependsOn: [] } });
  writeJobs(controlPath, [
    job("founder-live", "obj-live0001", "running"),
    { ...job("founder-planning", undefined, "decomposing"), objectiveId: undefined },
  ]);

  const byId = Object.fromEntries(listFounderJobs(root).map((j) => [j.id, j]));
  assert.equal(byId["founder-live"].status, "running");
  assert.equal(byId["founder-live"].storedStatus, undefined, "nothing derived, nothing annotated");
  assert.equal(byId["founder-planning"].status, "decomposing", "a job with no objective yet keeps its own status");
});

test("a job whose objective state is missing keeps its stored status", () => {
  const { root, controlPath } = hq();
  writeJobs(controlPath, [job("founder-orphan", "obj-gone0001", "running")]);
  assert.equal(listFounderJobs(root)[0].status, "running");
});

test("reading jobs leaves control-plane.json and the objective state byte-identical", () => {
  const { root, dataDir, controlPath } = hq();
  const objectivePath = writeObjective(dataDir, "obj-842f30eb", "cancelled");
  writeJobs(controlPath, [
    job("founder-mts0ecy8", "obj-842f30eb", "running"),
    job("founder-other", "obj-gone0001", "running"),
  ]);
  const controlBefore = readFileSync(controlPath);
  const objectiveBefore = readFileSync(objectivePath);

  listFounderJobs(root);
  findInFlightDuplicateJob(root, { projectId: "openclaw-factory", objective: OBJECTIVE });
  buildObjectivesView(root);

  assert.ok(readFileSync(controlPath).equals(controlBefore), "control-plane.json must not be rewritten by a read");
  assert.ok(readFileSync(objectivePath).equals(objectiveBefore), "objective-state.json must not be rewritten by a read");
});

test("a job over a finished objective never counts as in flight", () => {
  const { root, dataDir, controlPath } = hq();
  writeObjective(dataDir, "obj-842f30eb", "cancelled");
  writeObjective(dataDir, "obj-154e9b39", "complete");
  writeJobs(controlPath, [
    job("founder-cancelled", "obj-842f30eb", "running"),
    job("founder-complete", "obj-154e9b39", "running"),
  ]);
  assert.equal(findInFlightDuplicateJob(root, { projectId: "openclaw-factory", objective: OBJECTIVE }), null);

  writeObjective(dataDir, "obj-live0001", "running");
  writeJobs(controlPath, [
    job("founder-cancelled", "obj-842f30eb", "running"),
    job("founder-live", "obj-live0001", "running"),
  ]);
  assert.equal(findInFlightDuplicateJob(root, { projectId: "openclaw-factory", objective: OBJECTIVE })?.id, "founder-live");
});

test("unfinished nodes inside a cancelled objective display as cancelled, not running", () => {
  const { root, dataDir } = hq();
  writeObjective(dataDir, "obj-842f30eb", "cancelled", {
    data: { id: "obj-842f30eb-cost-limits-data-apis", role: "backend-builder", status: "running", dependsOn: [] },
    panel: { id: "obj-842f30eb-cost-limits-today-panel", role: "frontend-builder", status: "pending", dependsOn: [] },
    done: { id: "obj-842f30eb-done", role: "backend-builder", status: "gate-satisfied", dependsOn: [] },
  });

  const obj = buildObjectivesView(root).objectives.find((o) => o.objectiveId === "obj-842f30eb");
  const nodes = Object.fromEntries(obj.nodes.map((n) => [n.id, n]));
  assert.equal(nodes["obj-842f30eb-cost-limits-data-apis"].status, "cancelled");
  assert.equal(nodes["obj-842f30eb-cost-limits-data-apis"].storedStatus, "running");
  assert.equal(nodes["obj-842f30eb-cost-limits-today-panel"].status, "cancelled");
  assert.equal(nodes["obj-842f30eb-done"].status, "gate-satisfied", "finished work keeps its real outcome");
  assert.ok(!obj.nodeBriefs.some((b) => b.status === "RUNNING"), "no founder-facing brief may read Running");
  assert.equal(obj.nodeBriefs.find((b) => b.id === "obj-842f30eb-cost-limits-data-apis").statusLabel, "Cancelled");
});

test("nodes of a running objective are left exactly as recorded", () => {
  const { root, dataDir } = hq();
  writeObjective(dataDir, "obj-live0001", "running", {
    n1: { id: "obj-live0001-n1", role: "backend-builder", status: "running", dependsOn: [] },
  });
  const obj = buildObjectivesView(root).objectives.find((o) => o.objectiveId === "obj-live0001");
  assert.equal(obj.nodes[0].status, "running");
  assert.equal(obj.nodes[0].storedStatus, undefined);
});
