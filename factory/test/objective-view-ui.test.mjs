import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  groupObjectives,
  objectiveSummaryLine,
  renderObjectiveCard,
  renderObjectiveHistoryRow,
  shortObjectiveTitle,
  whatIsHappeningNowLine,
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
    { title: "Build the endpoint", role: "Backend Builder", status: "RUNNING", stage: "builder", stageLabel: "Building", elapsedMs: 12 * 60_000, statusLabel: "Running", statusTone: "info" },
  ],
  lifecycle: "active",
  recovery: { count: 0 },
};

test("the live objective line names stage, role, elapsed time, and founder action", () => {
  const fmtDuration = (ms) => `${ms / 60_000}m`;
  assert.equal(
    whatIsHappeningNowLine(sample, { fmtDuration }),
    "Building — Backend Builder is working — 12m so far. Nothing needed from you.",
  );
  assert.equal(
    whatIsHappeningNowLine({ ...sample, status6: "WAITING_FOR_FOUNDER", nodeBriefs: [{ ...sample.nodeBriefs[0], status: "WAITING_FOR_FOUNDER", role: "Reviewer", stageLabel: "Independent review" }] }, { fmtDuration }),
    "Independent review — Reviewer is waiting on you — 12m so far. Your action is needed.",
  );
  assert.equal(
    whatIsHappeningNowLine({ ...sample, status6: "RECOVERING", nodeBriefs: [{ ...sample.nodeBriefs[0], status: "RECOVERING", role: "QA", stageLabel: "Quality check", elapsedMs: 4 * 60_000 }] }, { fmtDuration }),
    "Quality check — QA is recovering automatically — 4m so far. Nothing needed from you.",
  );
});

test("objective card shows the short human title, never the raw objective prompt", () => {
  const html = renderObjectiveCard(sample, { esc, fmtDuration: (ms) => `${ms / 60_000}m` });
  assert.match(html, /Add Health Endpoint/);
  assert.doesNotMatch(html, /dependency-free health endpoint/);
  assert.doesNotMatch(html, /ops team/);
  assert.match(html, /data-objective-details="obj-deadbeef"/);
  assert.match(html, /data-archive-objective="obj-deadbeef"/);
  assert.match(html, /What is happening now:/);
  assert.match(html, /Building — Backend Builder is working — 12m so far\. Nothing needed from you\./);
});

test("shortObjectiveTitle collapses legacy long prompts for founder surfaces", () => {
  const title = shortObjectiveTitle("Build a calm founder command center so the founder can understand what the factory is doing without reading raw JSON or logs.");
  assert.equal(title, "Build a calm founder command center");
  assert.ok(title.length <= 72);
  assert.equal(shortObjectiveTitle(""), "Untitled objective");
});

test("shortObjectiveTitle removes prompt labels and keeps the first line", () => {
  assert.equal(
    shortObjectiveTitle("MISSION: TRANSFORM LIFEMAXING INTO A REAL-LIFE GAME\nThis is not merely a UI redesign."),
    "TRANSFORM LIFEMAXING INTO A REAL-LIFE GAME",
  );
});

test("live execution headings never render the original prompt", () => {
  const app = readFileSync(join(import.meta.dirname, "../../dashboard/backend/public/app.js"), "utf8");
  assert.match(app, /const title = objectiveView\.shortObjectiveTitle\(x\.title \|\| x\.objective/);
  assert.doesNotMatch(app, /operation-original-request/);
});

test("objective cards fall back to a compact title when the presenter title is missing", () => {
  const html = renderObjectiveCard({ ...sample, title: "", objective: "Implement a much better operational experience for the founder with detailed observability." }, { esc });
  assert.match(html, /Implement a much better operational experience/);
  assert.doesNotMatch(html, /detailed observability/);
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
