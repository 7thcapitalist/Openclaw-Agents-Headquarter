// The founder command center on the console.
//
// The founder's complaint was that the console could not be used to run the
// company: no way to send work, no way to see or change tonight's plan, and no
// way to aim any of it at the factory itself. These tests cover the three
// things that would make the new controls worse than none:
//
//   1. a control drawn for something the machine would refuse — the dead
//      button this codebase keeps removing;
//   2. the factory missing from the picker, or corrupting the project list by
//      being added to it;
//   3. an absent overnight panel rendering as "nothing planned", which is a
//      different fact from "we cannot see the plan".
import test from "node:test";
import assert from "node:assert/strict";

import {
  commandCenterModel, launchTargets, overnightPlan, renderCommandCenter,
} from "../../control-plane/public/command-center.mjs";

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
    focus() {}
    setAttribute(name, value) { this[name] = value; }
    get childElementCount() { return this.children.length; }
    all(predicate, out = []) {
      if (predicate(this)) out.push(this);
      for (const kid of this.children) kid.all?.(predicate, out);
      return out;
    }
    byClass(name) { return this.all((n) => String(n.className).split(/\s+/).includes(name)); }
    byTag(name) { return this.all((n) => n.tagName === name.toUpperCase()); }
    text() { return this.all(() => true).map((n) => n._text).join(" "); }
  }
  globalThis.document = { createElement: (tag) => new Node(tag) };
  return { Node, restore: () => { delete globalThis.document; } };
}

const company = (over = {}) => ({
  projects: [{ key: "lifemaxing", name: "LifeMax" }],
  headquarters: { key: "openclaw-factory", name: "OpenClaw Agents Headquarter" },
  ...over,
});

const overnight = (over = {}) => ({
  version: 1, contract: "hq.overnight/1", available: true, status: "idle",
  stopRequested: false, limit: 8, full: false, items: [],
  summary: { total: 0, counts: { queued: 0, running: 0, complete: 0, failed: 0 }, planned: false, isRunning: false, needsAttention: false },
  ...over,
});

const snap = (panels = {}) => ({ panels: { company: company(), overnight: overnight(), ...panels } });

// ── 1. the picker ────────────────────────────────────────────────────────────

test("the factory is an option in the picker, and is marked as one", () => {
  const targets = launchTargets(snap().panels);
  assert.deepEqual(targets.map((t) => t.key), ["lifemaxing", "openclaw-factory"]);

  const factory = targets.find((t) => t.isHeadquarters);
  assert.equal(factory.key, "openclaw-factory", "the intent carries `key` — there is no `id` on a project record");
  assert.match(factory.label, /\(factory\)$/, "the founder must be able to tell it apart from a product");
  assert.equal(targets[0].label, "LifeMax", "an ordinary project is not suffixed");
});

test("the factory is never added to the published project list", () => {
  const panels = snap().panels;
  launchTargets(panels);
  assert.deepEqual(panels.company.projects.map((p) => p.key), ["lifemaxing"],
    "adding the HQ to company.projects would distort every portfolio roll-up that reads it");
});

test("a project with no key is dropped rather than sent as an empty projectId", () => {
  const targets = launchTargets({ company: company({ projects: [{ name: "Nameless" }, { key: "ok", name: "Fine" }] }) });
  assert.deepEqual(targets.map((t) => t.key), ["ok", "openclaw-factory"]);
});

test("an unavailable company panel yields no targets and no launcher", () => {
  const model = commandCenterModel({ panels: { company: { unavailable: true, reason: "down" } } });
  assert.deepEqual(model.targets, []);
  assert.equal(model.canLaunch, false);
  assert.ok(model.launchReason.length > 10, "and the page says why rather than showing an empty form");
});

// ── 2. the overnight plan ────────────────────────────────────────────────────

test("an absent overnight panel is not reported as an empty plan", () => {
  const plan = overnightPlan({ company: company() });
  assert.equal(plan.available, false);
  assert.match(plan.reason, /has not published an overnight plan/);
  // "We cannot see the plan" and "there is no plan" are different facts.
  assert.equal(plan.canEdit, false);
});

test("a running night cannot be edited, and the panel says so rather than offering a button", () => {
  const plan = overnightPlan({
    overnight: overnight({
      status: "running",
      summary: { ...overnight().summary, isRunning: true, counts: { queued: 2, running: 1, complete: 1, failed: 0 } },
      items: [{ id: "n1", objective: "A", status: "running" }],
    }),
  });
  assert.equal(plan.isRunning, true);
  assert.equal(plan.canEdit, false);
  assert.equal(plan.canAddAtAll, false, "the queue throws on add/remove while running");
});

test("a full plan cannot be added to", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, objective: "x", status: "queued" }));
  const plan = overnightPlan({ overnight: overnight({ items, full: true }) });
  assert.equal(plan.full, true);
  assert.equal(plan.canEdit, false);
  assert.equal(plan.canAddAtAll, true, "removing is still possible — that is how you make room");
});

// ── 3. the rendered controls ─────────────────────────────────────────────────

function render(snapshot, handlers = {}) {
  const dom = installDom();
  const root = document.createElement("div");
  try {
    renderCommandCenter(root, snapshot, handlers);
    return { root, text: root.text(), dom };
  } finally {
    dom.restore();
  }
}

const allHandlers = {
  onStart: () => {}, onOvernightAdd: () => {}, onOvernightRemove: () => {},
  onOvernightStart: () => {}, onOvernightStop: () => {},
};

test("no start button is drawn when the caller cannot start anything", () => {
  // The handler map is the caller's statement of what this machine wires. An
  // omitted handler must remove the control, not disable it.
  const { root } = render(snap(), {});
  assert.equal(root.byClass("cc-form").length, 0, "no form without a handler to receive it");
  assert.equal(root.byTag("select").length, 0);
});

test("the start form is drawn with both projects when the handler exists", () => {
  const { root } = render(snap(), allHandlers);
  const options = root.byTag("option").map((o) => o.textContent);
  assert.deepEqual(options.filter((o) => /factory/.test(o)).length, 2,
    "the factory appears in both the launcher and the overnight picker");
  assert.ok(options.includes("LifeMax"));
});

test("a running night draws a stop button and no add form", () => {
  const running = snap({
    overnight: overnight({
      status: "running",
      summary: { ...overnight().summary, isRunning: true, counts: { queued: 1, running: 1, complete: 0, failed: 0 } },
      items: [{ id: "n1", objective: "Ship the backend", status: "running" }],
    }),
  });
  const { root, text } = render(running, allHandlers);
  const buttons = root.byTag("button").map((b) => b.textContent);

  assert.ok(buttons.some((b) => /Stop after the current objective/.test(b)));
  assert.ok(!buttons.some((b) => /^Add to tonight$/.test(b)), "adding is refused while running, so it is not offered");
  assert.ok(!buttons.some((b) => /^Remove$/.test(b)), "nor is removing");
  assert.match(text, /cannot be changed while the night is running/);
});

test("a stop already requested is described honestly, and not offered twice", () => {
  const stopping = snap({
    overnight: overnight({
      status: "running", stopRequested: true,
      summary: { ...overnight().summary, isRunning: true, counts: { queued: 1, running: 1, complete: 0, failed: 0 } },
      items: [{ id: "n1", objective: "Ship", status: "running" }],
    }),
  });
  const { root, text } = render(stopping, allHandlers);
  // The runner checks the flag between objectives, so the current one finishes.
  assert.match(text, /stop after the objective now in flight finishes/i);
  assert.ok(!root.byTag("button").some((b) => /Stop after/.test(b.textContent)), "the stop is already requested");
});

test("start is only offered when there is something queued to start", () => {
  const empty = render(snap(), allHandlers);
  assert.ok(!empty.root.byTag("button").some((b) => /Start tonight's run/.test(b.textContent)),
    "an empty plan has nothing to run, and the queue would refuse");

  const queued = render(snap({
    overnight: overnight({
      items: [{ id: "n1", objective: "Ship", status: "queued" }],
      summary: { ...overnight().summary, counts: { queued: 1, running: 0, complete: 0, failed: 0 }, planned: true },
    }),
  }), allHandlers);
  assert.ok(queued.root.byTag("button").some((b) => /Start tonight's run/.test(b.textContent)));
});

test("an absent overnight panel explains itself instead of drawing controls", () => {
  const { root, text } = render({ panels: { company: company() } }, allHandlers);
  assert.match(text, /has not published an overnight plan/);
  assert.ok(!root.byTag("button").some((b) => /tonight/i.test(b.textContent)),
    "no control may act on a plan the page cannot see");
});

test("a failed overnight objective shows the sentence, and the plan asks for attention", () => {
  const { text } = render(snap({
    overnight: overnight({
      status: "needs-attention",
      items: [{ id: "n1", objective: "Ship", status: "failed", error: "The objective stopped before delivery." }],
      summary: { ...overnight().summary, counts: { queued: 0, running: 0, complete: 0, failed: 1 }, needsAttention: true },
    }),
  }), allHandlers);
  assert.match(text, /stopped before delivery/);
});

test("the objective text is submitted with the chosen project key", () => {
  const sent = [];
  const dom = installDom();
  const root = document.createElement("div");
  try {
    renderCommandCenter(root, snap(), { ...allHandlers, onStart: (args) => sent.push(args) });
    const form = root.byClass("cc-form")[0];
    const textarea = root.byClass("cc-objective")[0];
    const select = root.byTag("select")[0];
    textarea.value = "  Ship the backend  ";
    select.value = "openclaw-factory";
    form.listeners.submit({ preventDefault() {} });
  } finally {
    dom.restore();
  }
  assert.deepEqual(sent, [{ objective: "Ship the backend", projectId: "openclaw-factory" }],
    "trimmed, and aimed at the key the picker carries");
});

test("an empty objective is not submitted", () => {
  const sent = [];
  const dom = installDom();
  const root = document.createElement("div");
  try {
    renderCommandCenter(root, snap(), { ...allHandlers, onStart: (args) => sent.push(args) });
    const form = root.byClass("cc-form")[0];
    root.byClass("cc-objective")[0].value = "   ";
    form.listeners.submit({ preventDefault() {} });
  } finally {
    dom.restore();
  }
  assert.deepEqual(sent, []);
});
