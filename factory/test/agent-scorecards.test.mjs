import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildAgentScorecards } from "../lib/hq/agent-scorecards.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hq-scorecards-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "pricing.json"), JSON.stringify({
    version: 1, currency: "USD", updatedAt: "2026-09-08",
    models: { "openai/m": { provider: "openai", model: "m", inputUsdPerMillion: 4, outputUsdPerMillion: 20 } },
  }));
  return root;
}

const dispatch = (over = {}) => ({
  id: "d1", stage: "builder", actor: "codex", status: "completed", attempt: 1, outcome: "pass",
  startedAt: "2026-09-10T00:00:00.000Z", completedAt: "2026-09-10T00:01:00.000Z", ...over,
});

function writeTask(root, taskId, state) {
  const dir = join(root, "state", "proj", "tasks", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    task: { id: taskId, project: "hq", risk: "low", outcome: "x" },
    status: "active", assignments: { builder: "codex", reviewer: "claude", qa: "claude", security: "claude" },
    stages: {}, dispatches: [], events: [], ...state,
  }));
}

const cards = (root, over = {}) => buildAgentScorecards({ hqRoot: root, stateRoot: join(root, "state"), ledgerPath: join(root, "ledger.ndjson"), ...over });
const cardFor = (view, agentId) => view.scorecards.find((card) => card.agentId === agentId);

function writeLedger(root, events) {
  writeFileSync(join(root, "ledger.ndjson"), events.map((event) => JSON.stringify({
    version: 1, eventId: event.id, eventType: "usage", source: "f", sourceEventId: event.id,
    replacesEventId: null, occurredAt: "2026-09-10T00:00:00.000Z", recordedAt: "2026-09-10T00:00:00.000Z",
    provider: "openai", model: event.model || "m", inputTokens: event.inputTokens ?? 1_000_000, cachedInputTokens: 0,
    outputTokens: 0, costMicros: null, currency: "USD", pricingVersion: null,
    usageConfidence: "provider-reported", costConfidence: "unavailable",
    agentId: event.agentId, projectId: "hq", objectiveId: null, taskId: null, stage: null, runId: null, dispatchId: null,
  })).join("\n") + "\n");
}

// --- what this deliberately does not measure --------------------------------

test("doing more work is not a better score", () => {
  const root = fixture();
  writeTask(root, "t1", {
    stages: { builder: { status: "pass" } },
    dispatches: [dispatch(), dispatch({ id: "d2", actor: "busy", stage: "builder" })],
  });
  writeTask(root, "t2", {
    stages: { builder: { status: "fail" } },
    dispatches: Array.from({ length: 20 }, (_, i) => dispatch({ id: `b${i}`, actor: "busy", outcome: "fail" })),
  });
  const busy = cardFor(cards(root), "busy");
  assert.ok(busy.outcomes.acceptanceRate < 0.2, "20 dispatches of failed work must not read as a strong agent");
  assert.equal(busy.outcomes.accepted, 1);
});

test("an outcome counts as accepted only when canonical state passed the stage", () => {
  const root = fixture();
  // The agent reported pass; the stage did not end up passing.
  writeTask(root, "t1", { stages: { builder: { status: "fail" } }, dispatches: [dispatch()] });
  const card = cardFor(cards(root), "codex");
  assert.equal(card.outcomes.accepted, 0, "an agent's own 'pass' is a claim, not an accepted outcome");
});

test("cost is only ever reported per accepted outcome", () => {
  const root = fixture();
  writeTask(root, "t1", { stages: { builder: { status: "pass" } }, dispatches: [dispatch()] });
  writeLedger(root, [{ id: "c1", agentId: "codex" }]);
  const card = cardFor(cards(root), "codex");
  assert.equal(card.cost.micros, 4_000_000);
  assert.equal(card.cost.microsPerAcceptedOutcome, 4_000_000);
  assert.equal(card.cost.complete, true);
});

test("an agent with no accepted outcomes has no cost-per-outcome, not a flattering zero", () => {
  const root = fixture();
  writeTask(root, "t1", { stages: { builder: { status: "fail" } }, dispatches: [dispatch({ outcome: "fail" })] });
  writeLedger(root, [{ id: "c1", agentId: "codex" }]);
  assert.equal(cardFor(cards(root), "codex").cost.microsPerAcceptedOutcome, null);
});

// --- gates cut both ways -----------------------------------------------------

test("a gate failure is a finding against the builder and evidence for the gate", () => {
  const root = fixture();
  writeTask(root, "t1", {
    stages: { builder: { status: "pass" }, reviewer: { status: "fail" } },
    dispatches: [dispatch(), dispatch({ id: "d2", stage: "reviewer", actor: "claude", outcome: "fail" })],
  });
  const view = cards(root);
  assert.equal(cardFor(view, "codex").quality.findingsAgainst, 1, "the builder wears the finding");
  assert.equal(cardFor(view, "claude").quality.gateFailuresRaised, 1, "the reviewer gets credit for catching it");
  assert.equal(cardFor(view, "claude").quality.gateRuns, 1);
});

test("recoveries, escalations, and retries are counted against the agent that caused them", () => {
  const root = fixture();
  writeTask(root, "t1", {
    stages: { builder: { status: "pass" } },
    dispatches: [dispatch()],
    events: [
      { at: "2026-09-10T00:00:00Z", type: "failure-routed", stage: "builder", actor: "codex" },
      { at: "2026-09-10T00:00:01Z", type: "recovery-diagnosing", stage: "builder", actor: "codex" },
      { at: "2026-09-10T00:00:02Z", type: "recovery-escalated", stage: "builder", actor: "codex" },
    ],
  });
  const card = cardFor(cards(root), "codex");
  assert.equal(card.quality.recoveries, 1);
  assert.equal(card.quality.founderEscalations, 1);
  assert.equal(card.quality.retryRate, 1);
});

// --- honesty about the data --------------------------------------------------

test("a tiny sample is labelled low confidence and says why", () => {
  const root = fixture();
  writeTask(root, "t1", { stages: { builder: { status: "pass" } }, dispatches: [dispatch()] });
  const card = cardFor(cards(root), "codex");
  assert.equal(card.sampleSize, 1);
  assert.equal(card.confidence, "low");
  assert.match(card.dataQuality.note, /Too few decided outcomes/);
});

test("confidence rises with the sample, not with the score", () => {
  const root = fixture();
  writeTask(root, "t1", {
    stages: { builder: { status: "pass" } },
    dispatches: Array.from({ length: 25 }, (_, i) => dispatch({ id: `d${i}` })),
  });
  assert.equal(cardFor(cards(root), "codex").confidence, "high");
});

test("an agent with no decided outcomes has a null rate, never 0%", () => {
  const root = fixture();
  writeTask(root, "t1", { dispatches: [dispatch({ outcome: "decision-required" })] });
  const card = cardFor(cards(root), "codex");
  assert.equal(card.outcomes.acceptanceRate, null);
  assert.equal(card.outcomes.escalated, 1);
});

test("usage nobody could price is reported as missing, not as free", () => {
  const root = fixture();
  writeTask(root, "t1", { stages: { builder: { status: "pass" } }, dispatches: [dispatch()] });
  writeLedger(root, [{ id: "c1", agentId: "codex", model: "unlisted-model" }]);
  const card = cardFor(cards(root), "codex");
  assert.equal(card.cost.unpricedEvents, 1);
  assert.equal(card.cost.complete, false);
  assert.equal(card.dataQuality.missingCost, true);
  assert.equal(cards(root).summary.missingCostData, 1);
});

test("a corrupt task state degrades the view rather than dropping every agent", () => {
  const root = fixture();
  writeTask(root, "good", { stages: { builder: { status: "pass" } }, dispatches: [dispatch()] });
  const dir = join(root, "state", "proj", "tasks", "bad");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), "{ truncated");
  const view = cards(root);
  assert.equal(view.available, false);
  assert.match(view.warnings.join(" "), /task bad scorecard input unavailable/);
  assert.equal(view.scorecards.length, 1);
});

test("a missing cost ledger is a warning, not a crash or a zero", () => {
  const root = fixture();
  writeTask(root, "t1", { stages: { builder: { status: "pass" } }, dispatches: [dispatch()] });
  const view = cards(root);
  assert.equal(cardFor(view, "codex").cost.micros, null);
  assert.equal(cardFor(view, "codex").dataQuality.missingCost, true);
});

// --- the boundary ------------------------------------------------------------

test("the payload states it is advisory and exposes no routing writer", async () => {
  const root = fixture();
  assert.equal(cards(root).usage, "advisory-only");
  const module = await import("../lib/hq/agent-scorecards.mjs");
  assert.deepEqual(Object.keys(module), ["buildAgentScorecards"], "a scorecard module that can route is a router");
});

test("prompts, result paths, and agent prose never reach the scorecard", () => {
  const root = fixture();
  writeTask(root, "t1", {
    stages: { builder: { status: "pass" } },
    dispatches: [dispatch({
      promptPath: "/home/founder/secret/handoff-builder.md",
      resultPath: "/home/founder/secret/result.json",
      summary: "SENSITIVE AGENT PROSE",
    })],
  });
  const json = JSON.stringify(cards(root));
  assert.doesNotMatch(json, /SENSITIVE AGENT PROSE/);
  assert.doesNotMatch(json, /home\/founder\/secret/);
});

test("a recovery is a fact about the agent whose stage failed, not the recovery agent", () => {
  // recovery-diagnosing carries actor: "recovery" — it is the one doing the
  // diagnosing. Attributing it there credited the recovery agent with every
  // recovery in the factory, which reads as "needs a lot of recovery" and means
  // the exact opposite.
  const root = fixture();
  writeTask(root, "t1", {
    assignments: { builder: "codex", recovery: "recovery" },
    stages: { builder: { status: "pass" } },
    dispatches: [dispatch()],
    events: [
      { at: "2026-09-10T00:00:00Z", type: "recovery-diagnosing", stage: "builder", actor: "recovery" },
      { at: "2026-09-10T00:00:01Z", type: "recovery-escalated", stage: "builder", actor: "system" },
    ],
  });
  const view = cards(root);
  assert.equal(cardFor(view, "codex").quality.recoveries, 1, "the agent whose stage failed wears the recovery");
  assert.equal(cardFor(view, "codex").quality.founderEscalations, 1);
  assert.equal(cardFor(view, "recovery"), undefined, "the recovery agent is not penalised for doing its job");
});
