// SOF-466: runQuotaShare must count only effective ledger events.
import test from "node:test";
import assert from "node:assert/strict";
import { createCostEvent, summarizeCostLedger } from "../lib/hq/cost-ledger.mjs";
import { runQuotaShare } from "../lib/hq/quota-alert.mjs";

const base = { source: "synthetic", provider: "anthropic", model: "claude-x", taskId: "task-1", occurredAt: "2026-09-09T10:00:00.000Z" };

test("usage replaced by a correction counts the corrected tokens only", () => {
  const events = [
    createCostEvent({ ...base, eventId: "u1", sourceEventId: "s1", inputTokens: 100 }),
    createCostEvent({ ...base, eventId: "c1", sourceEventId: "s2", eventType: "correction", replacesEventId: "u1", inputTokens: 20 }),
  ];
  assert.equal(summarizeCostLedger(events).byTask["task-1"].inputTokens, 20);
  assert.equal(runQuotaShare(events, "task-1", 1000).tokens, 20);
});

test("reversed usage is not counted", () => {
  const events = [
    createCostEvent({ ...base, eventId: "u1", sourceEventId: "s1", inputTokens: 100 }),
    createCostEvent({ ...base, eventId: "r1", sourceEventId: "s2", eventType: "reversal", replacesEventId: "u1", inputTokens: 100 }),
  ];
  assert.equal(runQuotaShare(events, "task-1", 1000).tokens, 0);
});
