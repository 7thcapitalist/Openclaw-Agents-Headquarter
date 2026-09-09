import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { planModelPolicy } from "../../scripts/apply-model-policy.mjs";
import {
  buildDecomposeInvocation,
  buildObjectiveStateFromNodes,
  decomposeObjective,
} from "../lib/objective/decompose.mjs";
import {
  buildIntakeInvocation,
  createContractFromObjective,
} from "../lib/natural-language-intake.mjs";
import { defaultAssignments, validateIndependence } from "../lib/task-workflow.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function modelPolicyFixture() {
  return {
    agents: {
      defaults: { model: { primary: "old/model" }, models: {} },
      entries: Object.fromEntries(
        ["main", "backend-builder", "frontend-builder", "architect", "reviewer", "security", "research", "learning", "qa", "product", "release"]
          .map((id) => [id, {}]),
      ),
    },
  };
}

test("model policy is idempotent and moves product primary off OpenAI", () => {
  const first = planModelPolicy(modelPolicyFixture());
  assert.ok(first.changes.length > 0);
  assert.deepEqual(first.nextConfig.agents.defaults.model, {
    primary: "openai/gpt-5.6-sol",
    fallbacks: ["openai/gpt-5.6-luna", "anthropic/claude-sonnet-5", "openai/gpt-5.4-mini", "github-copilot/gpt-4.1"],
  });
  assert.deepEqual(first.nextConfig.agents.entries.product.model, {
    primary: "github-copilot/gpt-4.1",
    fallbacks: ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "anthropic/claude-sonnet-5", "openai/gpt-5.4-mini"],
  });
  assert.deepEqual(first.nextConfig.agents.entries.architect.model, {
    primary: "anthropic/claude-sonnet-5",
    fallbacks: ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "github-copilot/gpt-4.1", "openai/gpt-5.4-mini"],
  });
  for (const id of ["main", "backend-builder", "frontend-builder"]) {
    assert.deepEqual(first.nextConfig.agents.entries[id].model, {
      primary: "openai/gpt-5.6-sol",
      fallbacks: ["openai/gpt-5.6-luna", "anthropic/claude-sonnet-5", "openai/gpt-5.4-mini", "github-copilot/gpt-4.1"],
    });
  }

  const second = planModelPolicy(first.nextConfig);
  assert.equal(second.changes.length, 0);
  assert.deepEqual(second.nextConfig, first.nextConfig);
});

test("configured decomposition and intake agents reach their invocations", async () => {
  let decomposeAgent;
  await decomposeObjective({
    hqRoot: ROOT,
    objective: "Build one API",
    project: "demo",
    repo: ROOT,
    decomposeAgentId: "architect",
    execute: async ({ agentId }) => {
      decomposeAgent = agentId;
      return JSON.stringify({ nodes: [{
        id: "api",
        role: "backend-builder",
        objective: "Build one API",
        acceptanceCriteria: ["API test passes"],
        workType: "backend",
        risk: "low",
        dependsOn: [],
      }] });
    },
  });
  assert.equal(decomposeAgent, "architect");

  let intakeAgent;
  await createContractFromObjective({
    objective: "Build one API",
    project: "demo",
    repo: ROOT,
    stateRoot: mkdtempSync(join(tmpdir(), "factory-intake-route-")),
    hqRoot: ROOT,
    intakeAgentId: "architect",
    execute: async ({ id, agentId }) => {
      intakeAgent = agentId;
      return JSON.stringify({
        id,
        issue: `local:${id}`,
        outcome: "Build one API",
        acceptanceCriteria: ["API test passes"],
        project: "demo",
        workType: "backend",
        risk: "low",
        preferredBuilder: "codex",
        constraints: [],
      });
    },
  });
  assert.equal(intakeAgent, "architect");

  const decompose = buildDecomposeInvocation({ agentId: "architect", objectiveId: "obj-test", prompt: "prompt" });
  assert.deepEqual(decompose.args.slice(0, 6), ["agent", "--agent", "architect", "--session-key", "agent:architect:factory-decompose-obj-test", "--message"]);
  const intake = buildIntakeInvocation({ agentId: "architect", id: "task-test", prompt: "prompt" });
  assert.match(intake.sessionKey, /^agent:architect:factory-intake-/);
});

test("frontend tasks use the dedicated Codex-backed route with independent review and QA", () => {
  const state = buildObjectiveStateFromNodes({
    objective: "Build a responsive screen",
    project: "demo",
    repo: ROOT,
    objectiveId: "obj-route",
    nodes: [{
      id: "screen",
      role: "frontend-builder",
      objective: "Build a responsive screen",
      acceptanceCriteria: ["Responsive UI test passes"],
      workType: "ui",
      risk: "low",
      dependsOn: [],
    }],
  });
  const node = state.nodes["obj-route-screen"];
  assert.equal(node.harness, "frontend");
  assert.equal(node.contract.preferredBuilder, "frontend");
  const assignments = defaultAssignments(node.contract);
  assert.equal(assignments.builder, "frontend");
  assert.equal(assignments.reviewer, "claude");
  assert.equal(assignments.qa, "claude");
  assert.doesNotThrow(() => validateIndependence(assignments));

  const config = JSON.parse(readFileSync(join(ROOT, "factory", "factory.config.json"), "utf8"));
  assert.equal(config.openclawIntegration.agentIds.decompose, "architect");
  assert.equal(config.openclawIntegration.agentIds.intake, "architect");
  assert.equal(config.openclawIntegration.agentIds["builder:frontend"], "frontend-builder");
  assert.equal(Object.values(config.openclawIntegration.agentIds).includes("cursor"), false);
});

test("optional routing config defaults safely and missing policy entries are skipped", () => {
  const decompose = buildDecomposeInvocation({ objectiveId: "obj-safe", prompt: "prompt" });
  const intake = buildIntakeInvocation({ id: "task-safe", prompt: "prompt" });
  assert.equal(decompose.args[2], "main");
  assert.equal(intake.args[2], "main");

  const fixture = modelPolicyFixture();
  delete fixture.agents.entries.architect;
  delete fixture.agents.entries.product;
  const plan = planModelPolicy(fixture);
  assert.ok(plan.warnings.some((warning) => warning.startsWith("architect:")));
  assert.ok(plan.warnings.some((warning) => warning.startsWith("product:")));
});

test("an already-selected default still gets newly required fallback models registered", () => {
  const fixture = modelPolicyFixture();
  fixture.agents.defaults.model = {
    primary: "openai/gpt-5.6-sol",
    fallbacks: ["anthropic/claude-sonnet-5", "openai/gpt-5.4-mini", "github-copilot/gpt-4.1"],
  };
  fixture.agents.defaults.models = {};
  const plan = planModelPolicy(fixture);
  assert.deepEqual(Object.keys(plan.nextConfig.agents.defaults.models).sort(), [
    "anthropic/claude-sonnet-5",
    "github-copilot/gpt-4.1",
    "openai/gpt-5.4-mini",
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-sol",
  ]);
  assert.ok(plan.changes.some((change) => change.includes("registered anthropic/claude-sonnet-5")));
});
