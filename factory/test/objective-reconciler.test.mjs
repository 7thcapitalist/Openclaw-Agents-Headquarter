// Objectives that nobody is running.
//
// The orchestrator is a function, not a daemon, and in production it runs
// inside the dashboard's express process. Restarting that process abandons
// every objective mid-flight: the nodes keep whatever status they held, and
// nothing looks at them again.
//
// The case that prompted this is obj-2fbb6bcd on 2026-09-15 — decomposed at
// 15:29Z into two nodes, both `pending`, no task state files, still sitting
// there four hours later. Nothing could see it: retryStuckTasks scans for task
// state files blocked on an infra-class blocker, and this objective had no task
// state files at all.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resumeStrandedObjectives, strandedNodes } from "../lib/hq/objective-reconciler.mjs";

function objectiveFixture(root, project, objectiveId, { status = "active", nodes = {}, integration = null } = {}) {
  const dir = join(root, project, "objectives", objectiveId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "objective-state.json");
  writeFileSync(path, `${JSON.stringify({
    version: 1, objectiveId, objective: "do the thing", project,
    repo: join(root, "repo"), status, nodes,
    integration: integration || { id: `${objectiveId}-integration`, status: "pending", dependsOn: [] },
    events: [], createdAt: "2026-09-15T15:29:16.934Z", updatedAt: "2026-09-15T15:29:16.934Z",
  }, null, 2)}\n`, "utf8");
  return path;
}

const node = (id, status, extra = {}) => ({ id, status, dependsOn: [], ...extra });

function stateRoot() {
  return mkdtempSync(join(tmpdir(), "objective-reconcile-"));
}

// ── the decision, tested without a filesystem ────────────────────────────────

test("a decomposed objective whose nodes never ran is stranded", () => {
  const verdict = strandedNodes({
    status: "active",
    nodes: { a: node("a", "pending"), b: node("b", "pending") },
    integration: { id: "i", status: "pending" },
  });
  assert.equal(verdict.stranded, true);
  assert.deepEqual(verdict.nodeIds.sort(), ["a", "b", "i"]);
});

test("a node left `running` by a killed process is stranded — nothing can be running at boot", () => {
  const verdict = strandedNodes({ status: "active", nodes: { a: node("a", "running") } });
  assert.equal(verdict.stranded, true);
  assert.deepEqual(verdict.nodeIds, ["a"]);
});

test("a blocked node is a decision, not an interruption, and is left alone", () => {
  // This is the line that keeps the reconciler from becoming an auto-retry loop
  // by another name: re-running work that failed is the founder's call.
  const verdict = strandedNodes({
    status: "blocked",
    nodes: { a: node("a", "blocked", { blocker: { outcome: "decision-required" } }), b: node("b", "failed") },
    integration: { id: "i", status: "blocked" },
  });
  assert.equal(verdict.stranded, false);
  assert.match(verdict.reason, /no node is waiting/);
});

test("a blocked objective with one released node IS resumed", () => {
  // Exactly obj-d4e18cad after its founder decision: the objective wrapper
  // still says `blocked` while the answered node has gone back to `pending`.
  const verdict = strandedNodes({
    status: "blocked",
    nodes: { a: node("a", "pending"), b: node("b", "blocked-by-dep") },
    integration: { id: "i", status: "pending" },
  });
  assert.equal(verdict.stranded, true);
  assert.ok(verdict.nodeIds.includes("a"));
});

test("a finished objective is never restarted", () => {
  for (const status of ["complete", "completed", "cancelled", "superseded"]) {
    const verdict = strandedNodes({ status, nodes: { a: node("a", "pending") } });
    assert.equal(verdict.stranded, false, `${status} must not be resumed`);
    assert.match(verdict.reason, new RegExp(status));
  }
});

test("garbage is not stranded, it is skipped", () => {
  assert.equal(strandedNodes(null).stranded, false);
  assert.equal(strandedNodes("nonsense").stranded, false);
  assert.equal(strandedNodes({ status: "active" }).stranded, false, "no nodes at all");
});

// ── the sweep ────────────────────────────────────────────────────────────────

test("the sweep hands every stranded objective to the orchestrator, once", async () => {
  const root = stateRoot();
  objectiveFixture(root, "lifemaxing", "obj-2fbb6bcd", { nodes: { a: node("a", "pending") } });
  objectiveFixture(root, "lifemaxing", "obj-done", { status: "complete", nodes: { a: node("a", "pending") } });
  objectiveFixture(root, "hq", "obj-blocked", {
    status: "blocked", nodes: { a: node("a", "blocked") },
    integration: { id: "obj-blocked-integration", status: "blocked" },
  });

  const calls = [];
  const out = await resumeStrandedObjectives({
    hqRoot: root, stateRoot: root,
    runObjective: async (opts) => { calls.push(opts); return { status: "complete" }; },
    readConfig: () => ({ openclawIntegration: { agentIds: { builder: "codex" }, maxAttemptsPerStage: 4 } }),
  });

  assert.equal(out.scanned, 3);
  assert.equal(out.resumed.length, 1, "only the stranded one");
  assert.equal(out.resumed[0].objectiveId, "obj-2fbb6bcd");
  assert.equal(out.skipped.length, 2);

  // The detached runs are started but not awaited by the sweep.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxAttemptsPerStage, 4, "the factory's configured budgets are passed through");
  assert.deepEqual(calls[0].agentIds, { builder: "codex" });
  // <stateRoot>/<project> — the same root runObjective computes for itself when
  // none is passed (`dirname(objectivePath)/../..`), which is where that
  // project's tasks/ directory lives.
  assert.equal(calls[0].stateRoot, join(root, "lifemaxing"),
    "and a state root the orchestrator can find the project's tasks under");
});

test("the sweep is bounded, so a boot after a long outage cannot start fifty runs", async () => {
  const root = stateRoot();
  for (let i = 0; i < 5; i += 1) {
    objectiveFixture(root, "lifemaxing", `obj-${i}`, { nodes: { a: node("a", "pending") } });
  }
  const out = await resumeStrandedObjectives({
    hqRoot: root, stateRoot: root, max: 2,
    runObjective: async () => ({ status: "complete" }),
    readConfig: () => ({}),
  });
  assert.equal(out.resumed.length, 2);
  assert.equal(out.skipped.filter((s) => /sweep limit/.test(s.reason)).length, 3);
});

test("one unreadable state file does not stop the objectives after it", async () => {
  const root = stateRoot();
  const broken = join(root, "lifemaxing", "objectives", "obj-broken");
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "objective-state.json"), "{ not json", "utf8");
  objectiveFixture(root, "lifemaxing", "obj-zzz-good", { nodes: { a: node("a", "pending") } });

  const out = await resumeStrandedObjectives({
    hqRoot: root, stateRoot: root,
    runObjective: async () => ({ status: "complete" }),
    readConfig: () => ({}),
  });
  assert.equal(out.resumed.length, 1, "the good objective still started");
  assert.equal(out.resumed[0].objectiveId, "obj-zzz-good");
  assert.ok(out.skipped.some((s) => /unreadable/.test(s.reason)));
});

test("an orchestrator that throws is reported, not propagated", async () => {
  const root = stateRoot();
  objectiveFixture(root, "lifemaxing", "obj-explodes", { nodes: { a: node("a", "pending") } });
  const logged = [];

  // Must not reject: one objective that cannot start is not a reason to leave
  // the others unstarted, and boot must not fall over.
  const out = await resumeStrandedObjectives({
    hqRoot: root, stateRoot: root,
    runObjective: async () => { throw new Error("orchestrator exploded"); },
    readConfig: () => ({}),
    log: (m) => logged.push(m),
  });
  assert.equal(out.resumed.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(logged.some((m) => /did not resume.*orchestrator exploded/.test(m)), logged.join("\n"));
});

test("an empty or missing state root is silence, not an error", async () => {
  const out = await resumeStrandedObjectives({
    hqRoot: "/nope", stateRoot: join(tmpdir(), "does-not-exist-objective-reconcile"),
    runObjective: async () => { throw new Error("must not be called"); },
    readConfig: () => ({}),
  });
  assert.deepEqual(out, { scanned: 0, resumed: [], skipped: [] });
});

test("the sweep refuses to run without an orchestrator", async () => {
  await assert.rejects(
    () => resumeStrandedObjectives({ hqRoot: "/x", stateRoot: "/x" }),
    /runObjective is required/,
  );
});

// The wiring: boot must actually call this, or the module is decoration.
test("the dashboard resumes stranded objectives when it starts", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const server = readFileSync(join(repo, "dashboard", "backend", "server.mjs"), "utf8");

  assert.match(server, /resumeStrandedObjectives/, "server.mjs must import the reconciler");
  assert.match(server, /app\.listen\([\s\S]{0,320}?resumeStrandedObjectivesOnBoot\(\)/,
    "and call it from the listen callback, where nothing can be running yet");
});
