import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { runOneStage } from "../lib/openclaw-runner.mjs";

// Regression guard for the defect that stranded obj-c58897c0 (LifeMaxing game
// backend): the builder produced a green, verified deliverable, self-reported
// its canonical AGENTS.md id `backend-builder`, and the protocol rejected the
// result because the dispatch's logical actor is the harness token `codex`.
// That rejection was routed as a stage failure, which burned 11 attempts and
// two of three recovery passes on work that was already finished.

const hqRoot = resolve(".");
const task = {
  id: "issue-identity",
  issue: "identity",
  outcome: "A builder result is accepted under either identity it may report.",
  acceptanceCriteria: ["The green builder deliverable is not discarded"],
  project: "sample",
  workType: "backend",
  risk: "low",
};

// Route builder:codex -> backend-builder, exactly as factory.config.json does.
const routes = { openclaw: "main", architect: "architect", "builder:codex": "backend-builder" };

test("a builder reporting its runtime agent id is accepted, not routed as a failure", async () => {
  const fixture = makeFixture();
  const seen = [];
  // Every agent reports the logical actor except the builder, which reports the
  // canonical runtime id it knows itself by — the real observed behaviour.
  const execute = async ({ dispatch, agentId, cwd }) => {
    seen.push({ stage: dispatch.stage, actor: dispatch.actor, agentId });
    const evidence = writeEvidence(cwd, dispatch.stage);
    const actor = dispatch.stage === "builder" ? agentId : dispatch.actor;
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor,
      outcome: "pass", summary: `${dispatch.stage} pass`, evidence: [evidence],
    }));
  };

  let response;
  do {
    response = await runOneStage({
      hqRoot, statePath: fixture.statePath, agentIds: routes, execute,
      publish: () => ({ published: false, reason: "no github in fixture" }),
    });
  } while (response.status === "active");

  const state = readState(fixture.statePath);
  assert.equal(state.status, "merge-ready", `task did not finish: ${JSON.stringify(state.blocker || null)}`);
  assert.equal(state.stages.builder.status, "pass");
  // The builder ran exactly once: its result was accepted first time, so no
  // retry and no recovery attempt was spent.
  assert.equal(seen.filter((s) => s.stage === "builder").length, 1);
  assert.equal(state.recovery.attempts.length, 0);
  assert.equal(state.failures.length, 0);
});

test("the routed runtime agent id is persisted on the dispatch", async () => {
  const fixture = makeFixture();
  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor,
      outcome: "pass", summary: "pass", evidence: [evidence],
    }));
  };
  let response;
  do {
    response = await runOneStage({
      hqRoot, statePath: fixture.statePath, agentIds: routes, execute,
      publish: () => ({ published: false, reason: "no github in fixture" }),
    });
  } while (response.status === "active");
  const state = readState(fixture.statePath);
  const builderDispatch = (state.dispatches || []).find((d) => d.stage === "builder");
  assert.ok(builderDispatch, "the builder stage produced a dispatch record");
  assert.equal(builderDispatch.actor, "codex", "the workflow still tracks the logical actor");
  assert.equal(builderDispatch.agentId, "backend-builder", "the routing decision is recorded");
});

test("an unrelated identity is still rejected", async () => {
  const fixture = makeFixture();
  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: "some-other-agent",
      outcome: "pass", summary: "pass", evidence: [evidence],
    }));
  };
  const response = await runOneStage({ hqRoot, statePath: fixture.statePath, agentIds: routes, execute });
  assert.notEqual(response.status, "merge-ready");
  const state = readState(fixture.statePath);
  assert.equal(state.stages.product.status !== "pass", true, "a foreign actor must not pass the stage");
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "dispatch-identity-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree);
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/identity", worktree }));
  return { root, worktree, statePath };
}

function writeEvidence(worktree, stage) {
  const dir = join(worktree, "evidence");
  mkdirSync(dir, { recursive: true });
  const relative = `evidence/${stage}.md`;
  writeFileSync(join(worktree, relative), `${stage} verified\n`);
  return relative;
}
