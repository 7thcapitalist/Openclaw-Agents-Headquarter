import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  translateEvent,
  untranslatedEventSentence,
} from "../../control-plane/public/founder-vocabulary.mjs";

const EMITTERS = [
  "factory/lib/task-workflow.mjs",
  "factory/lib/objective/orchestrator.mjs",
];

function emittedEventTypes() {
  const types = new Set();
  const sources = EMITTERS.map((path) => readFileSync(path, "utf8"));

  for (const source of sources) {
    for (const match of source.matchAll(/type:\s*(["'`])([^"'`]+)\1/g)) {
      types.add(match[2]);
    }
  }

  // This is a capability scope, not an event. It is the only non-event
  // `type:` literal in either scanned file.
  types.delete("project");

  assert.ok(types.delete("stage-${outcome}"), "stage outcome event template must remain discoverable");
  for (const outcome of ["pass", "fail", "decision-required"]) types.add(`stage-${outcome}`);

  assert.ok(types.delete("node-${status}"), "node status event template must remain discoverable");
  for (const status of ["blocked", "failed"]) types.add(`node-${status}`);

  const objectiveSource = sources[1];
  assert.match(
    objectiveSource,
    /type:\s*outcome\.status\s*===\s*GATE_SATISFIED\s*\?\s*"integration-gate-satisfied"\s*:\s*"integration-blocked"/,
    "integration outcome event ternary must remain discoverable",
  );
  types.add("integration-gate-satisfied");
  types.add("integration-blocked");

  return types;
}

test("every emitted workflow and objective event has a founder translation", () => {
  const types = emittedEventTypes();
  assert.equal(types.size, 40, "the source scan must enumerate the current 40 distinct event types");

  for (const type of types) {
    const event = type === "failure-routed"
      ? { type, stage: "builder", fromStage: "reviewer" }
      : type === "stage-decision-deferred"
        ? { type, escalated: false }
        : { type };
    const translation = translateEvent(event);
    assert.notEqual(
      translation.sentence,
      untranslatedEventSentence(type),
      `${type} must have a real founder-facing translation`,
    );
    assert.equal(typeof translation.needsFounderAction, "boolean", `${type} must declare whether founder action is needed`);
  }
});

test("an untranslated type is visibly marked as a gap", () => {
  assert.deepEqual(translateEvent({ type: "some-made-up-type" }), {
    sentence: "Internal step: some-made-up-type (no plain description yet)",
    needsFounderAction: false,
  });
});

test("commit-frozen explains the shared locked commit", () => {
  const translation = translateEvent({ type: "commit-frozen" });
  assert.match(translation.sentence, /build is finished/i);
  assert.match(translation.sentence, /code is locked/i);
  assert.match(translation.sentence, /reviewer, QA and security check the same commit/i);
  assert.match(translation.sentence, /Nothing needed from you\.$/);
  assert.equal(translation.needsFounderAction, false);
});

test("failure-routed distinguishes builder rework from an in-place retry", () => {
  const builder = translateEvent({ type: "failure-routed", fromStage: "qa", stage: "builder" });
  assert.match(builder.sentence, /sent back to the builder/i);
  assert.match(builder.sentence, /Nothing needed from you\.$/);
  assert.equal(builder.needsFounderAction, false);

  const retry = translateEvent({ type: "failure-routed", fromStage: "qa", stage: "qa" });
  assert.doesNotMatch(retry.sentence, /sent back to the builder/i);
  assert.match(retry.sentence, /Nothing needed from you\.$/);
  assert.equal(retry.needsFounderAction, false);
});

test("the shared module is reachable from both console distributions", () => {
  const server = readFileSync("dashboard/backend/server.mjs", "utf8");
  assert.match(server, /\/lib\/founder-vocabulary\.mjs/);
  assert.match(server, /control-plane".*"public".*"founder-vocabulary\.mjs"/s);

  const build = readFileSync("control-plane/build.mjs", "utf8");
  assert.match(build, /"founder-vocabulary\.mjs"/);
});

test("translation reads the event without removing its raw type", () => {
  const event = Object.freeze({ type: "stage-pass", stage: "builder" });
  translateEvent(event);
  assert.equal(event.type, "stage-pass");
});
