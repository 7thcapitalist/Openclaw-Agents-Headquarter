import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredAgentIds, selectAgentId } from "../lib/openclaw-runner.mjs";

// The shape factory.config.json actually ships: some stages routed by
// stage+harness ("qa:claude"), others by a bare stage name ("reviewer").
const CONFIG = {
  openclawIntegration: {
    agentIds: {
      product: "product",
      architect: "architect",
      "builder:codex": "backend-builder",
      "builder:frontend": "frontend-builder",
      reviewer: "reviewer",
      "qa:claude": "qa",
      security: "security",
      release: "release",
      openclaw: "main",
      recovery: "architect",
      "recovery-verify": "backend-builder",
    },
  },
};

function hqRoot() {
  const root = mkdtempSync(join(tmpdir(), "stage-routes-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify(CONFIG));
  return root;
}

// Bare stage keys were filtered out on the theory that the orchestrator always
// passes an explicit agentIds map. The approval-triggered run path does not, so
// selectAgentId fell through to the LOGICAL ACTOR as the agent id — and the CLI
// rejected `claude`, which is a harness name, not a runtime agent.
test("a stage routed by a bare name is importable without an explicit map", () => {
  const routes = configuredAgentIds(hqRoot());
  assert.equal(routes.reviewer, "reviewer");
  assert.equal(routes.security, "security");
  assert.equal(routes.release, "release");
  assert.equal(routes["qa:claude"], "qa");
});

test("a bare logical actor is still not imported", () => {
  // `openclaw` is a default a direct caller may intentionally override; that is
  // what the original filter was protecting, and it still holds.
  assert.equal(configuredAgentIds(hqRoot()).openclaw, undefined);
});

// The live failure, end to end: reviewer and security resolved to the harness
// name and the CLI answered `Unknown agent id "claude"` three times each.
test("reviewer and security resolve to runtime agents, not to the harness name", () => {
  const routes = configuredAgentIds(hqRoot());
  for (const stage of ["reviewer", "security", "release"]) {
    const resolved = selectAgentId({ stage, actor: "claude", kind: "stage" }, routes);
    assert.equal(resolved, stage, `${stage} resolved to ${resolved}`);
    assert.notEqual(resolved, "claude");
  }
  // The stage+harness route still wins where one exists.
  assert.equal(selectAgentId({ stage: "qa", actor: "claude", kind: "stage" }, routes), "qa");
  assert.equal(selectAgentId({ stage: "builder", actor: "codex", kind: "stage" }, routes), "backend-builder");
});

test("an explicit map still overrides the imported routes", () => {
  const routes = configuredAgentIds(hqRoot(), { reviewer: "some-other-agent" });
  assert.equal(routes.reviewer, "some-other-agent");
});

// The guarantee the original filter existed for. A caller that deliberately
// routes by logical actor must not have an implicitly imported stage route
// shadow it — selectAgentId checks the bare stage before the actor, so
// importing one unconditionally would silently take the decision away.
test("a caller routing by logical actor is not shadowed by an imported stage route", () => {
  const routes = configuredAgentIds(hqRoot(), { openclaw: "main-agent" });
  assert.equal(routes.product, undefined);
  assert.equal(selectAgentId({ stage: "product", actor: "openclaw", kind: "stage" }, routes), "main-agent");
  // Stage+harness routes are still imported, because they cannot shadow an
  // actor route for a different stage.
  assert.equal(routes["qa:claude"], "qa");
});

test("a missing config is still tolerated", () => {
  const empty = mkdtempSync(join(tmpdir(), "stage-routes-empty-"));
  assert.deepEqual(configuredAgentIds(empty), {});
});
