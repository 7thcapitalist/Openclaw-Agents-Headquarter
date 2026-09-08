import assert from "node:assert/strict";
import test from "node:test";

import {
  groupObjectives,
  objectiveSummaryLine,
  renderObjectiveCard,
  renderObjectiveHistoryRow,
} from "../../dashboard/backend/public/lib/objectiveView.mjs";

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

const sample = {
  objectiveId: "obj-deadbeef",
  title: "Add Health Endpoint",
  // The raw prompt the presenter collapsed into `title` — must NOT reach the card.
  description:
    "I want a dependency-free health endpoint with tests so that the ops team can monitor uptime, "
    + "and it should also expose build metadata and a very long list of further requirements here.",
  objective: "I want a dependency-free health endpoint with tests so that the ops team can monitor uptime…",
  project: "app",
  status: "active",
  status6: "RUNNING",
  statusLabel: "Running",
  statusTone: "info",
  headline: "1 part building now · 0 of 2 parts done",
  progress: { label: "0 of 2 parts done" },
  nextAction: { label: null },
  builders: ["Backend Builder"],
  nodeBriefs: [
    { title: "Build the endpoint", role: "Backend Builder", status: "RUNNING", stage: "builder", statusLabel: "Running", statusTone: "info" },
  ],
  lifecycle: "active",
  recovery: { count: 0 },
};

test("objective card shows the short human title, never the raw objective prompt", () => {
  const html = renderObjectiveCard(sample, { esc });
  assert.match(html, /Add Health Endpoint/);
  assert.doesNotMatch(html, /dependency-free health endpoint/);
  assert.doesNotMatch(html, /ops team/);
  assert.match(html, /data-objective-details="obj-deadbeef"/);
  assert.match(html, /data-archive-objective="obj-deadbeef"/);
});

test("summary line is compact and title-free: project · status · progress · stage", () => {
  assert.equal(objectiveSummaryLine(sample, { esc }), "app · Running · 0 of 2 parts done · builder");
});

test("summary line falls back to the first builder role when nothing is running", () => {
  const done = { ...sample, status6: "COMPLETE", statusLabel: "Complete", nodeBriefs: [], nextAction: { label: "Open PR" } };
  assert.equal(objectiveSummaryLine(done, { esc }), "app · Complete · 0 of 2 parts done · Backend Builder · next: Open PR");
});

test("groupObjectives splits the four active buckets from history and archived", () => {
  const g = groupObjectives([
    { ...sample, objectiveId: "o1", status6: "RUNNING", lifecycle: "active" },
    { ...sample, objectiveId: "o2", status6: "PENDING", lifecycle: "active" },
    { ...sample, objectiveId: "o3", status6: "WAITING_FOR_FOUNDER", lifecycle: "active" },
    { ...sample, objectiveId: "o4", status6: "BLOCKED", lifecycle: "active" },
    { ...sample, objectiveId: "o5", status6: "FAILED", lifecycle: "active" },
    { ...sample, objectiveId: "o6", status6: "COMPLETE", lifecycle: "active" },
    { ...sample, objectiveId: "o7", status6: "COMPLETE", lifecycle: "history" },
    { ...sample, objectiveId: "o8", status6: "RUNNING", lifecycle: "archived" },
  ]);
  assert.deepEqual(g.running.map((o) => o.objectiveId), ["o1", "o2"]);
  assert.deepEqual(g.waiting.map((o) => o.objectiveId), ["o3"]);
  assert.deepEqual(g.blocked.map((o) => o.objectiveId), ["o4", "o5"]);
  assert.deepEqual(g.recentlyCompleted.map((o) => o.objectiveId), ["o6"]);
  assert.deepEqual(g.history.map((o) => o.objectiveId), ["o7"]);
  assert.deepEqual(g.archived.map((o) => o.objectiveId), ["o8"]);
});

test("archived objective offers Unarchive, not Archive", () => {
  const html = renderObjectiveCard({ ...sample, lifecycle: "archived" }, { esc });
  assert.match(html, /data-unarchive-objective="obj-deadbeef"/);
  assert.doesNotMatch(html, /data-archive-objective/);
  const row = renderObjectiveHistoryRow({ ...sample, lifecycle: "archived" }, { esc });
  assert.match(row, /data-unarchive-objective="obj-deadbeef"/);
  assert.doesNotMatch(row, /data-archive-objective/);
});

test("invalid objective renders without throwing", () => {
  const html = renderObjectiveCard({ objectiveId: "obj-bad", status: "invalid", error: "boom" }, { esc });
  assert.match(html, /obj-bad/);
  assert.match(html, /boom/);
});
