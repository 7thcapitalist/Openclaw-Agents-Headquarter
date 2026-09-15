// A cancelled objective must not come back.
//
// buildObjectivesView refines an objective's status from node evidence: a live
// task means the objective is live. That is right for an objective whose wrapper
// is merely stale, and wrong for one the founder ended. Cancelling deliberately
// leaves node and task statuses untouched — that is the record of what each part
// actually reached — so a cancelled objective normally still HAS an `active`
// task hanging off it. Without a guard, that task rewrote the objective back to
// `active` and the card reappeared on Today as "Running", which is exactly the
// failure the cancel control exists to end.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildObjectivesView } from "../../dashboard/backend/lib/founderControlPlane.mjs";
import { createState, writeState } from "../lib/task-workflow.mjs";

// One objective with one node, whose task is still `active` — the shape every
// cancelled objective has, because cancelling does not stop its parts.
function fixture(objectiveStatus) {
  const root = mkdtempSync(join(tmpdir(), "cancel-sticks-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  const objectiveDir = join(root, "dashboard/backend/data/factory/app/objectives/obj-aa11bb22");
  const taskDir = join(root, "dashboard/backend/data/factory/app/tasks/obj-aa11bb22-part-one");
  mkdirSync(objectiveDir, { recursive: true });
  mkdirSync(join(taskDir, "worktree"), { recursive: true });

  const task = createState({
    task: { id: "obj-aa11bb22-part-one", issue: "local:one", outcome: "Build part one", acceptanceCriteria: ["it works"], project: "app", workType: "backend", risk: "low" },
    repo: join(root, "repo"), branch: "factory/obj-aa11bb22-part-one", worktree: join(taskDir, "worktree"),
    now: "2026-09-15T18:00:00.000Z",
  });
  assert.equal(task.status, "active", "the fixture depends on the task still being active");
  const statePath = join(taskDir, "state.json");
  writeState(statePath, task);

  writeFileSync(join(objectiveDir, "objective-state.json"), JSON.stringify({
    objectiveId: "obj-aa11bb22", objective: "Try something out", project: "app", repo: join(root, "repo"),
    status: objectiveStatus,
    cancelledAt: objectiveStatus === "cancelled" ? "2026-09-15T21:11:11.000Z" : undefined,
    createdAt: "2026-09-15T18:00:00.000Z", updatedAt: "2026-09-15T21:11:11.000Z",
    nodes: { "obj-aa11bb22-part-one": { id: "obj-aa11bb22-part-one", role: "backend-builder", status: "blocked", statePath } },
    integration: { id: "obj-aa11bb22-integration", role: "integration", status: "pending" },
    events: [],
  }, null, 2));
  return root;
}

const shaped = (root) => buildObjectivesView(root).objectives.find((o) => o.objectiveId === "obj-aa11bb22");

test("a live task cannot resurrect a cancelled objective", () => {
  const view = shaped(fixture("cancelled"));
  assert.equal(view.status, "cancelled", "node evidence must not overwrite the founder's terminal status");
  assert.equal(view.status6, "CANCELLED");
  assert.equal(view.statusLabel, "Cancelled");
  assert.equal(view.lifecycle, "history", "and it must not sit on Today as live work");
});

test("a live task cannot resurrect a completed objective either", () => {
  const view = shaped(fixture("complete"));
  assert.equal(view.status, "complete");
  assert.equal(view.status6, "COMPLETE");
});

test("a live task still refines a non-terminal objective, which is why the rule exists", () => {
  // The wrapper says blocked while its task runs — the stale-wrapper case. Here
  // the node evidence SHOULD win, or genuinely live work reads as stuck.
  const view = shaped(fixture("blocked"));
  assert.equal(view.status, "active", "a stale wrapper is still corrected by its live task");
});
