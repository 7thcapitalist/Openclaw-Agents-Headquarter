import test from "node:test";
import assert from "node:assert/strict";
import { budgetPanel } from "../../dashboard/backend/public/lib/budgetView.mjs";

const alert = (over = {}) => ({
  policyId: "p1", scopeType: "project", scopeId: "openclaw-factory", window: "calendar-month-utc",
  status: "ok", observedMicros: 1_000_000, limitMicros: 10_000_000, remainingMicros: 9_000_000,
  percent: 10, unpricedEvents: 0, action: "alert-only", message: "Within budget", ...over,
});

const SNAPSHOT = {
  version: 1, available: true, configured: true, enforcement: "alert-only", warnings: [],
  pricing: { version: "2026-09-08", derivedPrices: 15, providerReportedPrices: 0, unpricedEvents: 0 },
  totals: {}, alerts: [alert()], summary: { ok: 1, warning: 0, exceeded: 0, unavailable: 0 },
};

test("renders an honest unavailable state", () => {
  assert.match(budgetPanel(null), /Unavailable/);
});

test("tells the founder how to configure budgets instead of implying zero spend", () => {
  const html = budgetPanel({ ...SNAPSHOT, configured: false, alerts: [], summary: {} });
  assert.match(html, /Not configured/);
  assert.match(html, /factory\/budgets\.json/);
});

test("renders each policy with its scope, window, and spend against the limit", () => {
  const html = budgetPanel(SNAPSHOT);
  assert.match(html, /openclaw-factory/);
  assert.match(html, /calendar-month-utc/);
  assert.match(html, /\$1\.00 of \$10\.00/);
  assert.match(html, /Within budget/);
});

test("the worst policy wins the header — a breach is never averaged away", () => {
  const html = budgetPanel({
    ...SNAPSHOT,
    alerts: [alert(), alert({ policyId: "p2", scopeId: "lifemaxing", status: "exceeded", percent: 140 })],
    summary: { ok: 1, warning: 0, exceeded: 1, unavailable: 0 },
  });
  assert.match(html, /Over budget/);
  assert.match(html, /status-bad/);
});

test("a warning state is distinguishable from healthy", () => {
  const html = budgetPanel({ ...SNAPSHOT, alerts: [alert({ status: "warning", percent: 82 })], summary: { ok: 0, warning: 1, exceeded: 0, unavailable: 0 } });
  assert.match(html, /Approaching limit/);
  assert.match(html, /budget-fill-warning/);
});

test("the panel states out loud that enforcement is alert-only", () => {
  assert.match(budgetPanel(SNAPSHOT), /Alert-only: crossing a limit reports it and stops nothing\./);
});

test("a derived price is never presented as something a provider billed", () => {
  const html = budgetPanel(SNAPSHOT);
  assert.match(html, /15 priced from factory\/pricing\.json \(2026-09-08\)/);
  assert.doesNotMatch(html, /provider-reported/);
});

test("usage nobody can price is called out rather than hidden", () => {
  const html = budgetPanel({ ...SNAPSHOT, pricing: { ...SNAPSHOT.pricing, unpricedEvents: 4 } });
  assert.match(html, /4 with no price at all/);
});

test("degraded cost data is labelled, not presented as fact", () => {
  assert.match(budgetPanel({ ...SNAPSHOT, available: false }), /totals are incomplete/);
});

test("scope identifiers are escaped and the bar width is bounded", () => {
  const html = budgetPanel({
    ...SNAPSHOT,
    alerts: [alert({ scopeId: '"><script>alert(1)</script>', percent: 900 })],
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /style="width:100%"/, "a policy at 900% must not paint a 900%-wide bar");
  assert.match(html, /role="img" aria-label="100 percent of the/);
});

test("a negative percent cannot produce a negative bar", () => {
  assert.match(budgetPanel({ ...SNAPSHOT, alerts: [alert({ percent: -20 })] }), /style="width:0%"/);
});
