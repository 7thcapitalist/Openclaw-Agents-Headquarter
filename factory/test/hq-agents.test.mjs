import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readAgentRegistry,
  validateAgentRegistry,
  listAgents,
  resolveAgent,
} from "../lib/hq/agents.mjs";

function makeHq(registry) {
  const hq = mkdtempSync(join(tmpdir(), "hq-agents-"));
  mkdirSync(join(hq, "factory"), { recursive: true });
  if (registry !== undefined) writeFileSync(join(hq, "factory", "agents.json"), JSON.stringify(registry));
  return hq;
}

const validRegistry = {
  version: 1,
  agents: [
    { id: "claude-main", name: "Claude", kind: "claude", role: "Architecture", capabilities: ["architecture"], harnessAgentIds: ["architect", "reviewer"] },
    { id: "codex-builder", name: "Codex", kind: "codex", role: "Builder", currentProject: "lifemaxing", status: "working" },
  ],
};

test("readAgentRegistry: missing file is an empty registry, not an error", () => {
  const hq = makeHq(undefined);
  assert.deepEqual(readAgentRegistry(hq), { version: 1, agents: [] });
});

test("readAgentRegistry throws on a structurally broken file", () => {
  const hq = makeHq({ version: 1, agents: [{ id: "Bad Id", name: "x", role: "y" }] });
  assert.throws(() => readAgentRegistry(hq), /lowercase slug/);
});

test("validateAgentRegistry rejects bad shapes", () => {
  assert.throws(() => validateAgentRegistry({ version: 2, agents: [] }), /version must be 1/);
  assert.throws(() => validateAgentRegistry({ version: 1, agents: {} }), /must be an array/);
  assert.throws(() => validateAgentRegistry({ version: 1, agents: [{ id: "a", name: "A", role: "R", kind: "wizard" }] }), /kind is invalid/);
  assert.throws(() => validateAgentRegistry({ version: 1, agents: [{ id: "a", name: "A", role: "R", status: "napping" }] }), /status is invalid/);
  assert.throws(() => validateAgentRegistry({ version: 1, agents: [{ id: "a", name: "A", role: "R", capabilities: "coding" }] }), /capabilities must be an array/);
  assert.throws(() => validateAgentRegistry({ version: 1, agents: [{ id: "a", name: "A", role: "R" }, { id: "a", name: "B", role: "R" }] }), /duplicate id/);
});

test("listAgents normalises defaults and merges harness ids", () => {
  const hq = makeHq(validRegistry);
  const { agents, warnings } = listAgents(hq);
  assert.equal(warnings.length, 0);
  const claude = agents.find((a) => a.id === "claude-main");
  assert.deepEqual(claude.harnessAgentIds, ["architect", "reviewer"]);
  assert.equal(claude.status, "idle");
  assert.equal(claude.currentProject, null);
  const codex = agents.find((a) => a.id === "codex-builder");
  assert.equal(codex.kind, "codex");
  assert.equal(codex.status, "working");
  assert.equal(codex.currentProject, "lifemaxing");
});

test("listAgents degrades to an empty list plus a warning on a broken registry", () => {
  const hq = makeHq({ version: 1, agents: [{ id: "ok", name: "", role: "R" }] });
  const { agents, warnings } = listAgents(hq);
  assert.deepEqual(agents, []);
  assert.equal(warnings[0].code, "agent-registry-invalid");
});

test("resolveAgent returns one agent by id", () => {
  const hq = makeHq(validRegistry);
  assert.equal(resolveAgent(hq, "codex-builder").name, "Codex");
  assert.equal(resolveAgent(hq, "ghost"), null);
});

test("harnessAvailable defaults true and harnessFallback defaults null when absent", () => {
  const hq = makeHq(validRegistry);
  const { agents } = listAgents(hq);
  for (const a of agents) {
    assert.equal(a.harnessAvailable, true);
    assert.equal(a.harnessFallback, null);
  }
});

test("a role can declare its intended harness is currently unavailable, with a fallback", () => {
  const hq = makeHq({
    version: 1,
    agents: [
      { id: "frontend-builder", name: "Frontend", role: "UI", harness: "cursor", harnessAvailable: false, harnessFallback: "openclaw", runtimeAgentId: "frontend-builder" },
    ],
  });
  const { agents, warnings } = listAgents(hq);
  assert.equal(warnings.length, 0);
  assert.equal(agents[0].harness, "cursor");
  assert.equal(agents[0].harnessAvailable, false);
  assert.equal(agents[0].harnessFallback, "openclaw");
});

test("validateAgentRegistry rejects a bad harnessAvailable/harnessFallback", () => {
  assert.throws(
    () => validateAgentRegistry({ version: 1, agents: [{ id: "a", name: "A", role: "R", harnessAvailable: "yes" }] }),
    /harnessAvailable must be a boolean/
  );
  assert.throws(
    () => validateAgentRegistry({ version: 1, agents: [{ id: "a", name: "A", role: "R", harnessFallback: "wizard" }] }),
    /harnessFallback is invalid/
  );
});
