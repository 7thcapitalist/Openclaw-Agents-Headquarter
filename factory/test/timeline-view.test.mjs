import test from "node:test";
import assert from "node:assert/strict";
import { runTimelineSection } from "../../dashboard/backend/public/lib/timelineView.mjs";

const entry = (over = {}) => ({ at: "2026-09-10T00:03:00Z", source: "audit", kind: "dispatch.running", actor: "codex", stage: "builder", detail: "outcome=pass", ...over });

const timeline = (over = {}) => ({
  version: 1, taskId: "obj-abc-node", available: true,
  sources: [
    { name: "workflow", available: true, present: true },
    { name: "audit", available: true, present: true },
    { name: "liveness", available: true, present: false, reason: "not recorded for this task" },
    { name: "lease", available: true, present: false, reason: "not recorded for this task" },
    { name: "wakeups", available: true, present: false, reason: "not recorded for this task" },
    { name: "cost", available: true, present: true },
    { name: "graph", available: true, present: false, reason: "not recorded for this task" },
  ],
  task: { outcome: "Ship it", project: "hq", status: "active" },
  ownership: null, cost: { inputTokens: 100, outputTokens: 50, events: 2, unpricedEvents: 0 },
  evidence: [{ stage: "product", path: "evidence/product.md" }],
  counts: { workflow: 2, audit: 1 }, truncated: false,
  entries: [entry({ source: "workflow", kind: "task-created", actor: null, detail: null }), entry()],
  ...over,
});

test("a missing timeline is stated, not blank", () => {
  assert.match(runTimelineSection(null), /No unified timeline is available/);
});

test("entries render newest first with their source named", () => {
  const html = runTimelineSection(timeline());
  assert.match(html, /dispatch\.running/);
  assert.match(html, /task-created/);
  assert.ok(html.indexOf("dispatch.running") < html.indexOf("task-created"), "newest first");
  assert.match(html, /class="timeline-source is-present">audit/);
});

test("every layer is shown, including the ones that recorded nothing", () => {
  const html = runTimelineSection(timeline());
  for (const label of ["workflow", "audit", "liveness", "ownership", "wakeup", "cost", "graph"]) {
    assert.match(html, new RegExp(`>${label}`), `${label} must be visible even when empty`);
  }
  assert.match(html, /is-absent/);
  assert.match(html, /recorded nothing for this run/);
});

test("a layer that contributes totals rather than entries shows no count", () => {
  // `cost` is summarised in the footer, so a "cost 0" chip would read as a
  // broken counter rather than "no entries by design".
  const html = runTimelineSection(timeline());
  assert.doesNotMatch(html, />cost 0/);
  assert.match(html, />audit 1/, "a layer that does contribute entries still shows its count");
});

test("a broken source makes the incompleteness explicit", () => {
  const html = runTimelineSection(timeline({
    available: false,
    sources: [{ name: "audit", available: false, present: true, reason: "Invalid audit line 3" }],
  }));
  assert.match(html, /could not be read/);
  assert.match(html, /Invalid audit line 3/);
  assert.match(html, /timeline is incomplete/);
  assert.match(html, /is-broken/);
});

test("truncation is disclosed", () => {
  assert.match(runTimelineSection(timeline({ truncated: true })), /Older entries are not shown/);
});

test("cost, ownership and evidence paths appear in the footer", () => {
  const html = runTimelineSection(timeline({ ownership: { actorId: "codex", expiresAt: "2026-09-10T01:00:00Z" } }));
  assert.match(html, /owned by <strong>codex<\/strong>/);
  assert.match(html, /150 tokens over 2 recorded call\(s\)/);
  assert.match(html, /<code>evidence\/product\.md<\/code>/);
});

test("an empty run says so rather than rendering nothing", () => {
  assert.match(runTimelineSection(timeline({ entries: [], counts: {} })), /Nothing has been recorded for this run yet/);
});

test("kinds, actors, details and evidence paths are escaped", () => {
  const html = runTimelineSection(timeline({
    entries: [entry({ kind: "<script>alert(1)</script>", actor: "<img src=x>", detail: "\"><b>bad</b>" })],
    evidence: [{ stage: "x", path: "<script>evil</script>" }],
  }));
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;script&gt;/);
});
