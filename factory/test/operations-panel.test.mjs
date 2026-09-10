import test from "node:test";
import assert from "node:assert/strict";
import { operationsPanel } from "../../dashboard/backend/public/lib/operationsView.mjs";

test("renders an honest unavailable state", () => { const html = operationsPanel(null); assert.match(html, /Unavailable/); assert.match(html, /not available/); });
test("renders ownership, queue, liveness, audit, and cost", () => { const html = operationsPanel({ available: true, summary: { activeRuns: 1, leasedTasks: 1, queuedWakeups: 2, deadLetters: 0, inputTokens: 1200, outputTokens: 50 }, tasks: [{ taskId: "task-1", actor: "builder", stage: "builder", liveness: { state: "needs-followup" }, lease: { expiresAt: "2026-09-09T11:00:00Z" } }], audit: [{ occurredAt: "2026-09-09T10:00:00Z", actor: { id: "builder" }, action: "dispatch.running" }] }); assert.match(html, /task-1/); assert.match(html, /needs-followup/); assert.match(html, /dispatch.running/); assert.match(html, /1.3K/); });
test("escapes runtime values and labels degraded data", () => { const html = operationsPanel({ available: false, summary: {}, tasks: [{ taskId: "<script>", actor: "x", status: "active" }], audit: [] }); assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/); assert.match(html, /Degraded/); });
