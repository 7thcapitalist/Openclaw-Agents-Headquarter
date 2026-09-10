import test from "node:test";
import assert from "node:assert/strict";
import { operationsPanel } from "../../dashboard/backend/public/lib/operationsView.mjs";

test("renders an honest unavailable state", () => { const html = operationsPanel(null); assert.match(html, /Unavailable/); assert.match(html, /not available/); });
test("renders ownership, queue, liveness, audit, and cost", () => { const html = operationsPanel({ available: true, summary: { activeRuns: 1, leasedTasks: 1, queuedWakeups: 2, deadLetters: 0, inputTokens: 1200, outputTokens: 50 }, tasks: [{ taskId: "task-1", actor: "builder", stage: "builder", liveness: { state: "needs-followup" }, lease: { expiresAt: "2026-09-09T11:00:00Z" } }], audit: [{ occurredAt: "2026-09-09T10:00:00Z", actor: { id: "builder" }, action: "dispatch.running" }] }); assert.match(html, /task-1/); assert.match(html, /needs-followup/); assert.match(html, /dispatch.running/); assert.match(html, /1.3K/); });
test("escapes runtime values and labels degraded data", () => { const html = operationsPanel({ available: false, summary: {}, tasks: [{ taskId: "<script>", actor: "x", status: "active" }], audit: [] }); assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/); assert.match(html, /Degraded/); });

test("objective graphs needing attention are named, with their stranded nodes", () => {
  const html = operationsPanel({
    available: true, summary: { unhealthyObjectives: 1, strandedNodes: 2 }, tasks: [], audit: [],
    objectives: [
      { objectiveId: "obj-healthy", healthy: true, findings: [], strandedNodeIds: [] },
      { objectiveId: "obj-stuck", healthy: false, findings: [{ severity: "high", code: "blocked-subtree", message: "x", nodeIds: [] }], strandedNodeIds: ["n1", "n2"] },
    ],
  });
  assert.match(html, /Objective graphs needing attention/);
  assert.match(html, /obj-stuck/);
  assert.match(html, /blocked-subtree/);
  assert.match(html, /2 stranded/);
  assert.doesNotMatch(html, /obj-healthy/, "a healthy graph is not noise in the attention list");
});

test("a snapshot with no graph health omits the section rather than claiming health", () => {
  const html = operationsPanel({ available: true, summary: {}, tasks: [], audit: [] });
  assert.doesNotMatch(html, /Objective graphs needing attention/);
});

test("objective identifiers and finding codes are escaped", () => {
  const html = operationsPanel({
    available: true, summary: {}, tasks: [], audit: [],
    objectives: [{ objectiveId: "<img src=x>", healthy: false, findings: [{ code: "<script>" }], strandedNodeIds: [] }],
  });
  assert.doesNotMatch(html, /<img src=x>/);
  assert.doesNotMatch(html, /<script>/);
});
