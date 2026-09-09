import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredAgentIds, selectAgentId } from "../lib/openclaw-runner.mjs";

test("runner resolves logical builder actors through the factory runtime route", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-routing-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({
    openclawIntegration: { agentIds: { "builder:codex": "backend-builder" } },
  }));
  const routes = configuredAgentIds(root);
  assert.equal(selectAgentId({ stage: "builder", actor: "codex" }, routes, { strict: true }), "backend-builder");
});

test("runner refuses to dispatch an unconfigured logical actor instead of invoking it literally", () => {
  assert.throws(
    () => selectAgentId({ stage: "builder", actor: "codex" }, { "builder:frontend": "frontend-builder" }, { strict: true }),
    /no runtime agent is configured.*codex/,
  );
});

test("recovery verification does not use the failed builder route", () => {
  const routes = { recovery: "architect", "recovery-verify": "backend-builder", "builder:claude": "architect", "qa:claude": "qa" };
  assert.equal(selectAgentId({ kind: "recovery-diagnose", stage: "builder", actor: "recovery" }, routes), "architect");
  assert.equal(selectAgentId({ kind: "recovery-verify", stage: "builder", actor: "claude", verificationStage: "qa" }, routes), "backend-builder");
  assert.throws(() => selectAgentId({ kind: "recovery-verify", stage: "builder", actor: "claude" }, { ...routes, "recovery-verify": "architect" }), /different runtime agents/);
});
