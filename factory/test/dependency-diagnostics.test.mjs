import test from "node:test"; import assert from "node:assert/strict";
import { diagnoseDependencyGraph, dependencyWakeups } from "../lib/objective/dependency-diagnostics.mjs";
const node = (id, status, dependsOn = [], extra = {}) => ({ id, status, dependsOn, ...extra });
test("emits one idempotent wakeup when dependencies clear", () => { const before = { nodes: { a: node("a", "running"), b: node("b", "pending", ["a"]) } }; const after = { nodes: { a: node("a", "gate-satisfied"), b: node("b", "pending", ["a"]) } }; const rows = dependencyWakeups({ before, after, objectiveId: "obj-1", actorForNode: () => "builder" }); assert.equal(rows.length, 1); assert.equal(rows[0].taskRef, "b"); // The key identifies the objective and node and is bounded; the dependency
// state it encodes is hashed, so a fan-in node cannot overrun the queue's
// 200-char limit (see the fan-in test below).
assert.match(rows[0].idempotencyKey, /^dependency:obj-1:b:/);
assert.ok(rows[0].idempotencyKey.length <= 200); assert.deepEqual(dependencyWakeups({ before: after, after, objectiveId: "obj-1", actorForNode: () => "builder" }), []); });
test("surfaces blocked descendants and stale running work", () => { const result = diagnoseDependencyGraph({ updatedAt: "2026-09-09T09:00:00Z", nodes: { a: node("a", "failed"), b: node("b", "pending", ["a"]), c: node("c", "running", [], { updatedAt: "2026-09-09T09:00:00Z" }) } }, { now: () => Date.parse("2026-09-09T10:00:00Z") }); assert.equal(result.healthy, false); assert.ok(result.findings.some((f) => f.code === "blocked-subtree")); assert.ok(result.findings.some((f) => f.code === "stale-running")); });
test("invalid graphs fail closed", () => { const result = diagnoseDependencyGraph({ nodes: { a: node("a", "pending", ["missing"]) } }); assert.equal(result.findings[0].code, "invalid-graph"); assert.equal(result.counts.critical, 1); });

// ── the wakeup key is a durability contract ──────────────────────────────────
// wakeups/queue.mjs caps idempotencyKey at 200 chars and dedupes against every
// item ever queued. Both bounds bite here, and both did.

test("a fan-in node's wakeup key stays within the queue's bound", async () => {
  // The join node is the whole point of dependency wakeups, and spelling out
  // each dependency's status inline blew the 200-char cap on exactly it —
  // enqueueWakeup threw `idempotencyKey is invalid` instead of waking the node.
  const { enqueueWakeup } = await import("../lib/wakeups/queue.mjs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const deps = Array.from({ length: 8 }, (_, i) => `objective-node-dependency-${i}`);
  const nodes = Object.fromEntries([
    ...deps.map((id) => [id, { id, status: "gate-satisfied", dependsOn: [] }]),
    ["join", { id: "join", status: "pending", dependsOn: deps }],
  ]);
  const before = { nodes: { ...nodes, [deps[0]]: { ...nodes[deps[0]], status: "running" } } };
  const wakeups = dependencyWakeups({
    before, after: { nodes },
    objectiveId: "obj-2026-09-reliability-overhaul-phase-three",
    actorForNode: () => "builder",
  });
  assert.equal(wakeups.length, 1);
  assert.ok(wakeups[0].idempotencyKey.length <= 200, `key is ${wakeups[0].idempotencyKey.length} chars`);
  // The real bound is the queue's, so assert against the queue itself.
  const path = join(mkdtempSync(join(tmpdir(), "dep-wakeup-")), "queue.json");
  assert.doesNotThrow(() => enqueueWakeup(path, wakeups[0]));
});

test("a node becoming ready again produces a new wakeup, not a swallowed duplicate", () => {
  // Encoding only dependency statuses made a retry byte-identical to the first
  // run. The queue dedupes against all history, so the node was silently never
  // woken a second time — a silent failure inside the durable wakeup layer.
  const satisfied = { id: "a", status: "gate-satisfied", dependsOn: [] };
  const before = { nodes: { a: { ...satisfied, status: "running" }, b: { id: "b", status: "pending", dependsOn: ["a"], attempts: 0 } } };
  const first = { nodes: { a: satisfied, b: { id: "b", status: "pending", dependsOn: ["a"], attempts: 0 } } };
  const retry = { nodes: { a: satisfied, b: { id: "b", status: "pending", dependsOn: ["a"], attempts: 1 } } };

  const keyFor = (after) => dependencyWakeups({ before, after, objectiveId: "o", actorForNode: () => "x" })[0].idempotencyKey;
  assert.notEqual(keyFor(first), keyFor(retry), "a second attempt must be wakeable");
  // Same attempt, same dependency state: still one wakeup, not a storm.
  assert.equal(keyFor(first), keyFor(first));
});

test("a blocked subtree names every stranded node, not just the direct dependent", () => {
  // a(failed) -> b -> c. `c` appeared in no finding, and the no-runnable-node
  // fallback was suppressed by this very finding, so it was invisible entirely.
  const objective = { nodes: {
    a: { id: "a", status: "failed", dependsOn: [] },
    b: { id: "b", status: "pending", dependsOn: ["a"] },
    c: { id: "c", status: "pending", dependsOn: ["b"] },
  } };
  const finding = diagnoseDependencyGraph(objective).findings.find((f) => f.code === "blocked-subtree");
  assert.ok(finding, "the stranded subtree is reported");
  assert.deepEqual(finding.strandedNodeIds, ["c"], "the transitively stranded node is named");
});
