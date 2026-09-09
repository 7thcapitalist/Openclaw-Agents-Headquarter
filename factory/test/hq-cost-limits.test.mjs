import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";

import { createState, readState, writeState } from "../lib/task-workflow.mjs";
import { runOneStage, runToTerminal } from "../lib/openclaw-runner.mjs";
import { summarizeCosts } from "../lib/hq/cost.mjs";
import { readPlanLimits } from "../lib/hq/plan-limits.mjs";
import { buildHqCostsPayload, buildHqPlanLimitsPayload } from "../../dashboard/backend/lib/hq-cost-limits.mjs";

const hqRoot = resolve(".");
const pricing = {
  version: 1,
  currency: "USD",
  updatedAt: "2026-09-08",
  models: {
    "openai/gpt-5.6-sol": {
      inputUsdPerMillion: 4,
      outputUsdPerMillion: 20,
      label: "GPT-5.6 Sol",
    },
    "anthropic/claude-sonnet-5": {
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 10,
      label: "Claude Sonnet 5",
    },
  },
  aliases: {
    "gpt-5.6-sol": "openai/gpt-5.6-sol",
  },
  unknownModel: {
    strategy: "null-cost",
    label: "unpriced",
  },
};

test("dispatch ingestion persists usage metadata when the executor emits an agent envelope", async () => {
  const fixture = makeDispatchFixture("issue-1001");
  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence])));
    return {
      stdout: JSON.stringify({
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.6-sol",
            usage: { tokensIn: 12, tokensOut: 34 },
            durationMs: 99,
          },
        },
      }),
    };
  };

  const response = await runOneStage({ hqRoot, statePath: fixture.statePath, execute, publish: () => ({ published: false }) });
  assert.equal(response.status, "active");
  const state = readState(fixture.statePath);
  assert.deepEqual(state.dispatches[0].usage, {
    provider: "openai",
    model: "gpt-5.6-sol",
    tokensIn: 12,
    tokensOut: 34,
    durationMs: 99,
  });
});

test("dispatch ingestion leaves usage empty when the executor emits no usage metadata", async () => {
  const fixture = makeDispatchFixture("issue-1002");
  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence])));
    return { stdout: JSON.stringify({ ok: true }) };
  };

  await runOneStage({ hqRoot, statePath: fixture.statePath, execute, publish: () => ({ published: false }) });
  const state = readState(fixture.statePath);
  assert.equal(state.dispatches[0].usage, undefined);
});

test("concurrent execution and rollups keep usage, cost, and unknown-model fallback data", async () => {
  const fixture = makeFixtureRoot();
  const stateRoot = join(fixture.root, "states");
  const taskFixture = makeWorkflowFixture(stateRoot, makeTask("issue-2000", "alpha"));
  const taskAlpha = makeTask("issue-2001", "alpha");
  const taskBeta = makeTask("issue-2002", "beta");

  writeTaskState(stateRoot, taskAlpha, [
    {
      stage: "product",
      actor: "openclaw",
      completedAt: "2026-09-08T10:00:00Z",
      usage: { provider: "openai", model: "gpt-5.6-sol", tokensIn: 1000, tokensOut: 2000, durationMs: 100 },
    },
    {
      stage: "architect",
      actor: "openclaw",
      completedAt: "2026-09-08T11:00:00Z",
      usage: { provider: "github-copilot", model: "gpt-4.1", tokensIn: 100, tokensOut: 100, durationMs: 50 },
    },
    {
      stage: "builder",
      actor: "openclaw",
      completedAt: "2026-09-08T12:00:00Z",
    },
  ]);
  writeTaskState(stateRoot, taskBeta, [
    {
      stage: "qa",
      actor: "openclaw",
      completedAt: "2026-09-07T09:00:00Z",
      usage: { provider: "anthropic", model: "claude-sonnet-5", tokensIn: 500, tokensOut: 100, durationMs: 200 },
    },
  ]);

  const execute = async ({ dispatch, cwd }) => {
    const evidence = writeEvidence(cwd, dispatch.stage);
    writeFileSync(dispatch.resultPath, JSON.stringify(resultFor(dispatch, [evidence])));
    return {
      stdout: JSON.stringify({
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.6-sol",
            usage: { tokensIn: 10, tokensOut: 20 },
            durationMs: 20,
          },
        },
      }),
    };
  };

  const response = await runToTerminal({ hqRoot, statePath: taskFixture.statePath, execute, publish: () => ({ published: false }) });
  assert.equal(response.status, "merge-ready");
  const state = readState(taskFixture.statePath);
  assert.ok(state.dispatches.every((dispatch) => dispatch.usage?.provider === "openai"));

  const costs = summarizeCosts({ hqRoot, stateRoot, pricing, now: "2026-09-08T12:30:00Z" });
  assert.equal(costs.totals.dispatches, 11);
  assert.equal(costs.totals.dispatchesMissingUsage, 1);
  assert.equal(costs.totals.dispatchesUnpriced, 1);
  assert.equal(costs.totals.costUsd, 0.04908);
  assert.deepEqual(costs.totals.unpricedModels, ["github-copilot/gpt-4.1"]);
  assert.equal(costs.byTask["issue-2000"].dispatches, 7);
  assert.equal(costs.byTask["issue-2000"].costUsd, 0.00308);
  assert.equal(costs.byTask["issue-2001"].dispatches, 3);
  assert.equal(costs.byTask["issue-2001"].dispatchesMissingUsage, 1);
  assert.equal(costs.byTask["issue-2001"].dispatchesUnpriced, 1);
  assert.equal(costs.byTask["issue-2001"].costUsd, 0.044);
  assert.equal(costs.byTask["issue-2002"].costUsd, 0.002);
  assert.equal(costs.byProviderModel["openai/gpt-5.6-sol"].costUsd, 0.04708);
  assert.equal(costs.byProviderModel["anthropic/claude-sonnet-5"].costUsd, 0.002);
  assert.equal(costs.byProviderModel["github-copilot/gpt-4.1"].costUsd, null);
  assert.deepEqual(costs.byProviderModel["github-copilot/gpt-4.1"].unpricedModels, ["github-copilot/gpt-4.1"]);

  const payload = await buildHqCostsPayload({ hqRoot, stateRoot, pricing, now: "2026-09-08T12:30:00Z" });
  assert.equal(payload.byProject.alpha.costUsd, 0.04708);
  assert.equal(payload.byProject.beta.costUsd, 0.002);
});

test("readPlanLimits reports official, inferred, and unavailable headroom shapes", async () => {
  const official = await readPlanLimits({
    authoritativeSource: {
      providers: {
        openai: { limit: 100, used: 40, remaining: 60, resetAt: "2026-09-08T13:00:00Z" },
      },
    },
    asOf: "2026-09-08T10:00:00Z",
  });
  assert.equal(official.available, true);
  assert.equal(official.source, "official");
  assert.equal(official.providers.openai.limit, 100);
  assert.equal(official.providers.openai.used, 40);
  assert.equal(official.providers.openai.remaining, 60);
  assert.equal(official.providers.openai.resetAt, "2026-09-08T13:00:00Z");

  const inferred = await readPlanLimits({
    usageWindows: [
      {
        provider: "openai",
        label: "observed rolling openai usage",
        start: "2026-09-08T08:00:00Z",
        end: "2026-09-08T09:00:00Z",
        tokensIn: 100,
        tokensOut: 50,
        dispatches: 2,
        cooldowns: 1,
      },
    ],
    cooldownHistory: [
      { at: "2026-09-08T09:05:00Z", stage: "qa", provider: "openai", label: "cooldown" },
    ],
    asOf: "2026-09-08T10:00:00Z",
  });
  assert.equal(inferred.available, true);
  assert.equal(inferred.source, "inferred");
  assert.equal(inferred.usageWindows.length, 1);
  assert.equal(inferred.cooldownHistory.length, 1);

  const unavailable = await readPlanLimits({ asOf: "2026-09-08T10:00:00Z" });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /No authoritative plan-limit source/);
});

test("buildHqPlanLimitsPayload derives inferred windows from state files and lets injected official limits win", async () => {
  const fixture = makeFixtureRoot();
  const stateRoot = join(fixture.root, "states");
  const task = makeTask("issue-3001", "gamma");
  writeTaskState(stateRoot, task, [
    {
      stage: "qa",
      actor: "openclaw",
      completedAt: "2026-09-08T08:00:00Z",
      usage: { provider: "openai", model: "gpt-5.6-sol", tokensIn: 100, tokensOut: 20, durationMs: 10 },
    },
  ], {
    blocker: { stage: "qa", outcome: "fail", summary: "429 rate limit", at: "2026-09-08T08:10:00Z" },
  });

  const inferred = await buildHqPlanLimitsPayload({ hqRoot, stateRoot, now: "2026-09-08T10:00:00Z" });
  assert.equal(inferred.available, true);
  assert.equal(inferred.source, "inferred");
  assert.equal(inferred.usageWindows[0].provider, "openai");
  assert.equal(inferred.cooldownHistory.length, 1);

  const official = await buildHqPlanLimitsPayload({
    hqRoot,
    stateRoot,
    authoritativeSource: {
      providers: {
        openai: { limit: 7, used: 2, remaining: 5 },
      },
    },
    now: "2026-09-08T10:00:00Z",
  });
  assert.equal(official.available, true);
  assert.equal(official.source, "official");
  assert.equal(official.providers.openai.limit, 7);
});

test("payload builders resolve their own state root from hqRoot alone (server call shape)", async () => {
  // The dashboard routes call these with only { hqRoot } — no stateRoot. That
  // path was never covered and regressed: defaultStateRoot(hqRoot) needs a repo
  // argument, so the bare call threw "paths[0] must be of type string".
  const { root } = makeFixtureRoot();

  const costs = await buildHqCostsPayload({ hqRoot: root, pricing, now: "2026-09-08T12:30:00Z" });
  assert.equal(costs.version, 1);
  assert.equal(costs.totals.dispatches, 0);
  assert.ok(Array.isArray(costs.recentTasks));
  assert.ok(costs.totals.today);

  const limits = await buildHqPlanLimitsPayload({ hqRoot: root, now: "2026-09-08T12:30:00Z" });
  assert.equal(limits.available, false);
  assert.match(limits.reason, /No authoritative plan-limit source/);
});

function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "hq-cost-limits-"));
  return { root };
}

function makeDispatchFixture(taskId) {
  const root = mkdtempSync(join(tmpdir(), "hq-dispatch-"));
  const worktree = join(root, "worktree");
  const statePath = join(root, "state", "state.json");
  mkdirSync(worktree, { recursive: true });
  const task = makeTask(taskId, "sample");
  writeState(statePath, createState({ task, repo: join(root, "repo"), branch: `factory/${taskId}`, worktree }));
  return { root, worktree, statePath };
}

function makeWorkflowFixture(stateRoot, task) {
  const worktree = join(stateRoot, task.project, task.id, "worktree");
  const statePath = join(stateRoot, task.project, task.id, "state.json");
  mkdirSync(worktree, { recursive: true });
  writeState(statePath, createState({ task, repo: join(stateRoot, task.project, task.id, "repo"), branch: `factory/${task.id}`, worktree }));
  return { worktree, statePath };
}

function makeTask(id, project) {
  return {
    id,
    issue: id.replace(/^issue-/, ""),
    outcome: "Deliver an HQ integration layer.",
    acceptanceCriteria: ["Evidence is persisted"],
    project,
    workType: "backend",
    risk: "low",
  };
}

function writeTaskState(stateRoot, task, dispatches, extra = {}) {
  const statePath = join(stateRoot, task.project, task.id, "state.json");
  mkdirSync(dirname(statePath), { recursive: true });
  const worktree = join(stateRoot, task.project, task.id, "worktree");
  mkdirSync(worktree, { recursive: true });
  const state = createState({ task, repo: join(stateRoot, task.project, task.id, "repo"), branch: `factory/${task.id}`, worktree });
  state.dispatches = dispatches.map((dispatch) => ({
    id: `${task.id}-${dispatch.stage}`,
    stage: dispatch.stage,
    actor: dispatch.actor || "openclaw",
    status: "completed",
    outcome: "pass",
    summary: `${dispatch.stage} pass`,
    completedAt: dispatch.completedAt,
    usage: dispatch.usage,
  }));
  if (extra.blocker) state.blocker = extra.blocker;
  state.updatedAt = dispatches.at(-1)?.completedAt || "2026-09-08T00:00:00Z";
  writeState(statePath, state);
  return statePath;
}

function writeEvidence(worktree, stage) {
  const dir = join(worktree, "evidence");
  mkdirSync(dir, { recursive: true });
  const relative = `evidence/${stage}.md`;
  writeFileSync(join(worktree, relative), `${stage} verified\n`);
  return relative;
}

function resultFor(dispatch, evidence, outcome = "pass") {
  return {
    version: 1,
    dispatchId: dispatch.dispatchId,
    stage: dispatch.stage,
    actor: dispatch.actor,
    outcome,
    summary: `${dispatch.stage} ${outcome}`,
    evidence,
  };
}
