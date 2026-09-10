import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildBudgetSnapshot, priceCostEvents } from "../lib/hq/budget-snapshot.mjs";
import { readPolicyRegistry } from "../lib/hq/budget-policies.mjs";
import { createCostEvent } from "../lib/hq/cost-ledger.mjs";
import { normalizePricing } from "../lib/hq/cost.mjs";

const PRICING = normalizePricing({
  version: 1, currency: "USD", updatedAt: "2026-09-08",
  models: { "openai/gpt-5.6-sol": { provider: "openai", model: "gpt-5.6-sol", inputUsdPerMillion: 4, outputUsdPerMillion: 20 } },
});

const usage = (over = {}) => createCostEvent({
  eventId: over.eventId || "cost:a", source: "openclaw-factory", sourceEventId: over.sourceEventId || "a",
  occurredAt: over.occurredAt || "2026-09-10T03:40:00.000Z",
  provider: over.provider ?? "openai", model: over.model ?? "gpt-5.6-sol",
  inputTokens: over.inputTokens ?? 1_000_000, outputTokens: over.outputTokens ?? 0,
  costMicros: over.costMicros ?? null, projectId: over.projectId ?? "hq", agentId: over.agentId ?? "builder",
});

function fixture(policies, events = []) {
  const root = mkdtempSync(join(tmpdir(), "hq-budgets-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "pricing.json"), JSON.stringify({
    version: 1, currency: "USD", updatedAt: "2026-09-08",
    models: { "openai/gpt-5.6-sol": { provider: "openai", model: "gpt-5.6-sol", inputUsdPerMillion: 4, outputUsdPerMillion: 20 } },
  }));
  if (policies) writeFileSync(join(root, "factory", "budgets.json"), JSON.stringify({ version: 1, policies }));
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""));
  return { root, ledgerPath };
}

// --- the point of this change ------------------------------------------------
// Every event the live ledger holds has costMicros: null, because no OpenClaw
// adapter reports a price. Budget evaluation over that could only ever answer
// "unavailable" — the feature reported nothing about real spend.

test("an event the provider did not price is priced from the tracked pricing table", () => {
  const { events, derived, stillUnpriced } = priceCostEvents([usage()], PRICING);
  assert.equal(derived, 1);
  assert.equal(stillUnpriced, 0);
  assert.equal(events[0].costMicros, 4_000_000, "1M input tokens at $4/M is $4.00");
  assert.equal(events[0].costConfidence, "calculated", "a derived price is never labelled provider-reported");
  assert.equal(events[0].pricingVersion, "2026-09-08");
});

test("a provider-reported price always wins over a derived one", () => {
  const { events, derived } = priceCostEvents([usage({ costMicros: 12 })], PRICING);
  assert.equal(derived, 0);
  assert.equal(events[0].costMicros, 12);
  assert.equal(events[0].costConfidence, "provider-reported");
});

test("a model absent from the pricing table stays unpriced rather than counting as zero", () => {
  const { events, derived, stillUnpriced } = priceCostEvents([usage({ model: "some-unlisted-model" })], PRICING);
  assert.equal(derived, 0);
  assert.equal(stillUnpriced, 1);
  assert.equal(events[0].costMicros, null);
  assert.equal(events[0].costConfidence, "unavailable");
});

test("pricing at read time never rewrites the append-only ledger", () => {
  const original = usage();
  const snapshot = JSON.stringify(original);
  priceCostEvents([original], PRICING);
  assert.equal(JSON.stringify(original), snapshot, "the source event object is not mutated");
});

// --- snapshot ----------------------------------------------------------------

test("policies are evaluated against derived prices and reported per scope", () => {
  const { root, ledgerPath } = fixture([
    { id: "p1", scopeType: "project", scopeId: "hq", window: "lifetime", limitMicros: 10_000_000, warnPercent: 30 },
  ], [usage()]);
  const snapshot = buildBudgetSnapshot({ root, hqRoot: root, ledgerPath });
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.enforcement, "alert-only");
  assert.equal(snapshot.pricing.derivedPrices, 1);
  assert.equal(snapshot.alerts[0].observedMicros, 4_000_000);
  assert.equal(snapshot.alerts[0].status, "warning", "40% of the limit is past a 30% warning threshold");
});

test("exceeding a limit reports and never changes enforcement", () => {
  const { root, ledgerPath } = fixture([
    { id: "p1", scopeType: "project", scopeId: "hq", window: "lifetime", limitMicros: 1_000_000 },
  ], [usage()]);
  const snapshot = buildBudgetSnapshot({ hqRoot: root, ledgerPath });
  assert.equal(snapshot.alerts[0].status, "exceeded");
  assert.equal(snapshot.alerts[0].action, "alert-only");
  assert.equal(snapshot.enforcement, "alert-only");
});

test("spend outside a policy's scope is not counted against it", () => {
  const { root, ledgerPath } = fixture([
    { id: "p1", scopeType: "project", scopeId: "hq", window: "lifetime", limitMicros: 10_000_000 },
  ], [usage({ projectId: "elsewhere" })]);
  assert.equal(buildBudgetSnapshot({ hqRoot: root, ledgerPath }).alerts[0].observedMicros, 0);
});

test("usage no one can price is 'unavailable', never a reassuring zero", () => {
  const { root, ledgerPath } = fixture([
    { id: "p1", scopeType: "project", scopeId: "hq", window: "lifetime", limitMicros: 10_000_000 },
  ], [usage({ model: "some-unlisted-model" })]);
  const snapshot = buildBudgetSnapshot({ hqRoot: root, ledgerPath });
  assert.equal(snapshot.alerts[0].status, "unavailable");
  assert.equal(snapshot.available, false);
  assert.match(snapshot.warnings.join(" "), /no provider price and no entry in factory\/pricing\.json/);
});

// --- degraded and negative behaviour ----------------------------------------

test("no registry reports unconfigured without failing", () => {
  const { root, ledgerPath } = fixture(null, [usage()]);
  const snapshot = buildBudgetSnapshot({ hqRoot: root, ledgerPath });
  assert.equal(snapshot.configured, false);
  assert.deepEqual(snapshot.alerts, []);
  assert.equal(snapshot.available, true);
});

test("a corrupt ledger degrades the view, it does not throw", () => {
  const { root, ledgerPath } = fixture([{ id: "p1", scopeType: "company", scopeId: "co", window: "lifetime", limitMicros: 1_000 }]);
  writeFileSync(ledgerPath, "{ truncated\n");
  const snapshot = buildBudgetSnapshot({ hqRoot: root, ledgerPath });
  assert.equal(snapshot.available, false);
  assert.match(snapshot.warnings.join(" "), /cost ledger unavailable/);
  assert.equal(snapshot.alerts.length, 1, "policies still evaluate against what could be read");
});

test("an invalid policy registry is rejected, not partially applied", () => {
  for (const [policies, pattern] of [
    [[{ id: "p1", scopeType: "galaxy", scopeId: "x", window: "lifetime", limitMicros: 1 }], /scopeType is invalid/],
    [[{ id: "p1", scopeType: "company", scopeId: "x", window: "forever", limitMicros: 1 }], /window is invalid/],
    [[{ id: "p1", scopeType: "company", scopeId: "x", window: "lifetime", limitMicros: 0 }], /limitMicros is invalid/],
    [[{ id: "p1", scopeType: "company", scopeId: "x", window: "lifetime", limitMicros: 1, warnPercent: 0 }], /warnPercent is invalid/],
    [[{ id: "../escape", scopeType: "company", scopeId: "x", window: "lifetime", limitMicros: 1 }], /policy.id is invalid/],
  ]) {
    const { root } = fixture(policies);
    assert.throws(() => readPolicyRegistry(root), pattern);
  }
});

test("a duplicate policy id is rejected", () => {
  const policy = { id: "p1", scopeType: "company", scopeId: "x", window: "lifetime", limitMicros: 1_000 };
  const { root } = fixture([policy, policy]);
  assert.throws(() => readPolicyRegistry(root), /duplicate budget policy/);
});

test("a malformed registry file is rejected with a usable message", () => {
  const { root } = fixture([]);
  writeFileSync(join(root, "factory", "budgets.json"), "{ nope");
  assert.throws(() => readPolicyRegistry(root), /not valid JSON/);
  writeFileSync(join(root, "factory", "budgets.json"), JSON.stringify({ version: 1 }));
  assert.throws(() => readPolicyRegistry(root), /'policies' array/);
});

test("the tracked HQ budget registry is valid", () => {
  const registry = readPolicyRegistry(new URL("../..", import.meta.url).pathname);
  assert.equal(registry.present, true);
  assert.ok(registry.policies.length > 0);
});
