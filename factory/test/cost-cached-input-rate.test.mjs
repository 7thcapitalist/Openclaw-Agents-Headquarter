// Cached input has its own, much cheaper rate on every provider that offers
// one. The pricer used to fold cached tokens into the input rate, which for
// this factory is not a rounding error: a measurement of five days of real
// agent traffic (2026-09-09..09-14) found ~99% of all input tokens were cache
// reads, so the fold overstated every stage by close to 10x.
//
// It also had no entry for claude-opus-5 at all, so half the Claude traffic
// priced as `unpriced` — a floor the cost panel showed as if it were a total.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";

import { loadPricing, priceCostEvents, priceUsage } from "../lib/hq/cost.mjs";
import { summarizeCostLedger } from "../lib/hq/cost-ledger.mjs";

const HQ_ROOT = join(import.meta.dirname, "..", "..");

function usageEvent(overrides = {}) {
  return {
    version: 1,
    eventId: overrides.eventId || "cost:test-1",
    eventType: "usage",
    source: "openclaw-factory",
    sourceEventId: overrides.eventId || "test-1",
    replacesEventId: null,
    occurredAt: "2026-09-12T00:00:00.000Z",
    recordedAt: "2026-09-12T00:00:00.000Z",
    provider: "anthropic",
    model: "claude-sonnet-5",
    inputTokens: 1_000,
    cachedInputTokens: 1_000_000,
    outputTokens: 1_000,
    costMicros: null,
    currency: "USD",
    pricingVersion: null,
    usageConfidence: "provider-reported",
    costConfidence: "unavailable",
    agentId: "reviewer",
    projectId: "hq",
    objectiveId: null,
    taskId: "t-1",
    stage: "reviewer",
    runId: "r-1",
    dispatchId: "d-1",
    ...overrides,
  };
}

test("cached input is billed at the cached rate, not the input rate", () => {
  const pricing = loadPricing(HQ_ROOT);
  const { events, stillUnpriced } = priceCostEvents([usageEvent()], pricing);
  assert.equal(stillUnpriced, 0);

  // 1,000 fresh @ $2/M + 1,000,000 cached @ $0.20/M + 1,000 out @ $10/M
  //   = 0.002 + 0.20 + 0.01 = $0.212
  assert.equal(events[0].costMicros, 212_000);
  assert.equal(events[0].costConfidence, "calculated");

  // The old behaviour folded cached into input: (1,001,000 @ $2/M) + out
  //   = 2.002 + 0.01 = $2.012. Guard against a regression to it.
  assert.notEqual(events[0].costMicros, 2_012_000);
});

test("claude-opus-5 is priced, and at its own rate rather than Sonnet's", () => {
  const pricing = loadPricing(HQ_ROOT);
  const { events, stillUnpriced } = priceCostEvents(
    [usageEvent({ eventId: "cost:test-opus", model: "claude-opus-5" })],
    pricing,
  );
  assert.equal(stillUnpriced, 0, "claude-opus-5 must not fall through to unpriced");

  // 1,000 @ $5/M + 1,000,000 @ $0.50/M + 1,000 @ $25/M = 0.005 + 0.50 + 0.025
  assert.equal(events[0].costMicros, 530_000);
});

test("the claude-cli provider spelling resolves to the same Anthropic prices", () => {
  const pricing = loadPricing(HQ_ROOT);
  const { stillUnpriced } = priceCostEvents(
    [usageEvent({ eventId: "cost:test-cli", provider: "claude-cli", model: "claude-opus-5" })],
    pricing,
  );
  assert.equal(stillUnpriced, 0, "the live ledger records provider `claude-cli`, not `anthropic`");
});

test("a model with no cached rate still bills cached input at the input rate", () => {
  // The fallback is deliberate: an unresearched model must not get a cheaper
  // bill than it has earned just because nobody looked its cache rate up.
  const pricing = {
    version: 1,
    currency: "USD",
    updatedAt: "2026-09-15",
    models: { "anthropic/claude-sonnet-5": { inputUsdPerMillion: 2, outputUsdPerMillion: 10 } },
    aliases: { "claude-sonnet-5": "anthropic/claude-sonnet-5" },
    unknownModel: { strategy: "null-cost", label: "unpriced" },
  };
  const { events } = priceCostEvents([usageEvent()], pricing);
  assert.equal(events[0].costMicros, 2_012_000);
});

test("an unknown model stays unpriced rather than reading as free", () => {
  const pricing = loadPricing(HQ_ROOT);
  const { events, stillUnpriced } = priceCostEvents(
    [usageEvent({ eventId: "cost:test-unknown", provider: "github-copilot", model: "gpt-4.1" })],
    pricing,
  );
  assert.equal(stillUnpriced, 1);
  assert.equal(events[0].costMicros, null);
  assert.equal(events[0].costConfidence, "unpriced");

  const summary = summarizeCostLedger(events);
  assert.equal(summary.totals.unpricedEvents, 1);
  assert.equal(summary.totals.costMicros, 0, "unpriced spend must not inflate the total either");
});

test("every model in the shipped pricing table carries a source URL", () => {
  const raw = JSON.parse(readFileSync(join(HQ_ROOT, "factory", "pricing.json"), "utf8"));
  for (const [key, entry] of Object.entries(raw.models)) {
    assert.match(entry.source || "", /^https:\/\//, `${key} needs a source URL`);
    assert.ok(
      entry.cachedInputUsdPerMillion == null
        || entry.cachedInputUsdPerMillion < entry.inputUsdPerMillion,
      `${key} cached rate must be below its input rate`,
    );
  }
});

test("priceUsage leaves callers that pass no cached tokens unchanged", () => {
  const pricing = loadPricing(HQ_ROOT);
  const quote = priceUsage(
    { provider: "anthropic", model: "claude-sonnet-5", tokensIn: 1_000_000, tokensOut: 0 },
    pricing,
  );
  assert.equal(quote.costUsd, 2);
  assert.equal(quote.cachedTokensIn, 0);
});
