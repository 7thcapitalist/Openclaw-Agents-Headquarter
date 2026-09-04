import test from "node:test";
import assert from "node:assert/strict";
import { classifyDecision, loadDecisionProtocol, DEFAULT_PROTOCOL } from "../lib/intel/classify.mjs";

test("reversible in-scope work continues", () => {
  const r = classifyDecision({ text: "Rename the helper and add a unit test for the trim path." });
  assert.equal(r.outcome, "continue");
  assert.equal(r.trigger, null);
});

test("privacy-sensitive work becomes a decision request", () => {
  const r = classifyDecision({ text: "Decide whether Fitbit health data is stored locally or synced to our backend." });
  assert.equal(r.outcome, "decision-request");
  assert.equal(r.trigger, "privacy");
});

test("spend, public communication, and irreversible changes each trigger a decision request", () => {
  assert.equal(classifyDecision({ text: "Add a vendor with usage billing for OCR." }).trigger, "spend");
  assert.equal(classifyDecision({ text: "Write the launch announcement and publish it to the marketing site." }).trigger, "public");
  assert.equal(classifyDecision({ text: "Run a destructive migration that will drop table events." }).trigger, "irreversible");
});

test("high-risk tasks always require a founder decision", () => {
  const r = classifyDecision({ text: "Small copy tweak.", fields: { risk: "high" } });
  assert.equal(r.outcome, "decision-request");
  assert.equal(r.trigger, "risk:high");
});

test("a structured field trigger fires", () => {
  const r = classifyDecision({ text: "reorder the backlog", fields: { changesMilestonePriority: true } });
  assert.equal(r.outcome, "decision-request");
  assert.equal(r.trigger, "scope");
});

test("blocking-only progress with no trigger asks a clarifying question", () => {
  const r = classifyDecision({ text: "Cannot proceed without knowing the target export format.", fields: { blocksAllProgress: true } });
  assert.equal(r.outcome, "ask");
  assert.equal(r.trigger, "blocking");
});

test("classification is deterministic", () => {
  const input = { text: "Change the pricing model to per-seat." };
  assert.deepEqual(classifyDecision(input), classifyDecision(input));
});

test("loadDecisionProtocol falls back to the embedded default when the file is absent", () => {
  const proto = loadDecisionProtocol("/nonexistent-hq-root");
  assert.equal(proto, DEFAULT_PROTOCOL);
});

test("the committed decision-protocol.json loads and classifies", () => {
  const proto = loadDecisionProtocol(process.cwd());
  assert.equal(proto.version, 1);
  assert.equal(classifyDecision({ text: "update the data retention policy", protocol: proto }).outcome, "decision-request");
});
