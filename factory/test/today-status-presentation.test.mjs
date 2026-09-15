import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { groupObjectives, renderObjectiveCard } from "../../dashboard/backend/public/lib/objectiveView.mjs";
import {
  RUNNING_NOW_STATUS,
  buildLiveFloorRows,
  buildRunningNow,
  objectiveActivityLabel,
} from "../../dashboard/backend/public/lib/runningNow.mjs";

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const LONG_OBJECTIVE = Array.from(
  { length: 1_307 },
  (_, index) => `Line ${index + 1} contains a deliberately verbose objective description that must stay out of list headings.`,
).join("\n");

function assertClamped(title) {
  assert.doesNotMatch(title, /[\r\n]/);
  assert.ok(title.length <= 120, `expected a title of at most 120 characters, got ${title.length}`);
}

test("a running objective node contributes one Working row through the shared status mapping", () => {
  const rows = buildRunningNow([{
    objectiveId: "obj-running",
    objective: "Ship the Today panel correction",
    status: "active",
    nodes: [{ id: "obj-running-builder", title: "Implement the correction", status: "running", stage: "builder" }],
  }], [], []);

  assert.equal(rows.filter((row) => row.working).length, 1);
  assert.equal(rows[0].working, RUNNING_NOW_STATUS.running.working);
});

test("the shared mapping covers every status buildRunningNow can emit", () => {
  for (const status of ["running", "blocked", "blocked-by-dep", "active", "blocked"]) {
    assert.ok(Object.hasOwn(RUNNING_NOW_STATUS, status), `missing mapping for ${status}`);
  }
});

test("running, queued and blocked objectives are counted and labelled separately", () => {
  const groups = groupObjectives([
    { objectiveId: "obj-running", lifecycle: "active", status6: "RUNNING" },
    { objectiveId: "obj-queued", lifecycle: "active", status6: "WAITING_FOR_FOUNDER" },
  ]);
  const output = objectiveActivityLabel(groups);

  assert.match(output, /1 running/);
  assert.match(output, /1 queued/);
  assert.doesNotMatch(output, /2 active objectives/);
});

test("Live floor clamps a 1,307-line objective before rendering", () => {
  const [row] = buildLiveFloorRows([{ objective: LONG_OBJECTIVE }], [], []);
  assertClamped(row.title);
});

test("objective-card and task-row builders clamp a 1,307-line objective in data", () => {
  const card = renderObjectiveCard({
    objectiveId: "obj-long",
    objective: LONG_OBJECTIVE,
    status: "active",
    status6: "RUNNING",
    lifecycle: "active",
  }, { esc });
  const cardTitle = /<strong>([^<]*)<\/strong>/.exec(card)?.[1];
  assert.ok(cardTitle, "objective card must render a title");
  assertClamped(cardTitle);

  const [taskRow] = buildRunningNow([], [{
    id: "task-long",
    objective: LONG_OBJECTIVE,
    project: "hq-runtime",
    status: "active",
    stage: "builder",
    updatedAt: new Date().toISOString(),
  }], []);
  assertClamped(taskRow.title);
});

test("Today consumers use derived working state and the shared row builders", () => {
  const source = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");
  assert.match(source, /runningRows\.filter\(\(row\) => row\.working\)/);
  assert.match(source, /buildLiveFloorRows\(liveJobs, autoRecovering, runningRows\)/);
  assert.match(source, /r\.working \? "is-working" : "is-waiting"/);
  assert.doesNotMatch(source, /row\.status === "working"/);
  assert.doesNotMatch(source, /r\.status === "working"/);
});
