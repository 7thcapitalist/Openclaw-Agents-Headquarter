import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { renderLearning } from "../../control-plane/public/views.mjs";
import { IDLE_REASON_LABELS as CONSOLE_LABELS } from "../../control-plane/public/learning.mjs";
import { IDLE_REASON_LABELS as DASHBOARD_LABELS } from "../../dashboard/backend/public/lib/learningView.mjs";
import { boundLearning } from "../lib/hq/publisher.mjs";
import { validateIntent } from "../lib/integrations/intent-protocol.mjs";

function dom() {
  class Node {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this._text = ""; this.listeners = {}; this.disabled = false; this.className = ""; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join(" ") : this._text; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = [...children]; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    all(tag, out = []) { if (this.tagName === tag.toUpperCase()) out.push(this); for (const child of this.children) child.all?.(tag, out); return out; }
  }
  globalThis.document = { createElement: (tag) => new Node(tag) };
  return () => { delete globalThis.document; };
}

const snapshot = (learning) => ({ panels: { learning } });
const learning = (over = {}) => ({ available: true, mode: "shadow", idleReason: "founder-active", findings: [], launches: [], wouldHaveLaunched: [], proposals: [], credit: { usedBySelfImprovement: 2, wouldHaveExpired: 8, basis: "estimate" }, ...over });

function render(value, options = {}) {
  const restore = dom(); const root = document.createElement("div");
  try { renderLearning(root, snapshot(value), options); return { root, text: root.textContent }; } finally { restore(); }
}

test("console renders empty, unavailable, idle, credit, findings, and activity states", () => {
  assert.match(render(learning()).text, /No findings or launches yet/);
  assert.match(render(undefined).text, /Learning state is unavailable/);
  const out = render(learning({ findings: [{ title: "Finding <unsafe>", evidence: ["evidence/a.md"] }], wouldHaveLaunched: [{ objectiveId: "obj-1", findingId: "L-1", at: "now" }] })).text;
  for (const text of ["founder objective active", "Finding <unsafe>", "evidence/a.md", "would have launched", "obj-1", "used by self-improvement", "would otherwise have expired"]) assert.match(out, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("console mode controls call the provided intent bridge", () => {
  const sent = []; const restore = dom(); const root = document.createElement("div");
  try {
    renderLearning(root, snapshot(learning()), { onMode: (mode, _button, key) => sent.push([mode, key]) });
    for (const button of root.all("button")) if (!button.disabled) button.listeners.click();
  } finally { restore(); }
  assert.deepEqual(sent, [["off", "learning:mode:off"], ["on", "learning:mode:on"]]);
});

test("console and dashboard idle labels stay identical", () => assert.deepEqual(CONSOLE_LABELS, DASHBOARD_LABELS));

test("console keeps the current idle reason visible alongside launch history", () => {
  assert.match(render(learning({ launches: [{ objectiveId: "obj-1", findingId: "L-1", at: "now" }] })).text, /founder objective active/);
});

test("every idle reason emitted by the trigger has a human label", () => {
  const decide = readFileSync(new URL("../lib/idle/decide.mjs", import.meta.url), "utf8");
  const trigger = readFileSync(new URL("../lib/idle/trigger.mjs", import.meta.url), "utf8");
  const state = readFileSync(new URL("../lib/idle/state.mjs", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../lib/idle/panel.mjs", import.meta.url), "utf8");
  const emitted = new Set([
    ...[...decide.matchAll(/skip\("([^"]+)"/g)].map((match) => match[1]),
    ...[trigger, state, panel].flatMap((source) => [...source.matchAll(/idleReason:\s*"([^"]+)"/g)].map((match) => match[1])),
    "launch-recheck-failed",
  ]);
  for (const code of emitted) {
    assert.ok(CONSOLE_LABELS[code], `missing human label for emitted idle reason: ${code}`);
  }
});

test("published learning state is bounded before mirroring", () => {
  const out = boundLearning({ findings: Array.from({ length: 30 }, (_, i) => ({ id: i, evidence: Array.from({ length: 15 }, (_, j) => `${i}/${j}`) })), launches: Array(30), wouldHaveLaunched: Array(30), proposals: Array(30) });
  assert.equal(out.findings.length, 20); assert.equal(out.findings[0].evidence.length, 10);
  assert.equal(out.launches.length, 20); assert.equal(out.wouldHaveLaunched.length, 20); assert.equal(out.proposals.length, 20);
});

test("hosted console registers, routes, renders, reads snapshot, and submits mode intent", () => {
  const app = readFileSync(new URL("../../control-plane/public/app.js", import.meta.url), "utf8");
  const publisher = readFileSync(new URL("../lib/hq/publisher.mjs", import.meta.url), "utf8");
  for (const token of ['["learning", "Learning"]', 'activeTab === "learning"', "renderLearning(els.view, snapshot", 'submitIntent("learning.mode"']) assert.ok(app.includes(token), token);
  assert.match(publisher, /gather\("learning"/);
  assert.equal(validateIntent({ kind: "learning.mode", args: { mode: "on" } }).ok, true);
  assert.equal(validateIntent({ kind: "learning.mode", args: { mode: "automatic" } }).ok, false);
  assert.equal(validateIntent({ kind: "learning.mode", args: { mode: "on", command: "x" } }).ok, false);
});
