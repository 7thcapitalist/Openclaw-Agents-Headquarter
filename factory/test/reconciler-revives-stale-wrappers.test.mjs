// The sweep must see a node whose wrapper drifted out of sync with its task.
//
// objective-reconciler's own header leans on runObjective being "idempotent and
// self-healing for a node that is `blocked` or `failed`: it puts those back to
// `pending` when their task state went active". That is true — when runObjective
// is called. The sweep never called it for such an objective: readyNodes skips a
// blocked node and the abandoned filter matches only `running`, so the objective
// read as healthy and the healer was never invoked.
//
// obj-47cf7355 sat in that gap on 2026-09-15: builder passed, handed off to the
// reviewer, the dashboard restarted, and the task stayed `active` with no
// dispatch while its node was still recorded `blocked` from an earlier recovery.

import assert from "node:assert/strict";
import test from "node:test";

import { strandedNodes } from "../lib/hq/objective-reconciler.mjs";

// The shape obj-47cf7355 was in: node blocked, its task still active.
function objective({ nodeStatus = "blocked", taskStatus = "active", objectiveStatus = "blocked" } = {}) {
  return {
    objectiveId: "obj-aa11bb22",
    status: objectiveStatus,
    nodes: {
      "obj-aa11bb22-part-one": {
        id: "obj-aa11bb22-part-one", status: nodeStatus, dependsOn: [],
        statePath: "/nowhere/state.json", __taskStatus: taskStatus,
      },
    },
    integration: { id: "obj-aa11bb22-integration", role: "integration", status: "pending", dependsOn: ["obj-aa11bb22-part-one"] },
  };
}
const taskStatusOf = (node) => node.__taskStatus ?? null;
const verdict = (o) => strandedNodes(o, { taskStatusOf });

test("a blocked node whose task is active is stranded work, not a healthy objective", () => {
  const v = verdict(objective());
  assert.equal(v.stranded, true, "this is the objective the sweep used to walk past");
  assert.deepEqual(v.revivable, ["obj-aa11bb22-part-one"]);
  assert.deepEqual(v.ready, [], "readyNodes still cannot see a blocked node");
  assert.deepEqual(v.abandoned, [], "and it is not abandoned — that means status running");
  assert.ok(v.nodeIds.includes("obj-aa11bb22-part-one"));
});

test("a failed node whose task went active counts too", () => {
  assert.deepEqual(verdict(objective({ nodeStatus: "failed" })).revivable, ["obj-aa11bb22-part-one"]);
});

test("a genuinely blocked node — task not active — is still left alone", () => {
  // The founder has to answer this one. Reviving it would relabel a real
  // blocker as running work that nobody is doing.
  const v = verdict(objective({ taskStatus: "blocked" }));
  assert.equal(v.stranded, false);
  assert.deepEqual(v.revivable, []);
});

test("a node with no task state at all is not revivable", () => {
  const v = verdict(objective({ taskStatus: null }));
  assert.equal(v.stranded, false);
});

test("a finished objective is never revived, whatever its nodes say", () => {
  for (const status of ["cancelled", "complete", "completed", "superseded"]) {
    const v = verdict(objective({ objectiveStatus: status }));
    assert.equal(v.stranded, false, `${status} must stay finished`);
    assert.match(v.reason, new RegExp(status));
  }
});

test("the not-stranded verdict still carries every field its callers read", () => {
  const v = verdict(objective({ taskStatus: "blocked" }));
  for (const key of ["nodeIds", "ready", "abandoned", "revivable"]) {
    assert.ok(Array.isArray(v[key]), `${key} must be an array even when nothing is stranded`);
  }
});
