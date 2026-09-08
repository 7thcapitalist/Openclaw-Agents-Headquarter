import test from "node:test";
import assert from "node:assert/strict";
import { decomposeObjective, buildObjectiveStateFromNodes } from "../lib/objective/decompose.mjs";

const REPO = process.cwd();
const validNodes = [
  { id: "auth-api", role: "backend-builder", objective: "Add the auth API", acceptanceCriteria: ["POST /login returns a token", "tests pass"], workType: "backend", risk: "low", dependsOn: [] },
  { id: "onboarding-ui", role: "frontend-builder", objective: "Add the onboarding screens", acceptanceCriteria: ["screens render", "tests pass"], workType: "ui", risk: "low", dependsOn: [] },
  { id: "wire-ui-to-api", role: "frontend-builder", objective: "Wire the UI to the auth API", acceptanceCriteria: ["login works end to end", "tests pass"], workType: "ui", risk: "low", dependsOn: ["auth-api", "onboarding-ui"] },
];

test("decomposeObjective builds a validated task graph from a model response", async () => {
  const execute = async () => JSON.stringify({ nodes: validNodes });
  const g = await decomposeObjective({ hqRoot: REPO, objective: "Build onboarding", project: "demo", repo: REPO, execute });
  assert.match(g.objectiveId, /^obj-[0-9a-f]{8}$/);
  assert.equal(Object.keys(g.nodes).length, 3);
  const wire = Object.values(g.nodes).find((n) => n.id.endsWith("-wire-ui-to-api"));
  assert.deepEqual(wire.dependsOn.map((d) => d.replace(`${g.objectiveId}-`, "")).sort(), ["auth-api", "onboarding-ui"]);
  // each node carries a real, validated task contract
  for (const n of Object.values(g.nodes)) {
    assert.equal(n.contract.project, "demo");
    assert.ok(Array.isArray(n.contract.acceptanceCriteria) && n.contract.acceptanceCriteria.length);
    assert.equal(n.contract.id, n.id);
    assert.equal(n.branch, `factory/${n.id}`);
    assert.equal(n.githubPublish, null);
    assert.equal(n.prUrl, null);
  }
  // integration node depends on every build node
  assert.deepEqual(g.integration.dependsOn.sort(), Object.keys(g.nodes).sort());
  assert.equal(g.integration.branch, `factory/integration-${g.objectiveId}`);
});

test("decomposeObjective rejects a bad graph", async () => {
  const bad = (nodes) => decomposeObjective({ hqRoot: REPO, objective: "x", project: "demo", repo: REPO, execute: async () => JSON.stringify({ nodes }) });
  await assert.rejects(bad([]), /non-empty/);
  await assert.rejects(bad([{ id: "a", role: "reviewer", objective: "x", acceptanceCriteria: ["y"], workType: "backend", risk: "low" }]), /not supported/);
  await assert.rejects(bad([{ id: "Bad Id", role: "backend-builder", objective: "x", acceptanceCriteria: ["y"], workType: "backend", risk: "low" }]), /slug/);
  await assert.rejects(bad([{ id: "a", role: "backend-builder", objective: "x", acceptanceCriteria: ["y"], workType: "backend", risk: "nope" }]), /risk/);
  await assert.rejects(bad([
    { id: "a", role: "backend-builder", objective: "x", acceptanceCriteria: ["y"], workType: "backend", risk: "low", dependsOn: ["b"] },
    { id: "b", role: "backend-builder", objective: "x", acceptanceCriteria: ["y"], workType: "backend", risk: "low", dependsOn: ["a"] },
  ]), /cycle/);
  await assert.rejects(bad([{ id: "a", role: "backend-builder", objective: "x", acceptanceCriteria: ["y"], workType: "backend", risk: "low", dependsOn: ["ghost"] }]), /unknown node/);
  await assert.rejects(bad([{ id: "a", role: "backend-builder", objective: "", acceptanceCriteria: ["y"], workType: "backend", risk: "low" }]), /outcome/);
});

test("buildObjectiveStateFromNodes lets tests skip the model call", () => {
  const g = buildObjectiveStateFromNodes({ objective: "x", project: "demo", repo: REPO, nodes: validNodes.slice(0, 2) });
  assert.equal(Object.keys(g.nodes).length, 2);
  assert.equal(g.status, "active");
});
