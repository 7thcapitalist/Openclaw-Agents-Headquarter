// Starting an objective, from either surface.
//
// `handleObjectiveStart` is the sequence the local dashboard's POST route and
// the console's `objective.start` intent both need. It exists so the two cannot
// drift — in particular so the high-risk preflight below cannot be present on
// one path and missing on the other.
//
// The property under test throughout: NOTHING FAILS SILENTLY. A start that dies
// in planning, is blocked on the approval key, or fails hours later in the
// pipeline must each leave a record a screen can show.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleObjectiveStart, listFounderJobs, saveFounderJob, findInFlightDuplicateJob, DUPLICATE_JOB_WINDOW_MS } from "../../dashboard/backend/lib/founderControlPlane.mjs";

function hq({ paused = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hq-objective-start-"));
  const repo = join(root, "repos", "lifemax");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "projects.json"), JSON.stringify({
    projects: [{ key: "lifemaxing", name: "LifeMax", repo, status: "active" }],
  }));
  // Pause is founder presentation state and lives in control-plane.json, not
  // in the project registry — the registry's own `status` means something else.
  const dataDir = join(root, "dashboard", "backend", "data", "factory");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "control-plane.json"),
    JSON.stringify({ projects: paused ? { lifemaxing: { status: "paused" } } : {} }));
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({ openclawIntegration: {} }));
  return { root, repo };
}

function graphWith(nodes) {
  return { objectiveId: "obj-test01", status: "planned", nodes, events: [] };
}

const node = (over = {}) => ({ id: "n1", status: "pending", dependsOn: [], contract: { risk: "low" }, ...over });

test("a start that plans successfully writes state, returns the objective, and runs it", async () => {
  const { root } = hq();
  let ran = null;
  const result = await handleObjectiveStart({
    root, hqRoot: root, objective: "Ship the thing", projectId: "lifemaxing",
    decompose: async () => graphWith({ n1: node(), n2: node({ id: "n2" }) }),
    runObjective: async (args) => { ran = args; return { status: "complete" }; },
  });

  assert.equal(result.objectiveId, "obj-test01");
  assert.equal(result.status, "running");
  assert.equal(result.nodeCount, 2);

  // The pipeline is detached, so give the microtask queue a turn before
  // asserting it was actually handed the objective.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(ran, "the objective must actually be handed to the orchestrator");
  assert.ok(existsSync(ran.objectivePath), "and the state file it names must exist");
  assert.equal(JSON.parse(readFileSync(ran.objectivePath, "utf8")).objectiveId, "obj-test01");
});

test("a high-risk node without the approval key blocks the objective instead of running it", async () => {
  const { root } = hq();
  const previous = process.env.FACTORY_FOUNDER_PUBLIC_KEY;
  delete process.env.FACTORY_FOUNDER_PUBLIC_KEY;
  try {
    let ran = false;
    const result = await handleObjectiveStart({
      root, hqRoot: root, objective: "Touch production", projectId: "lifemaxing",
      decompose: async () => graphWith({
        n1: node({ contract: { risk: "high" } }),
        n2: node({ id: "n2", dependsOn: ["n1"] }),
      }),
      runObjective: async () => { ran = true; return {}; },
    });

    assert.equal(result.blocked, true);
    assert.equal(result.status, "blocked");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ran, false, "nothing may run before the founder key exists");

    // And the block must be legible: the dependent node is held too, and the
    // founder job carries the remediation rather than a bare status.
    const job = listFounderJobs(root).find((j) => j.objectiveId === "obj-test01");
    assert.equal(job.status, "blocked");
    assert.match(job.note, /FACTORY_FOUNDER_PUBLIC_KEY/);
  } finally {
    if (previous !== undefined) process.env.FACTORY_FOUNDER_PUBLIC_KEY = previous;
  }
});

test("a decomposition failure is recorded on the job, not just thrown", async () => {
  const { root } = hq();
  await assert.rejects(
    handleObjectiveStart({
      root, hqRoot: root, objective: "Ship the thing", projectId: "lifemaxing",
      decompose: async () => { throw new Error("planner unavailable"); },
      runObjective: async () => ({}),
    }),
    /planner unavailable/,
  );

  // This is the failure with no objective state file behind it, so the job
  // record is the only trace the founder would ever see.
  const job = listFounderJobs(root).at(-1);
  assert.equal(job.status, "error");
  assert.match(job.error, /planner unavailable/);
});

test("a pipeline failure hours later still lands on the job record", async () => {
  const { root } = hq();
  const result = await handleObjectiveStart({
    root, hqRoot: root, objective: "Ship the thing", projectId: "lifemaxing",
    decompose: async () => graphWith({ n1: node() }),
    runObjective: async () => { throw new Error("the pipeline stopped"); },
  });
  assert.equal(result.status, "running");

  await new Promise((r) => setTimeout(r, 10));
  const job = listFounderJobs(root).find((j) => j.objectiveId === "obj-test01");
  assert.equal(job.status, "error", "a detached failure must not be a silent one");
  assert.match(job.error, /the pipeline stopped/);
});

test("a paused project, an unknown project, and an empty objective are refused before planning", async () => {
  const paused = hq({ paused: true });
  let planned = false;
  const decompose = async () => { planned = true; return graphWith({ n1: node() }); };

  await assert.rejects(
    handleObjectiveStart({ root: paused.root, hqRoot: paused.root, objective: "x", projectId: "lifemaxing", decompose, runObjective: async () => ({}) }),
    /Resume this project/,
  );

  const { root } = hq();
  await assert.rejects(
    handleObjectiveStart({ root, hqRoot: root, objective: "x", projectId: "no-such-project", decompose, runObjective: async () => ({}) }),
    /No repository is registered/,
  );
  await assert.rejects(
    handleObjectiveStart({ root, hqRoot: root, objective: "   ", projectId: "lifemaxing", decompose, runObjective: async () => ({}) }),
    /An objective is required/,
  );

  assert.equal(planned, false, "a refused start must not reach the planner");
});

// On 2026-09-15 one objective was submitted six times while intake was still
// thinking. Six copies ran in parallel, exhausted every provider seat, and all
// blocked. A second start of work that is still in flight must be refused.
test("a second start of the same in-flight request is refused, and nothing is planned", async () => {
  const { root } = hq();
  let planned = 0;
  const start = (objective) => handleObjectiveStart({
    root, hqRoot: root, objective, projectId: "lifemaxing",
    decompose: async () => { planned += 1; return graphWith({ n1: node() }); },
    runObjective: () => new Promise(() => {}), // still running
  });

  await start("Ship the thing");
  await assert.rejects(start("  ship   the THING "), (err) => {
    assert.equal(err.statusCode, 409);
    assert.equal(err.duplicateOf.objectiveId, "obj-test01");
    return true;
  });
  assert.equal(planned, 1, "the duplicate must not reach the planner");
  assert.equal(listFounderJobs(root).length, 1, "and must not leave a job record behind");

  // A different request, or an explicit override, still starts.
  await start("Ship another thing");
  await handleObjectiveStart({
    root, hqRoot: root, objective: "Ship the thing", projectId: "lifemaxing", allowDuplicate: true,
    decompose: async () => graphWith({ n1: node() }), runObjective: () => new Promise(() => {}),
  });
  assert.equal(planned, 2);
});

test("finished, blocked, and stale jobs do not count as duplicates", () => {
  const { root } = hq();
  const now = Date.now();
  const job = (id, status, ageMs) => saveFounderJob(root, {
    id, kind: "objective", projectId: "lifemaxing", objective: "Ship the thing", status,
    createdAt: new Date(now - ageMs).toISOString(),
  });
  job("done", "complete", 1000);
  job("blocked", "blocked", 1000);
  job("stale", "running", DUPLICATE_JOB_WINDOW_MS + 1000); // a restart left it at running
  assert.equal(findInFlightDuplicateJob(root, { projectId: "lifemaxing", objective: "Ship the thing", now }), null);

  job("live", "decomposing", 1000);
  assert.equal(findInFlightDuplicateJob(root, { projectId: "lifemaxing", objective: "Ship the thing", now })?.id, "live");
  assert.equal(findInFlightDuplicateJob(root, { projectId: "other", objective: "Ship the thing", now }), null);
});
