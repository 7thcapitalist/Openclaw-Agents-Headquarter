// The words the founder reads. One source, both consoles.
//
// A2: never render "product" or "release" as a stage name again.
// A3: nothing is named by its id.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  STAGES, STAGE_LABEL, deslug, stageLabel, stageStatusLabel,
  taskOutcomeLine, taskStatusLabel, taskTitle, titleIsFallback,
} from "../../control-plane/public/stage-vocabulary.mjs";

test("every pipeline stage has a plain-language label", () => {
  assert.deepEqual(STAGES, ["product", "architect", "builder", "reviewer", "qa", "security", "release"]);
  assert.equal(stageLabel("product"), "Shaping the outcome");
  assert.equal(stageLabel("architect"), "Designing the approach");
  assert.equal(stageLabel("builder"), "Building");
  assert.equal(stageLabel("reviewer"), "Independent review");
  assert.equal(stageLabel("qa"), "Quality check");
  assert.equal(stageLabel("security"), "Security check");
  assert.equal(stageLabel("release"), "Preparing delivery");
  // No raw key is ever the answer.
  for (const stage of STAGES) assert.notEqual(stageLabel(stage), stage);
});

test("an unknown stage is de-slugged, never shown raw", () => {
  assert.equal(stageLabel("new-gate"), "New gate");
  assert.equal(stageLabel(null), "Not started");
});

test("the local dashboard uses the shared source rather than its own copy", () => {
  // The literal map used to live inline in app.js, which is how the two
  // consoles came to disagree. It must not come back.
  const app = readFileSync("dashboard/backend/public/app.js", "utf8");
  assert.match(app, /from "\/lib\/stage-vocabulary\.mjs"/, "app.js must import the shared vocabulary");
  assert.doesNotMatch(app, /product:\s*"Shaping the outcome"/, "the inline copy must be gone");

  // And the dashboard must actually serve the one physical file.
  const server = readFileSync("dashboard/backend/server.mjs", "utf8");
  assert.match(server, /\/lib\/stage-vocabulary\.mjs/);
  assert.match(server, /control-plane".*"public".*"stage-vocabulary\.mjs"/s);
});

test("a task is titled by its outcome, never by its id", () => {
  assert.equal(
    taskTitle({ outcome: "Rebuild the LifeMax frontend as a mobile-first RPG.", taskId: "obj-c58897c0-game-frontend" }),
    "Rebuild the LifeMax frontend as a mobile-first RPG.",
  );
  // A paragraph is cut to its first sentence, not dumped whole.
  assert.equal(
    taskTitle({ outcome: "Ship the thing. Then do more. And more again." }),
    "Ship the thing.",
  );
});

test("with no outcome the slug is de-slugged — the raw id is never the title", () => {
  const title = taskTitle({ taskId: "obj-c58897c0-game-backend" });
  assert.equal(title, "Game backend");
  assert.ok(!title.includes("obj-"), "the id hash must not survive into a title");
  assert.ok(!title.includes("c58897c0"));
});

test("a task with nothing human says so, rather than falling back to the id", () => {
  // Reaching this is a publisher bug to fix, not something to paper over.
  assert.equal(taskTitle({ taskId: "obj-abc123def" }), "Untitled task");
  assert.equal(taskTitle({}), "Untitled task");
  assert.equal(titleIsFallback({ outcome: "" }), true);
  assert.equal(titleIsFallback({ outcome: "Ship it." }), false);
});

test("'failed at —' is gone: an unreached stage says so in words", () => {
  assert.equal(taskOutcomeLine({ status: "failed", stage: null }), "Failed before it started");
  assert.equal(taskOutcomeLine({ status: "failed", stage: "qa" }), "Failed at quality check");
  assert.equal(taskOutcomeLine({ status: "blocked", stage: "product" }), "Blocked at shaping the outcome");
  assert.equal(taskOutcomeLine({ status: "blocked", stage: null }), "Blocked before it started");
  assert.equal(taskOutcomeLine({ status: "merged" }), "Delivered");
  // Nothing renders an em dash as an explanation.
  for (const status of ["failed", "blocked", "active", "merged", "merge-ready", "weird"]) {
    assert.doesNotMatch(taskOutcomeLine({ status, stage: null }), /—/);
  }
});

test("statuses read as words, not as keys", () => {
  assert.equal(taskStatusLabel("merge-ready"), "Ready to merge");
  assert.equal(taskStatusLabel("merged"), "Done");
  assert.equal(stageStatusLabel("decision-required"), "waiting on you");
  assert.equal(stageStatusLabel("pass"), "complete");
});

test("deslug leaves nothing to chance", () => {
  assert.equal(deslug("control-plane-app-shell"), "Control plane app shell");
  assert.equal(deslug(""), "");
  assert.equal(deslug(null), "");
});
