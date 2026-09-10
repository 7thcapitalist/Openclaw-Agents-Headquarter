import test from "node:test"; import assert from "node:assert/strict"; import { createCostEvent } from "../lib/hq/cost-ledger.mjs"; import { evaluateBudgetAlerts } from "../lib/hq/budget-alerts.mjs";
const event = (id, costMicros, extra = {}) => createCostEvent({ eventId: id, source: "test", sourceEventId: id, occurredAt: extra.occurredAt || "2026-09-09T10:00:00Z", provider: "openai", model: "gpt", inputTokens: 1, outputTokens: 1, costMicros, projectId: extra.projectId || "hq", agentId: extra.agentId || "builder" }, { now: () => "2026-09-09T10:00:00Z", id: () => id });
test("reports ok, warning, and exceeded without enforcement", () => { const events = [event("a", 600), event("b", 250)]; const policies = [{ id: "low", scopeType: "company", scopeId: "hq", window: "lifetime", limitMicros: 2000, warnPercent: 80 }, { id: "warn", scopeType: "project", scopeId: "hq", window: "lifetime", limitMicros: 1000, warnPercent: 80 }, { id: "stop", scopeType: "agent", scopeId: "builder", window: "lifetime", limitMicros: 800 }]; const value = evaluateBudgetAlerts({ policies, events }); assert.deepEqual(value.alerts.map((a) => a.status), ["ok", "warning", "exceeded"]); assert.ok(value.alerts.every((a) => a.action === "alert-only")); });
test("calendar window and scopes exclude unrelated cost", () => { const value = evaluateBudgetAlerts({ now: "2026-09-09T00:00:00Z", policies: [{ id: "p", scopeType: "project", scopeId: "hq", window: "calendar-month-utc", limitMicros: 1000 }], events: [event("current", 100), event("old", 900, { occurredAt: "2026-08-01T00:00:00Z" }), event("other", 900, { projectId: "other" })] }); assert.equal(value.alerts[0].observedMicros, 100); });
test("unpriced usage remains visible", () => { const value = evaluateBudgetAlerts({ policies: [{ id: "p", scopeType: "company", scopeId: "hq", window: "lifetime", limitMicros: 1000 }], events: [event("u", null)] }); assert.equal(value.alerts[0].unpricedEvents, 1); assert.match(value.alerts[0].message, /unpriced/); });
test("invalid policy fails closed", () => { assert.throws(() => evaluateBudgetAlerts({ policies: [{ id: "p", scopeType: "company", scopeId: "hq", window: "lifetime", limitMicros: 0 }], events: [] }), /limitMicros/); });

// ── the alert must never be falsely reassuring ───────────────────────────────

test("spend that is entirely unpriced reports unavailable, not a healthy budget", () => {
  // `unpricedEvents` counts a subset of `events`, so the original
  // `unpriced && !events` test could never be true: a scope whose whole spend
  // was unpriced reported `ok` at 0 micros — a confident all-clear derived from
  // data that says nothing about cost.
  const value = evaluateBudgetAlerts({
    policies: [{ id: "p", scopeType: "company", scopeId: "hq", window: "lifetime", limitMicros: 1000 }],
    events: [event("u1", null), event("u2", null)],
  });
  assert.equal(value.alerts[0].status, "unavailable");
  assert.equal(value.summary.unavailable, 1);
  // Partial pricing is still evaluable — only a total absence is unavailable.
  const mixed = evaluateBudgetAlerts({
    policies: [{ id: "p", scopeType: "company", scopeId: "hq", window: "lifetime", limitMicros: 1000 }],
    events: [event("priced", 100), event("u", null)],
  });
  assert.equal(mixed.alerts[0].status, "ok");
  assert.equal(mixed.alerts[0].unpricedEvents, 1);
});

test("calendar-month-utc is evaluated in UTC, not by string prefix", () => {
  // 2026-09-30T21:00:00-05:00 is 2026-10-01T02:00Z. Comparing the raw string's
  // first seven characters put it in September and missed it in October —
  // wrong in both directions, and silently so.
  const policy = { id: "p", scopeType: "project", scopeId: "hq", window: "calendar-month-utc", limitMicros: 1000000 };
  const offset = event("o", 500000, { occurredAt: "2026-09-30T21:00:00-05:00" });
  assert.equal(evaluateBudgetAlerts({ policies: [policy], events: [offset], now: "2026-10-05T00:00:00Z" }).alerts[0].observedMicros, 500000,
    "the event belongs to October in UTC");
  assert.equal(evaluateBudgetAlerts({ policies: [policy], events: [offset], now: "2026-09-20T00:00:00Z" }).alerts[0].observedMicros, 0,
    "and must not also be counted in September");
});

test("malformed input fails closed rather than throwing a TypeError deep inside", () => {
  const policies = [{ id: "p", scopeType: "company", scopeId: "hq", window: "lifetime", limitMicros: 1000 }];
  assert.throws(() => evaluateBudgetAlerts({ policies }), /events must be an array/);
  assert.throws(() => evaluateBudgetAlerts({ policies, events: [], now: new Date() }), /now must be/);
});
