// Proposed work, and the direction it serves.
//
// Both halves were published all along and neither was reachable: proposals sat
// at the bottom of Deliveries under a card that said starting work was not
// wired, and the goals panel was rendered nowhere at all.
//
// The properties worth a test are the ones that would make this tab dangerous
// rather than merely empty:
//
//   1. accepting is a CHOICE, never automatic — the proposer proposes and the
//      founder disposes, and the local dashboard has deliberately never had a
//      write route for proposals;
//   2. a proposal with no project has nowhere to run, so it must not offer a
//      button that would be refused;
//   3. an absent or unconfigured goals panel says so in a sentence, because an
//      empty gauge reads as broken.
import test from "node:test";
import assert from "node:assert/strict";

import { goalsRollup, renderNext } from "../../control-plane/public/views.mjs";

function installDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.className = ""; this._text = ""; this.style = {};
      this.listeners = {}; this.value = "";
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join(" ") : this._text; }
    append(...kids) { for (const k of kids) this.children.push(k); }
    replaceChildren(...kids) { this.children = [...kids]; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    focus() {}
    get childElementCount() { return this.children.length; }
    all(predicate, out = []) {
      if (predicate(this)) out.push(this);
      for (const kid of this.children) kid.all?.(predicate, out);
      return out;
    }
    byTag(name) { return this.all((n) => n.tagName === name.toUpperCase()); }
    text() { return this.all(() => true).map((n) => n._text).join(" "); }
  }
  globalThis.document = { createElement: (tag) => new Node(tag) };
  return { restore: () => { delete globalThis.document; } };
}

const proposal = (over = {}) => ({
  rank: 1, kind: "unblock",
  title: "OpenClaw Agents Headquarter is the canonical operational layer over GitHub delivery",
  why: "12 items of 20 under this goal are blocked, and 2 still active.",
  goalId: "project-openclaw-factory", projectId: "openclaw-factory",
  ...over,
});

const goalsPanelFixture = (over = {}) => ({
  version: 1, available: true, configured: true,
  summary: { state: "blocked", percent: 12, total: 26, complete: 3, blocked: 12, active: 2, unknown: 0 },
  roots: [{
    id: "company-operable-factory", level: "company",
    title: "Run a software factory the founder can understand and control without reading logs",
    projectId: null,
    progress: { state: "blocked", percent: 12, total: 26, complete: 3, blocked: 12, active: 2 },
  }],
  goals: [],
  ...over,
});

const snap = (over = {}) => ({
  panels: {
    proposals: { available: true, proposals: [proposal()] },
    goals: goalsPanelFixture(),
    ...over,
  },
});

function render(snapshot, handlers = {}) {
  const dom = installDom();
  const root = document.createElement("div");
  try {
    renderNext(root, snapshot, handlers);
    return { root, text: root.text() };
  } finally {
    dom.restore();
  }
}

const handlers = { onStart: () => {}, onQueue: () => {} };

// ── 1. accepting is a choice ─────────────────────────────────────────────────

test("a proposal offers two explicit choices and starts nothing on its own", () => {
  const { root } = render(snap(), handlers);
  const buttons = root.byTag("button").map((b) => b.textContent);
  assert.deepEqual(buttons, ["Start it now", "Add it to tonight"]);
});

test("each choice sends the intent it names, aimed at the proposal's project", () => {
  const sent = [];
  const dom = installDom();
  const root = document.createElement("div");
  try {
    renderNext(root, snap(), {
      onStart: (p) => sent.push(["start", p.title, p.projectId]),
      onQueue: (p) => sent.push(["queue", p.title, p.projectId]),
    });
    for (const button of root.byTag("button")) button.listeners.click();
  } finally {
    dom.restore();
  }
  assert.deepEqual(sent, [
    ["start", proposal().title, "openclaw-factory"],
    ["queue", proposal().title, "openclaw-factory"],
  ]);
});

test("with no handlers, no button is drawn — the framing stays report-only", () => {
  const { root, text } = render(snap(), {});
  assert.equal(root.byTag("button").length, 0);
  assert.match(text, /Nothing here starts on its own/);
});

// ── 2. a proposal with nowhere to run ────────────────────────────────────────

test("a proposal with no project explains itself instead of offering a refused button", () => {
  const { root, text } = render(snap({
    proposals: { available: true, proposals: [proposal({ projectId: null, goalId: "company-wide" })] },
  }), handlers);

  assert.equal(root.byTag("button").length, 0, "there is no repository to run this in");
  assert.match(text, /sits above any single project/);
  assert.match(text, /command center/, "and says where it can be started instead");
});

// ── 3. the goals roll-up ─────────────────────────────────────────────────────

test("the roll-up reports the founder's own phrasing", () => {
  const rollup = goalsRollup(snap().panels);
  assert.equal(rollup.available, true);
  assert.equal(rollup.line, "3 of 26 tracked units complete · 12 blocked · 2 in flight");
  assert.equal(rollup.percent, 12);
});

test("progress is read from `progress`, not from the goal itself", () => {
  // `goal.percent` does not exist; reading it gave 0 for every goal.
  const rollup = goalsRollup(snap().panels);
  assert.equal(rollup.roots[0].percent, 12);
  assert.equal(rollup.roots[0].state, "blocked");
  assert.equal(rollup.roots[0].blocked, 12);
});

test("unconfigured goals read as a sentence, not an empty gauge", () => {
  const rollup = goalsRollup({ goals: goalsPanelFixture({ configured: false }) });
  assert.equal(rollup.available, false);
  assert.match(rollup.reason, /No goals are registered yet/);

  const { text } = render(snap({ goals: goalsPanelFixture({ configured: false }) }), handlers);
  assert.match(text, /No goals are registered yet/);
  assert.ok(!/\b0%/.test(text), "an empty gauge would read as broken");
});

test("an unavailable goals panel is reported rather than drawn as zero", () => {
  const rollup = goalsRollup({ goals: { unavailable: true, reason: "the builder threw" } });
  assert.equal(rollup.available, false);
  assert.ok(rollup.reason.length > 5);
});

test("a missing goals panel does not take the tab down", () => {
  const { text } = render({ panels: { proposals: { available: true, proposals: [proposal()] } } }, handlers);
  assert.match(text, /Where this is going/);
  assert.match(text, /No goals have been published yet/);
});

// ── the empty and broken states ──────────────────────────────────────────────

test("no proposals is stated plainly, and distinguished from a panel that failed", () => {
  const quiet = render(snap({ proposals: { available: true, proposals: [] } }), handlers);
  assert.match(quiet.text, /nothing to suggest right now/);

  const broken = render(snap({ proposals: { unavailable: true, reason: "the proposer threw" } }), handlers);
  assert.match(broken.text, /has not published suggestions/);
  assert.match(broken.text, /the proposer threw/, "the reason is shown, not swallowed");
});
