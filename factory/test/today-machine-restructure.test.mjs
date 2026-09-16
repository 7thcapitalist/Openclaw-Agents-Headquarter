import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");

function functionBody(name) {
  const start = APP.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = APP.indexOf("\n  function ", start + 1);
  return APP.slice(start, end === -1 ? APP.length : end);
}

test("Today keeps its five sections in the founder reading order", () => {
  const today = functionBody("renderFounderHome");
  const markers = ["data-section=\"as-of\"", "data-section=\"needs-you\"", "data-section=\"in-motion\"", "data-section=\"start-something\"", "data-section=\"what-next\""];
  const positions = markers.map((marker) => today.indexOf(marker));
  assert.ok(positions.every((position) => position >= 0), "all Today section markers must render");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test("Today hides activity and finished work in a collapsed first-render fold", () => {
  const today = functionBody("renderFounderHome");
  assert.match(today, /<details class=\"inbox-fold founder-detail-fold\"><summary>/);
  assert.doesNotMatch(today, /<details[^>]+open/);
  assert.match(today, /Finished recently/);
  assert.match(today, /What the factory has done/);
  assert.doesNotMatch(today, /Factory pulse/);
});

test("Machine owns the relocated infrastructure panels", () => {
  const today = functionBody("renderFounderHome");
  const machine = functionBody("renderMachinePage");
  for (const [heading, panel] of [["System readiness", "readinessPanel"], ["Storage and backups", "retentionPanel"], ["Factory control", "operationsPanel"]]) {
    assert.match(machine, new RegExp(`\\$\\{${panel}\\(`));
    assert.doesNotMatch(today, new RegExp(`\\$\\{${panel}\\(`));
  }
  assert.match(machine, /renderMachinePage/);
});

test("Machine chip reports warning count or green health", () => {
  const source = functionBody("readinessChipState");
  const body = source.slice(source.indexOf("{") + 1, source.lastIndexOf("}"));
  const readinessChipState = new Function(`return function readinessChipState(readiness) {${body}}`)();
  assert.deepEqual(readinessChipState({ checks: { disk: { status: "warn" }, services: { status: "fail" }, gateway: { status: "ok" } } }), { tone: "amber", count: 2 });
  assert.deepEqual(readinessChipState({ checks: { disk: { status: "ok" }, gateway: { status: "unknown" } } }), { tone: "green", count: 0 });
});
