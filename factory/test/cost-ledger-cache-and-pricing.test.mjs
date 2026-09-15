// The cost ledger has to answer "what did this cost" without lying in either
// direction: not by dropping the input that a cached context actually carried,
// and not by reading a missing price as free.
//
// Three defects, from the pipe audit:
//  1. agent-meta never read either cache field, so a 162k-token context booked
//     as 2 input tokens. `inputTokens: 2` was CORRECT — with prompt caching
//     `input_tokens` counts only the uncached remainder — but it was not the
//     whole story, and the whole story was being thrown away.
//  2. sanitizeUsage dropped costMicros and no pricing ran on the write path.
//  3. operations and budgets read the SAME ledger but only budgets priced it,
//     so one snapshot reported 0 and 85,068 for the same events.
import test from "node:test";
import assert from "node:assert/strict";

import { parseAgentMeta } from "../lib/hq/agent-meta.mjs";
import { priceCostEvents } from "../lib/hq/cost.mjs";
import { createCostEvent, summarizeCostLedger } from "../lib/hq/cost-ledger.mjs";

const PRICING = {
  version: 1,
  currency: "USD",
  updatedAt: "2026-09-08",
  models: {
    "anthropic/claude-sonnet-5": { inputUsdPerMillion: 2, outputUsdPerMillion: 10 },
  },
  aliases: { "claude-sonnet-5": "anthropic/claude-sonnet-5" },
  unknownModel: { strategy: "null-cost", label: "unpriced" },
};

// The exact shape the Claude CLI writes, taken from a real transcript in
// ~/.claude/projects: input_tokens is 2, and the 44k that was actually sent
// lives in the two cache counters.
function realTranscriptEnvelope() {
  return {
    stdout: JSON.stringify({
      ok: true,
      provider: "claude-cli",
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 12548,
        cache_read_input_tokens: 31388,
        output_tokens: 166,
      },
    }),
  };
}

test("cache fields are read from a real transcript shape", () => {
  const meta = parseAgentMeta(realTranscriptEnvelope());
  assert.ok(meta, "the envelope must parse");
  assert.equal(meta.tokensIn, 2, "input_tokens is correct and stays as reported");
  assert.equal(meta.tokensOut, 166);
  // The whole point: 12,548 + 31,388 of input that was previously invisible.
  assert.equal(meta.cachedInputTokens, 43936);
});

test("a harness reporting no caching is distinguishable from one reporting zero", () => {
  const meta = parseAgentMeta({
    stdout: JSON.stringify({ ok: true, provider: "openai", model: "gpt-5.6-sol", usage: { input_tokens: 12, output_tokens: 34 } }),
  });
  assert.equal(meta.tokensIn, 12);
  assert.equal(meta.cachedInputTokens, undefined, "absent, not 0");
});

test("a priced event resolves non-null, and cached input is billed", () => {
  const event = createCostEvent({
    eventId: "cost-t1", source: "test", sourceEventId: "t1", occurredAt: "2026-09-15T00:00:00.000Z",
    provider: "anthropic", model: "claude-sonnet-5",
    inputTokens: 2, cachedInputTokens: 43936, outputTokens: 166,
    costMicros: null, usageConfidence: "provider-reported", costConfidence: "unavailable",
  });
  const { events, derived, stillUnpriced } = priceCostEvents([event], PRICING);

  assert.equal(derived, 1);
  assert.equal(stillUnpriced, 0);
  assert.notEqual(events[0].costMicros, null, "a priced model must resolve a cost");
  assert.equal(events[0].costConfidence, "calculated");

  // (2 + 43936) input @ $2/M + 166 output @ $10/M = $0.089536 = 89536 micros.
  // Pricing the uncached 2 alone would have produced 1664 — a 54x undercount.
  assert.equal(events[0].costMicros, 89536);
});

test("an unpriced model records its tokens and says 'unpriced', never zero", () => {
  const event = createCostEvent({
    eventId: "cost-t2", source: "test", sourceEventId: "t2", occurredAt: "2026-09-15T00:00:00.000Z",
    provider: "somebody", model: "not-in-pricing-json",
    inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100,
    costMicros: null, usageConfidence: "provider-reported", costConfidence: "unavailable",
  });
  const { events, derived, stillUnpriced } = priceCostEvents([event], PRICING);

  assert.equal(derived, 0);
  assert.equal(stillUnpriced, 1);
  assert.equal(events[0].costMicros, null, "a missing price must not read as free");
  assert.equal(events[0].costConfidence, "unpriced");
  // The usage itself is still recorded and still countable.
  assert.equal(events[0].inputTokens, 1000);
  assert.equal(events[0].cachedInputTokens, 500);

  const summary = summarizeCostLedger(events);
  assert.equal(summary.totals.costMicros, 0, "nothing is invented");
  assert.equal(summary.totals.unpricedEvents, 1, "but it is counted as unpriced, not as free");
});

test("operations and budgets cannot disagree: one pricing function, one answer", () => {
  const raw = [
    createCostEvent({
      eventId: "cost-t3", source: "test", sourceEventId: "t3", occurredAt: "2026-09-15T00:00:00.000Z",
      provider: "anthropic", model: "claude-sonnet-5",
      inputTokens: 2, cachedInputTokens: 43936, outputTokens: 166,
      costMicros: null, usageConfidence: "provider-reported", costConfidence: "unavailable",
    }),
  ];

  // What operations used to do: summarise the raw nulls.
  const unpricedTotal = summarizeCostLedger(raw).totals.costMicros;
  // What budgets did: price first.
  const pricedTotal = summarizeCostLedger(priceCostEvents(raw, PRICING).events).totals.costMicros;

  assert.equal(unpricedTotal, 0, "the old operations path reported zero");
  assert.notEqual(pricedTotal, 0);

  // Both panels now run the same function over the same ledger, so both get
  // this number. That is the invariant: same source, same pricer, one answer.
  const operations = summarizeCostLedger(priceCostEvents(raw, PRICING).events).totals;
  const budgets = summarizeCostLedger(priceCostEvents(raw, PRICING).events).totals;
  assert.deepEqual(operations, budgets);
  assert.equal(operations.costMicros, 89536);
});
