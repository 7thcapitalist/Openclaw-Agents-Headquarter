import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHandoff } from "../lib/handoff.mjs";
import { clampSection, SECTION_BUDGETS } from "../lib/intel/assemble.mjs";
import { buildKnowledgeBlock } from "../lib/learning/handoff-inject.mjs";

// Mirrors the routing convention factory/lib/openclaw-runner.mjs's
// selectAgentId() applies at dispatch time: bare stage keys for the 1:1
// stages, "<stage>:<harness>" keys for the one stage (builder) that fans out
// to more than one runtime agent.
const AGENT_IDS = {
  product: "product",
  architect: "architect",
  "builder:codex": "backend-builder",
  "builder:frontend": "frontend-builder",
  reviewer: "reviewer",
  "qa:claude": "qa",
  "qa:codex": "qa",
  security: "security",
  release: "release",
};

// One dispatch per pipeline stage, plus the two harnesses "builder" fans out
// to, so all eight dossier-bearing roles are exercised.
const ROLE_CASES = [
  { stage: "product", actor: "openclaw", role: "product" },
  { stage: "architect", actor: "claude", role: "architect" },
  { stage: "builder", actor: "codex", role: "backend-builder" },
  { stage: "builder", actor: "frontend", role: "frontend-builder" },
  { stage: "reviewer", actor: "codex", role: "reviewer" },
  { stage: "qa", actor: "claude", role: "qa" },
  { stage: "security", actor: "claude", role: "security" },
  { stage: "release", actor: "openclaw", role: "release" },
];

function fakeHq({ injectIntoHandoff }) {
  const root = mkdtempSync(join(tmpdir(), "handoff-knowledge-hq-"));
  mkdirSync(join(root, "factory", "prompts"), { recursive: true });
  mkdirSync(join(root, "factory", "knowledge", "agents"), { recursive: true });
  writeFileSync(
    join(root, "factory", "factory.config.json"),
    JSON.stringify({ version: 1, mode: "human-merge", openclawIntegration: { agentIds: AGENT_IDS }, learning: { injectIntoHandoff } }),
    "utf8",
  );
  for (const stage of ["product", "architect", "builder", "reviewer", "qa", "security", "release"]) {
    writeFileSync(join(root, "factory", "prompts", `${stage}.md`), `# ${stage}\n\nDo the ${stage} work.\n`, "utf8");
  }
  for (const { role } of ROLE_CASES) {
    writeFileSync(join(root, "factory", "knowledge", "agents", `${role}.md`), `# ${role} dossier\n\n- MARKER_${role}\n`, "utf8");
  }
  return root;
}

function stateFor({ stage, actor }) {
  const worktree = mkdtempSync(join(tmpdir(), "handoff-knowledge-wt-"));
  return {
    version: 1,
    repo: worktree,
    worktree,
    branch: `factory/${stage}`,
    task: { id: `task-${stage}`, issue: "1", project: "demo-project-not-registered", outcome: "Ship it.", acceptanceCriteria: ["works"], constraints: [] },
    assignments: { [stage]: actor },
    currentStage: stage,
    stages: {},
    dispatches: [],
    founderDecisions: [],
  };
}

function writeCase(root, testCase) {
  const stateDir = mkdtempSync(join(tmpdir(), "handoff-knowledge-state-"));
  const statePath = join(stateDir, "state.json");
  const state = stateFor(testCase);
  writeFileSync(statePath, JSON.stringify(state));
  const path = writeHandoff({ hqRoot: root, statePath, state });
  return readFileSync(path, "utf8");
}

test("with injectIntoHandoff on, each of the eight roles' handoff carries that role's own knowledge block", () => {
  const root = fakeHq({ injectIntoHandoff: true });
  for (const testCase of ROLE_CASES) {
    const body = writeCase(root, testCase);
    assert.match(body, /## Company knowledge/, `${testCase.stage} (actor ${testCase.actor}) should carry a knowledge block`);
    assert.match(
      body,
      new RegExp(`MARKER_${testCase.role}`),
      `${testCase.stage} (actor ${testCase.actor}) should resolve to the ${testCase.role} dossier, not a different one`,
    );
    // No cross-contamination: only this role's marker should appear.
    for (const other of ROLE_CASES) {
      if (other.role === testCase.role) continue;
      assert.doesNotMatch(body, new RegExp(`MARKER_${other.role}\\b`), `${testCase.stage} must not carry the ${other.role} dossier`);
    }
  }
});

test("with injectIntoHandoff off, none of the eight roles' handoffs carry a knowledge block", () => {
  const root = fakeHq({ injectIntoHandoff: false });
  for (const testCase of ROLE_CASES) {
    const body = writeCase(root, testCase);
    assert.doesNotMatch(body, /## Company knowledge/, `${testCase.stage} (actor ${testCase.actor}) must stay silent when the flag is off`);
  }
});

test("buildKnowledgeBlock clamps a huge dossier to the configured budget on a complete-bullet boundary", () => {
  const bullets = Array.from({ length: 50 }, (_, i) => `- lesson ${i}: ${"x".repeat(1010)}`);
  const dossier = `# architect dossier\n\n${bullets.join("\n")}\n`;
  assert.ok(dossier.length >= 50000, "fixture dossier must be at least 50,000 characters");

  const root = fakeHq({ injectIntoHandoff: true });
  writeFileSync(join(root, "factory", "knowledge", "agents", "architect.md"), dossier, "utf8");

  const { text: block } = buildKnowledgeBlock({ hqRoot: root, role: "architect", env: { FACTORY_LEARNING_IN_HANDOFF: "1" } });

  assert.ok(block.length > 0, "a 50,000-character dossier should still produce a block to clamp");
  assert.ok(block.length <= SECTION_BUDGETS.knowledge, `block (${block.length} chars) must fit the ${SECTION_BUDGETS.knowledge}-char budget`);
  assert.match(block, /\(section truncated —/, "a block this large must show the shared clamp's truncation marker");

  // Every retained line, other than the trailing truncation marker, must be
  // one of the fixed header lines or a complete, unmodified bullet from the
  // source dossier -- never a prefix of one. That is what proves the clamp
  // boundary landed on a complete bullet instead of splitting one in half.
  const withoutMarker = block.replace(/\n… \(section truncated —[^\n]*\)$/, "");
  const allowedLines = new Set([
    "## Company knowledge",
    "",
    "Accepted lessons from prior tasks across the company. Apply them; if one is wrong for this task, say so in your summary.",
    "### For the architect role",
    ...bullets,
  ]);
  for (const line of withoutMarker.split("\n")) {
    assert.ok(allowedLines.has(line), `retained line is not a known complete line (clamp split mid-bullet): ${JSON.stringify(line.slice(0, 60))}`);
  }

  const unclamped = [
    "## Company knowledge",
    "",
    "Accepted lessons from prior tasks across the company. Apply them; if one is wrong for this task, say so in your summary.",
    "",
    "### For the architect role",
    "",
    ...bullets.slice(0, 6),
    "",
  ].join("\n");
  assert.equal(block, clampSection(
    unclamped,
    SECTION_BUDGETS.knowledge,
    "factory/knowledge/agents/",
    { boundary: "line" },
  ), "buildKnowledgeBlock must use the shared SECTION_BUDGETS clamp");
});
