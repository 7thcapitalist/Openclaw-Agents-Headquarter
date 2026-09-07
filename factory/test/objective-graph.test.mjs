import test from "node:test";
import assert from "node:assert/strict";
import { assertAcyclic, readyNodes, descendants, buildNodesComplete, isDeadlocked } from "../lib/objective/graph.mjs";

const mk = (spec) => ({ nodes: Object.fromEntries(Object.entries(spec).map(([id, s]) => [id, { id, dependsOn: s.dependsOn || [], status: s.status || "pending" }])) });

test("assertAcyclic rejects cycles and dangling deps, accepts a DAG", () => {
  assert.doesNotThrow(() => assertAcyclic(mk({ a: {}, b: { dependsOn: ["a"] }, c: { dependsOn: ["a", "b"] } }).nodes));
  assert.throws(() => assertAcyclic(mk({ a: { dependsOn: ["b"] }, b: { dependsOn: ["a"] } }).nodes), /cycle/);
  assert.throws(() => assertAcyclic(mk({ a: { dependsOn: ["ghost"] } }).nodes), /unknown node/);
  assert.throws(() => assertAcyclic(mk({ a: { dependsOn: ["a"] } }).nodes), /itself/);
});

test("readyNodes: only pending nodes whose deps all reached the gate", () => {
  const s = mk({ a: { status: "gate-satisfied" }, b: {}, c: { dependsOn: ["a"] }, d: { dependsOn: ["b"] } });
  assert.deepEqual(readyNodes(s).sort(), ["b", "c"]);
  s.nodes.b.status = "gate-satisfied";
  assert.deepEqual(readyNodes(s).sort(), ["c", "d"]);
});

test("descendants walks transitive dependents", () => {
  const s = mk({ a: {}, b: { dependsOn: ["a"] }, c: { dependsOn: ["b"] }, x: {} });
  assert.deepEqual(descendants(s, "a").sort(), ["b", "c"]);
  assert.deepEqual(descendants(s, "x"), []);
});

test("buildNodesComplete only when every node reached the gate", () => {
  const s = mk({ a: { status: "gate-satisfied" }, b: { status: "gate-satisfied" } });
  assert.equal(buildNodesComplete(s), true);
  s.nodes.b.status = "running";
  assert.equal(buildNodesComplete(s), false);
});

test("isDeadlocked when a blocked node stalls everything and nothing runs", () => {
  const s = mk({ a: { status: "failed" }, b: { dependsOn: ["a"], status: "blocked-by-dep" } });
  assert.equal(isDeadlocked(s), true);
  const ok = mk({ a: { status: "running" }, b: { dependsOn: ["a"], status: "blocked-by-dep" } });
  assert.equal(isDeadlocked(ok), false);
});
