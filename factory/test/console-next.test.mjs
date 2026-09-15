// Next: proposed work and goals, accepted in one press — and never in none.
//
// `buildWorkProposals` has been published all along and the console rendered
// it read-only, with a card saying "starting work from the console is not
// wired yet". That was true until Launch existed.
//
// The invariant these tests exist for is the one the local dashboard enforces
// by having no write route at all: THE PROPOSER PROPOSES, THE FOUNDER
// DISPOSES. A ranking must never become an instruction, so accepting offers
// two explicit choices and then still asks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { nextModel, goalsModel, renderNext, resetNextDraft, setNextRerender } from "../../control-plane/public/next.mjs";

function installDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.className = ""; this._text = ""; this.style = {}; this.listeners = {};
      this.disabled = false;
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join(" ") : this._text; }
    append(...kids) { for (const k of kids) this.children.push(k); }
    replaceChildren(...kids) { this.children = [...kids]; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    setAttribute(name, value) { this[name] = value; }
    click() { for (const fn of this.listeners.click || []) fn(this); }
    all(predicate, out = []) {
      if (predicate(this)) out.push(this);
      for (const kid of this.children) kid.all?.(predicate, out);
      return out;
    }
    byClass(name) { return this.all((n) => String(n.className).split(/\s+/).includes(name)); }
  }
  globalThis.document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (v) => { const n = new Node("#text"); n.textContent = v; return n; },
  };
  return () => { delete globalThis.document; };
}

const LIFEMAX = { key: "lifemaxing", name: "LifeMax", isHeadquarters: false, launchable: true, blockedReason: null };

const proposal = (over = {}) => ({
  rank: 1, kind: "unblock",
  title: "LifeMax runs on a real backend the founder uses daily, privacy-first",
  why: "12 items of 20 under this goal are blocked, and 2 still active.",
  goalId: "project-lifemaxing", goalTitle: "LifeMax…", projectId: "lifemaxing",
  ancestry: ["Run a software factory the founder can understand"],
  evidence: { blocked: 12, total: 20, active: 2, source: "goal projection" },
  ...over,
});

const goalsPanel = (over = {}) => ({
  configured: true, available: true, warnings: [],
  summary: { state: "blocked", percent: 12, total: 26, complete: 3, blocked: 12, active: 2, unknown: 0 },
  roots: [{
    id: "company-operable-factory", level: "company", title: "Run a software factory the founder can control",
    progress: { state: "blocked", percent: 12, total: 26, complete: 3, blocked: 12, active: 2 },
    children: [{
      id: "project-lifemaxing", level: "project", title: "LifeMax runs on a real backend",
      projectId: "lifemaxing",
      progress: { state: "active", percent: 50, total: 6, complete: 3, blocked: 0, active: 1 },
      children: [],
    }],
  }],
  ...over,
});

function snapshot({ proposals = [proposal()], goals = goalsPanel() } = {}) {
  return { panels: { proposals: { available: true, reportOnly: true, threshold: 2, proposals }, goals } };
}

async function mount(snap, sent, { projects = [LIFEMAX] } = {}) {
  resetNextDraft();
  const view = globalThis.document.createElement("div");
  const draw = () => renderNext(view, snap, {
    onIntent: (kind, args, button, key) => sent.push({ kind, args, key }),
    intentStateFor: () => null,
    projectsFor: () => projects,
  });
  setNextRerender(draw);
  draw();
  return view;
}

const buttonSaying = (view, label) => view.all((n) => n.tagName === "BUTTON" && n.textContent === label)[0];

// ── the proposer proposes, the founder disposes ───────────────────────────

test("accepting offers two explicit choices and starts nothing on its own", async () => {
  const restore = installDom();
  try {
    const sent = [];
    const view = await mount(snapshot(), sent);
    assert.ok(buttonSaying(view, "Start it now"), "no 'start it now' choice");
    assert.ok(buttonSaying(view, "Add it to tonight"), "no 'add it to tonight' choice");
    // Nothing has been enqueued merely by the card existing.
    assert.deepEqual(sent, []);
  } catch (e) { throw e; } finally { restore(); }
});

test("choosing a destination still asks before it spends", async () => {
  const restore = installDom();
  try {
    const sent = [];
    const view = await mount(snapshot(), sent);
    buttonSaying(view, "Start it now").click();
    assert.deepEqual(sent, [], "a proposal was enqueued without a read-back");

    const confirm = view.byClass("launch-confirm")[0];
    assert.ok(confirm, "no confirmation was shown");
    assert.match(confirm.textContent, /LifeMax/);
    assert.match(confirm.textContent, /spends real money/);
    // Verbatim: the objective that will run is the proposal's own title.
    assert.match(confirm.textContent, /real backend the founder uses daily/);

    buttonSaying(view, "Yes, start it").click();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "objective.start");
    assert.deepEqual(sent[0].args, { objective: proposal().title, projectId: "lifemaxing" });
  } finally { restore(); }
});

test("adding to tonight goes through the same step and the overnight kind", async () => {
  const restore = installDom();
  try {
    const sent = [];
    const view = await mount(snapshot(), sent);
    buttonSaying(view, "Add it to tonight").click();
    assert.match(view.byClass("launch-confirm")[0].textContent, /Nothing runs now/);
    buttonSaying(view, "Yes, plan it").click();
    assert.equal(sent[0].kind, "overnight.add");
  } finally { restore(); }
});

test("cancelling a proposal enqueues nothing", async () => {
  const restore = installDom();
  try {
    const sent = [];
    const view = await mount(snapshot(), sent);
    buttonSaying(view, "Start it now").click();
    buttonSaying(view, "Cancel").click();
    assert.deepEqual(sent, []);
    assert.equal(view.byClass("launch-confirm").length, 0);
    // And the choices come back.
    assert.ok(buttonSaying(view, "Start it now"));
  } finally { restore(); }
});

test("the confirmation is imported, not rewritten", () => {
  // A second confirmation beside the first is how the two screens come to
  // warn about spending in different words, and the wording is the safeguard.
  const source = readFileSync(new URL("../../control-plane/public/next.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ outcomeConfirmation \} from "\.\/launch\.mjs"/);
  assert.ok(!/launch-confirm-cost|Yes, start it/.test(source), "next.mjs must not build its own read-back");
});

test("the local dashboard still has no write route for proposals", () => {
  // That absence is the design: the proposer proposes and the founder
  // disposes. If a POST ever appears, this tab's premise is gone.
  const server = readFileSync(new URL("../../dashboard/backend/server.mjs", import.meta.url), "utf8");
  assert.ok(!/app\.post\("\/api\/hq\/proposals/.test(server), "a proposals write route appeared");
  assert.ok(!/app\.put\("\/api\/hq\/proposals/.test(server));
});

// ── no dead controls ──────────────────────────────────────────────────────

test("a company-level goal names no project, so no spend button is drawn", async () => {
  const restore = installDom();
  try {
    const view = await mount(snapshot({ proposals: [proposal({ projectId: null })] }), []);
    assert.equal(buttonSaying(view, "Start it now"), undefined);
    assert.match(view.textContent, /company-level goal and names no project/);
  } finally { restore(); }
});

test("a paused project is named with its reason instead of a button", async () => {
  const restore = installDom();
  try {
    const view = await mount(snapshot(), [], {
      projects: [{ ...LIFEMAX, launchable: false, blockedReason: "paused" }],
    });
    assert.equal(buttonSaying(view, "Start it now"), undefined);
    assert.match(view.textContent, /cannot be handed work right now — paused/);
  } finally { restore(); }
});

test("a project the machine has not published as launchable offers nothing", async () => {
  const restore = installDom();
  try {
    const view = await mount(snapshot(), [], { projects: [] });
    assert.equal(buttonSaying(view, "Start it now"), undefined);
    assert.match(view.textContent, /has not published it as somewhere work can be sent/);
  } finally { restore(); }
});

// ── emptiness reads as true, not as broken ────────────────────────────────

test("no proposals is a sentence, not an empty list", async () => {
  const restore = installDom();
  try {
    const view = await mount(snapshot({ proposals: [] }), []);
    assert.match(view.textContent, /Nothing is proposed right now/);
    assert.match(view.textContent, /blocked, neglected, or shows a repeated pattern/);
  } finally { restore(); }
});

test("unregistered goals say so rather than drawing an empty gauge", async () => {
  const model = goalsModel({ configured: false });
  assert.equal(model.available, false);
  assert.equal(model.configured, false);
  assert.match(model.reason, /No goals are registered yet/);

  const restore = installDom();
  try {
    const view = await mount(snapshot({ goals: { configured: false } }), []);
    assert.match(view.textContent, /No goals are registered yet/);
    assert.doesNotMatch(view.textContent, /0 of 0 tracked units/);
  } finally { restore(); }
});

test("an unpublished proposals panel says so rather than reading as nothing to do", async () => {
  const model = nextModel({ panels: {} });
  assert.equal(model.proposals.available, false);
  const restore = installDom();
  try {
    const view = await mount({ panels: {} }, []);
    assert.match(view.textContent, /has not published any proposals/);
  } finally { restore(); }
});

// ── the framing, and the goals roll-up ────────────────────────────────────

test("the tab keeps the framing that makes it safe to read", async () => {
  const restore = installDom();
  try {
    const view = await mount(snapshot(), []);
    assert.match(view.textContent, /ranked from canonical state/);
    assert.match(view.textContent, /Nothing here is started automatically/);
  } finally { restore(); }
});

test("the goals roll-up uses the tunnel's sentence, word for word", async () => {
  const restore = installDom();
  try {
    const view = await mount(snapshot(), []);
    // dashboard/backend/public/lib/goalsView.mjs: "N of M tracked units
    // complete · N blocked · N in flight".
    assert.match(view.textContent, /3 of 26 tracked units complete/);
    assert.match(view.textContent, /12 blocked/);
    assert.match(view.textContent, /2 in flight/);
  } finally { restore(); }
});

test("goals nest, and each level carries its own progress", async () => {
  const restore = installDom();
  try {
    const view = await mount(snapshot(), []);
    const rows = view.byClass("next-goal");
    assert.ok(rows.length >= 2, "the child goal must render under its parent");
    assert.match(view.textContent, /LifeMax runs on a real backend/);
    assert.match(view.textContent, /50% · 3\/6/);
  } finally { restore(); }
});

test("a goal with no linked work says so rather than showing 0%", async () => {
  const restore = installDom();
  try {
    const view = await mount(snapshot({
      goals: goalsPanel({
        roots: [{
          id: "g", level: "company", title: "Untracked goal",
          progress: { state: "unavailable", percent: 0, total: 0, complete: 0, blocked: 0, active: 0 },
          children: [],
        }],
      }),
    }), []);
    assert.match(view.textContent, /no linked work/);
  } finally { restore(); }
});

test("goals with a warning still show their totals, with the caveat", () => {
  // The same trap the Money tab hit: `available: false` here means a warning
  // was recorded, not that the goals are gone.
  const model = goalsModel(goalsPanel({ available: false, warnings: ["one objective could not be read"] }));
  assert.equal(model.available, true);
  assert.equal(model.incomplete, true);
  assert.equal(model.summary.total, 26);
});

test("progress percentages are clamped", () => {
  const model = goalsModel(goalsPanel({
    summary: { state: "active", percent: 900, total: 1, complete: 1 },
    roots: [{ id: "g", title: "t", progress: { state: "active", percent: -20, total: 1, complete: 0 }, children: [] }],
  }));
  assert.equal(model.summary.percent, 100);
  assert.equal(model.roots[0].progress.percent, 0);
});

test("Deliveries no longer carries the read-only proposal footnote", () => {
  const views = readFileSync(new URL("../../control-plane/public/views.mjs", import.meta.url), "utf8");
  assert.ok(!/starting work from the console is not wired yet/.test(views),
    "that claim is false now that Launch exists");
  assert.ok(!/proposalCard/.test(views), "the proposal card moved to the Next tab");
});

test("every goal state the tunnel knows is named the same way here", () => {
  // The first cut knew four states, so `pending` fell through to the
  // unavailable default and a goal reading "50% · 3/6" was captioned
  // "No linked work" — a caption contradicting the number beside it.
  const tunnel = readFileSync(new URL("../../dashboard/backend/public/lib/goalsView.mjs", import.meta.url), "utf8");
  const block = tunnel.slice(tunnel.indexOf("const STATE_LABEL = {"), tunnel.indexOf("};", tunnel.indexOf("const STATE_LABEL = {")));
  const theirs = [...block.matchAll(/^\s*(\w+):\s*\["([^"]+)"/gm)].map((m) => [m[1], m[2]]);
  assert.ok(theirs.length >= 6, "expected the tunnel's state vocabulary to be present");

  const ours = readFileSync(new URL("../../control-plane/public/next.mjs", import.meta.url), "utf8");
  const oursBlock = ours.slice(ours.indexOf("const GOAL_STATE = {"), ours.indexOf("};", ours.indexOf("const GOAL_STATE = {")));
  for (const [state, label] of theirs) {
    assert.match(oursBlock, new RegExp(`${state}: \\["${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
      `${state} must be named "${label}" on both surfaces`);
  }
});

test("a pending goal reads as not started, not as untracked", async () => {
  const restore = installDom();
  try {
    const view = await mount(snapshot({
      goals: goalsPanel({
        roots: [{
          id: "g", level: "project", title: "Half done but not begun",
          progress: { state: "pending", percent: 50, total: 6, complete: 3, blocked: 0, active: 0 },
          children: [],
        }],
      }),
    }), []);
    assert.match(view.textContent, /Not started/);
    assert.doesNotMatch(view.textContent, /No linked work/);
  } finally { restore(); }
});

test("a state nobody recognises says so rather than picking a label at random", async () => {
  const restore = installDom();
  try {
    const view = await mount(snapshot({
      goals: goalsPanel({
        roots: [{ id: "g", title: "Odd", progress: { state: "sideways", percent: 10, total: 2, complete: 0 }, children: [] }],
      }),
    }), []);
    assert.match(view.textContent, /Unrecognised state/);
  } finally { restore(); }
});
