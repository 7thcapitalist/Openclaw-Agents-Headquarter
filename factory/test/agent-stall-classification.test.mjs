import test from "node:test";
import assert from "node:assert/strict";
import { describeAgentCompletion } from "../lib/hq/agent-meta.mjs";
import { classifyFailure } from "../lib/failure-classification.mjs";
import { classifyBlocker, isRetriableInfraBlocker } from "../lib/hq/blocker-class.mjs";

// The exact envelope shape the qa agent produced on lifemaxing
// obj-c58897c0-game-backend: the provider succeeded, the model answered with a
// plan ("Starting the QA verification now."), the turn stopped normally, and no
// result file was ever written.
const AGENT_STALLED = JSON.stringify({
  result: {
    finalAssistantVisibleText: "Understood. I will now proceed... Starting the QA verification now.",
    stopReason: "stop",
    livenessState: "working",
    executionTrace: {
      winnerProvider: "github-copilot",
      winnerModel: "gpt-4.1",
      attempts: [{ provider: "github-copilot", model: "gpt-4.1", result: "success", stage: "assistant" }],
      fallbackUsed: false,
    },
  },
});

test("a completed turn with no result file is detected, with its route", () => {
  const seen = describeAgentCompletion({ stdout: AGENT_STALLED });
  assert.equal(seen.completed, true);
  assert.equal(seen.provider, "github-copilot");
  assert.equal(seen.model, "gpt-4.1");
  assert.equal(seen.stopReason, "stop");
});

test("detection is conservative: anything unrecognised is not a stall", () => {
  for (const stdout of [
    JSON.stringify({ status: "error", message: "socket hang up" }),
    JSON.stringify({ status: "timeout" }),
    JSON.stringify({ ok: false }),
    "ECONNRESET while contacting provider",
    "",
  ])
    assert.equal(describeAgentCompletion({ stdout }).completed, false, stdout.slice(0, 30));
});

// "No result file" is the symptom of two opposite causes. Only one is transient,
// and only infra-class blockers are auto-retried, so conflating them spends a
// task's revival budget re-running a route that cannot succeed.
const stall = {
  outcome: "fail",
  summary:
    "qa agent completed its turn without writing a result file (github-copilot/gpt-4.1); "
    + "the route ran but produced no gate artifact, so retrying it unchanged will repeat.",
};
const infra = {
  outcome: "fail",
  summary: "qa dispatch wrote no result file (session agent:qa:factory-x); redacted executor output captured at evidence/x.md.",
};

test("an agent stall is not classified as infrastructure", () => {
  assert.equal(classifyFailure({ error: stall.summary, source: "harness" }), "AGENT_ERROR");
  assert.equal(classifyBlocker(stall), "hard");
  assert.equal(isRetriableInfraBlocker(stall), false);
});

test("a genuine unreachable-agent failure is still infrastructure", () => {
  assert.equal(classifyFailure({ error: infra.summary, source: "harness" }), "INFRASTRUCTURE_ERROR");
  assert.equal(classifyBlocker(infra), "infra");
  assert.equal(isRetriableInfraBlocker(infra), true);
});

test("a stall stays unretriable once recovery has wrapped it", () => {
  // Recovery escalation keeps the original error in `why` and rewrites summary.
  const wrapped = {
    outcome: "decision-required",
    founderAction: true,
    summary: "Recovery could not continue after 3 bounded attempt(s): ...",
    why: stall.summary,
  };
  assert.equal(isRetriableInfraBlocker(wrapped), false);
  // The infra equivalent stays retriable, so the sweep still picks it up when
  // the seat comes back.
  assert.equal(isRetriableInfraBlocker({ ...wrapped, why: infra.summary }), true);
});
