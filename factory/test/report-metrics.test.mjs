import test from "node:test";
import assert from "node:assert/strict";
import { computeReportMetrics } from "../lib/hq/report/metrics.mjs";

test("unavailable inputs produce null with reasons, never synthetic zeroes", () => {
  const metrics = computeReportMetrics({
    objectiveIssues: [{ path: "factory/acme/objectives/obj/objective-state.sqlite", reason: "malformed" }],
    resultIssues: [], objectives: [], dispatches: [],
  });
  assert.ok(metrics.length > 0);
  for (const metric of metrics) {
    assert.equal(metric.value, null, metric.id);
    assert.equal(typeof metric.reason, "string", metric.id);
    assert.ok(metric.reason.length > 0, metric.id);
  }
});

test("a measured zero interruption count remains zero when a merged-task denominator exists", () => {
  const metrics = computeReportMetrics({
    objectives: [{
      path: "objective-state.sqlite", status: "complete", createdAt: "2026-01-01T00:00:00Z",
      events: [{ type: "objective-finished", at: "2026-01-01T01:00:00Z" }],
      nodes: [{ id: "task-1", status: "gate-satisfied", attempts: 1, startedAt: "2026-01-01T00:00:00Z" }],
    }],
    dispatches: [{ taskId: "task-1", stage: "product", attempt: 1, path: "result.json", content: "pass", mtimeMs: Date.parse("2026-01-01T00:01:00Z") }],
  });
  assert.equal(metrics.find((metric) => metric.id === "founder-interruptions.infra").value, 0);
  assert.equal(metrics.find((metric) => metric.id === "founder-interruptions.product").value, 0);
});
