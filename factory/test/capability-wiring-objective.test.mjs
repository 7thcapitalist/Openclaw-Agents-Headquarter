// Objective-level capability wiring.
//
// Same contract as the task-level wiring: in `report` mode — which is what
// ships — every decision is computed and audited and the work happens anyway,
// and a factory with no registry is untouched. What differs here is the actor
// and the scope. An objective is scheduled by the orchestrator on the founder's
// instruction, with no agent yet acting, so the actor is the factory itself and
// the scope is the project rather than a task.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { permissionAuditPath } from "../lib/hq/capability-check.mjs";
import { resumeObjectiveNodes, runObjective } from "../lib/objective/orchestrator.mjs";

function hq({ mode = null, grants = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cap-obj-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  if (mode) {
    writeFileSync(join(root, "factory", "permissions.json"), JSON.stringify({ version: 1, mode, grants }, null, 2));
  }
  return root;
}

// An objective whose only node is blocked on a founder decision. Nothing is
// ready to schedule and the build is not complete, so runObjective reaches its
// exit without dispatching or integrating — and these tests observe the
// capability check rather than the scheduler.
function objective(root, { project = "demo" } = {}) {
  const dir = join(root, "state", "objectives", "obj-caps");
  mkdirSync(dir, { recursive: true });
  const objectivePath = join(dir, "objective-state.json");
  writeFileSync(objectivePath, JSON.stringify({
    version: 1,
    objectiveId: "obj-caps",
    objective: "Ship the thing",
    project,
    repo: join(root, "repo"),
    status: "running",
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    nodes: {
      "obj-caps-a": {
        id: "obj-caps-a",
        status: "blocked",
        dependsOn: [],
        statePath: null,
        blocker: { stage: "product", outcome: "decision-required", summary: "waiting on the founder" },
      },
    },
    integration: { id: "obj-caps-integration", dependsOn: ["obj-caps-a"], status: "pending", statePath: null },
    events: [],
  }, null, 2));
  return objectivePath;
}

const auditLines = (root) => {
  const path = permissionAuditPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

const wouldDeny = (entry) => String(entry.data.wouldDeny) === "true";
const grant = (actorId, capability) => ({ actorId, capability, scopeType: "company", scopeId: "*" });

// ── objective.run ───────────────────────────────────────────────────────────

test("with no registry, running an objective audits nothing", async () => {
  const root = hq();
  await runObjective({ hqRoot: root, objectivePath: objective(root) });
  assert.deepEqual(auditLines(root), []);
});

test("report mode records the objective.run decision and runs it anyway", async () => {
  const root = hq({ mode: "report", grants: [] });
  const objectivePath = objective(root);

  await runObjective({ hqRoot: root, objectivePath });

  const entry = auditLines(root).find((e) => e.data.capability === "objective.run");
  assert.ok(entry, "the decision was recorded");
  assert.equal(entry.data.enforcement, "report");
  assert.equal(entry.subject.type, "project", "an objective is scoped to its project, not to a task");
  assert.equal(entry.correlation.objectiveId, "obj-caps");
});

test("enforce mode refuses to run an objective the actor is not granted", async () => {
  const root = hq({ mode: "enforce", grants: [grant("someone-else", "objective.run")] });
  const objectivePath = objective(root);

  await assert.rejects(
    () => runObjective({ hqRoot: root, objectivePath }),
    /not permitted to objective\.run/,
  );
});

test("enforce mode allows a granted actor to run an objective", async () => {
  const root = hq({ mode: "enforce", grants: [grant("openclaw-factory", "objective.run")] });
  await runObjective({ hqRoot: root, objectivePath: objective(root) });
});

// ── objective.recover ───────────────────────────────────────────────────────

test("report mode records the objective.recover decision and resumes anyway", () => {
  const root = hq({ mode: "report", grants: [] });
  const objectivePath = objective(root);

  const out = resumeObjectiveNodes({ hqRoot: root, objectivePath, nodeIds: ["obj-caps-a"] });

  assert.ok(out, "report mode never stops a recovery");
  const entry = auditLines(root).find((e) => e.data.capability === "objective.recover");
  assert.ok(entry, "the decision was recorded");
  assert.equal(wouldDeny(entry), true, "no grant covers the orchestrator's own actor id");
});

test("enforce mode refuses an ungranted recovery before any node is touched", () => {
  const root = hq({ mode: "enforce", grants: [grant("someone-else", "objective.recover")] });
  const objectivePath = objective(root);
  const before = readFileSync(objectivePath, "utf8");

  assert.throws(
    () => resumeObjectiveNodes({ hqRoot: root, objectivePath, nodeIds: ["obj-caps-a"] }),
    /not permitted to objective\.recover/,
  );
  assert.equal(readFileSync(objectivePath, "utf8"), before, "a refused recovery changes nothing");
});

test("recovery is decided once per call, not once per node", () => {
  const root = hq({ mode: "report", grants: [] });
  const objectivePath = objective(root);

  resumeObjectiveNodes({ hqRoot: root, objectivePath, nodeIds: ["obj-caps-a", "obj-caps-b", "obj-caps-c"] });

  const entries = auditLines(root).filter((e) => e.data.capability === "objective.recover");
  assert.equal(entries.length, 1, "the founder asked to recover an objective, not each node separately");
});

// ── the pre-permissions call shape still works ──────────────────────────────

test("a caller that passes no hqRoot is not denied", () => {
  const root = hq({ mode: "enforce", grants: [] });
  const objectivePath = objective(root);

  // resumeObjectiveNodes had no hqRoot parameter before this change, and every
  // existing caller and test still calls it that way. Adding a check must not
  // turn those into failures.
  const out = resumeObjectiveNodes({ objectivePath, nodeIds: ["obj-caps-a"] });
  assert.ok(out);
  assert.deepEqual(auditLines(root), []);
});
