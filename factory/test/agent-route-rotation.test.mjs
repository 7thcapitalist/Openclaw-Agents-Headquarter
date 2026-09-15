// Rotating off a model route that ran and delivered nothing.
//
// OpenClaw's own chain fails over on a PROVIDER error. It does not fail over
// when the agent is reached, answers, ends its turn and never writes the result
// file the gate protocol requires — from the provider's side that turn
// succeeded. The retry then lands on the identical route and reproduces the
// failure exactly, which is how obj-47cf7355 burned three recovery attempts
// without a line of code being written. These tests pin the rotation that
// prevents that, and pin the case where rotating would be wrong.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { nextRoute, providerOf, readAgentChain, rotatedRouteFor } from "../lib/agent-routes.mjs";
import { runOneStage } from "../lib/openclaw-runner.mjs";
import { createState, readState, writeState } from "../lib/task-workflow.mjs";

const hqRoot = resolve(".");

const CONFIG = {
  agents: {
    defaults: { model: { primary: "openai/gpt-5.6-sol", fallbacks: ["anthropic/claude-sonnet-5", "openai/gpt-5.4-mini"] } },
    entries: {
      product: { model: { primary: "openai/gpt-5.6-sol", fallbacks: ["openai/gpt-5.4-mini", "anthropic/claude-sonnet-5", "github-copilot/gpt-4.1"] } },
      lonely: { model: { primary: "openai/gpt-5.6-sol", fallbacks: [] } },
    },
  },
};

test("providerOf splits the provider off a route, and treats a bare model as its own", () => {
  assert.equal(providerOf("anthropic/claude-sonnet-5"), "anthropic");
  assert.equal(providerOf("github-copilot/gpt-4.1"), "github-copilot");
  assert.equal(providerOf("gpt-4.1"), "gpt-4.1");
  assert.equal(providerOf(""), "");
  assert.equal(providerOf(null), "");
});

test("readAgentChain prefers the agent's own chain and falls back to the defaults", () => {
  assert.deepEqual(readAgentChain("product", { config: CONFIG }), [
    "openai/gpt-5.6-sol", "openai/gpt-5.4-mini", "anthropic/claude-sonnet-5", "github-copilot/gpt-4.1",
  ]);
  // An agent with no entry of its own inherits what OpenClaw would give it.
  assert.deepEqual(readAgentChain("architect", { config: CONFIG }), [
    "openai/gpt-5.6-sol", "anthropic/claude-sonnet-5", "openai/gpt-5.4-mini",
  ]);
  // A config that cannot be read is not an error — there is simply nothing to rotate.
  assert.deepEqual(readAgentChain("product", { configPath: join(tmpdir(), "does-not-exist-openclaw.json") }), []);
});

test("nextRoute skips the whole failed provider, not just the failed model", () => {
  const chain = readAgentChain("product", { config: CONFIG });
  // The seat failed, so a sibling model on the same seat is not a real retry.
  assert.equal(nextRoute(chain, { exhausted: ["openai/gpt-5.6-sol"] }), "anthropic/claude-sonnet-5");
  assert.equal(nextRoute(chain, { exhausted: ["openai/gpt-5.6-sol", "anthropic/claude-sonnet-5"] }), "github-copilot/gpt-4.1");
});

test("nextRoute changes nothing until something has actually failed", () => {
  assert.equal(nextRoute(readAgentChain("product", { config: CONFIG }), { exhausted: [] }), null);
  assert.equal(rotatedRouteFor("product", [], { config: CONFIG }), null);
});

test("nextRoute takes a same-provider route rather than stranding a single-provider host", () => {
  const chain = ["openai/gpt-5.6-sol", "openai/gpt-5.4-mini"];
  assert.equal(nextRoute(chain, { exhausted: ["openai/gpt-5.6-sol"] }), "openai/gpt-5.4-mini");
});

test("nextRoute gives up when the chain is exhausted", () => {
  const chain = readAgentChain("lonely", { config: CONFIG });
  assert.equal(nextRoute(chain, { exhausted: ["openai/gpt-5.6-sol"] }), null);
});

// ── the runner ──────────────────────────────────────────────────────────────

const task = {
  id: "issue-902",
  issue: "902",
  outcome: "Prove the retry leaves the dead route.",
  acceptanceCriteria: ["A burned route is not retried"],
  project: "sample",
  workType: "backend",
  risk: "low",
};

function makeFixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree);
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: "factory/issue-902", worktree }));
  return { worktree, statePath };
}

// An agent that was reached, answered, and ended its turn normally — and still
// wrote no result file. This is the shape the rotation exists for.
const completedTurn = (provider, model) => ({
  stdout: JSON.stringify({
    ok: true,
    result: {
      stopReason: "stop",
      executionTrace: { winnerProvider: provider, winnerModel: model, attempts: [{ result: "success" }] },
    },
  }),
  stderr: "",
});

test("a route that answered and delivered nothing is recorded, and the retry leaves it", async () => {
  const fixture = makeFixture("route-rotation-");
  const seen = [];
  const execute = async ({ agentId, model }) => {
    seen.push({ agentId, model: model || null });
    return completedTurn("openai", "gpt-5.6-sol");
  };

  const first = await runOneStage({ hqRoot, statePath: fixture.statePath, execute });
  assert.equal(first.status, "active", "a missing result is a retryable dispatch failure");
  assert.deepEqual(seen[0], { agentId: "product", model: null }, "the first attempt uses the agent's own chain");

  const afterFirst = readState(fixture.statePath);
  assert.deepEqual(afterFirst.routeFailures?.product, ["openai/gpt-5.6-sol"],
    "the route that ran without delivering is remembered against the stage");

  // The next dispatch for this stage may legitimately run on another agent —
  // the recovery ladder routes its diagnose step to the `recovery` agent. What
  // matters is that whoever picks the stage up is sent somewhere else.
  await runOneStage({ hqRoot, statePath: fixture.statePath, execute });
  assert.equal(seen.length, 2);
  assert.equal(readState(fixture.statePath).currentStage, "product", "still the same stage being retried");
  assert.notEqual(seen[1].model, null, "the retry must not be left on the agent's own chain");
  assert.notEqual(seen[1].model, "openai/gpt-5.6-sol", "the retry must not repeat the route that just failed");
  assert.notEqual(providerOf(seen[1].model), "openai", "the retry leaves the provider whose seat failed");
  // The override is on the durable dispatch record, so "why did this attempt run
  // somewhere else" is answerable after the fact.
  const dispatched = readState(fixture.statePath).dispatches || [];
  assert.equal(dispatched.at(-1).route, seen[1].model,
    "the overridden route is recorded on the dispatch that used it");
  assert.equal(dispatched[0].route, undefined, "the first attempt recorded no override");
});

test("an unreachable agent does not cost its route — only a turn that ran does", async () => {
  const fixture = makeFixture("route-rotation-unreachable-");
  // No parseable envelope: the agent could not be reached or died mid-turn. That
  // says nothing about the route, so blacklisting it would push healthy work off
  // its configured seat on a transient blip.
  const execute = async () => ({ stdout: "connection reset", stderr: "Error: socket hang up" });

  await runOneStage({ hqRoot, statePath: fixture.statePath, execute });
  const state = readState(fixture.statePath);
  assert.equal(state.routeFailures?.product, undefined, "a transient failure is not a verdict on the route");
});
