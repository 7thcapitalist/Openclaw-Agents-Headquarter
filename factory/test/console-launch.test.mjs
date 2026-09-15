// Launch is the only console screen that spends money, so the tests are about
// the two ways it could betray that:
//
//   1. enqueuing something the founder did not read back, and
//   2. saying it worked when nothing has run.
//
// The model half is pure and tested directly. The render half needs a DOM, so
// there is a small shim below — the confirmation flow is the whole point of
// the screen and testing it only by reading the source would prove nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildLaunchSnapshot, launchableProjects, overnightPlan, OVERNIGHT_LIMIT, MAX_OBJECTIVE_LENGTH } from "../lib/hq/launch.mjs";
import { INTENT_KINDS, validateIntent } from "../lib/integrations/intent-protocol.mjs";

// ── a DOM small enough to read, real enough to click ──────────────────────

function installDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.className = "";
      this._text = "";
      this.listeners = {};
      this.disabled = false;
      this.value = "";
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text; }
    append(...kids) { for (const k of kids) this.children.push(k); }
    replaceChildren(...kids) { this.children = [...kids]; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    setAttribute(name, value) { this[name] = value; }
    click() { for (const fn of this.listeners.click || []) fn(this); }
    input() { for (const fn of this.listeners.input || []) fn(this); }
    // Depth-first walk, so a test can find a control the way a person would.
    all(predicate, out = []) {
      if (predicate(this)) out.push(this);
      for (const kid of this.children) kid.all?.(predicate, out);
      return out;
    }
    byClass(name) { return this.all((n) => String(n.className).split(/\s+/).includes(name)); }
    text() { return this.textContent; }
  }
  const textNode = (value) => {
    const node = new Node("#text");
    node.textContent = value;
    return node;
  };
  globalThis.document = { createElement: (tag) => new Node(tag), createTextNode: textNode };
  return () => { delete globalThis.document; };
}

const root = () => globalThis.document.createElement("div");

function snapshot({ projects = [{ key: "lifemaxing", name: "LifeMax", launchable: true, blockedReason: null }], overnight = {} } = {}) {
  return {
    panels: {
      launch: {
        version: 1, available: true, maxObjectiveLength: 1000, projects,
        overnight: { status: "idle", limit: 8, items: [], ...overnight },
      },
    },
  };
}

// ── the snapshot the console reads ────────────────────────────────────────

function hq({ projects, control = null, queue = null, git = false }) {
  const dir = mkdtempSync(join(tmpdir(), "launch-"));
  mkdirSync(join(dir, "factory"), { recursive: true });
  // `repo: "."` resolves to this root, so a project is only launchable when
  // the root really is a git working tree.
  if (git) mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, "dashboard", "backend", "data", "factory"), { recursive: true });
  writeFileSync(join(dir, "factory", "projects.json"), JSON.stringify({ version: 1, projects }), "utf8");
  if (control) writeFileSync(join(dir, "dashboard", "backend", "data", "factory", "control-plane.json"), JSON.stringify(control), "utf8");
  if (queue) writeFileSync(join(dir, "dashboard", "backend", "data", "factory", "overnight-queue.json"), JSON.stringify(queue), "utf8");
  return dir;
}

test("the Headquarters is never offered as somewhere to send product work", () => {
  // A picker that offers the factory itself invites starting an objective
  // against the machine from a phone.
  const dir = hq({ projects: [
    { key: "openclaw-factory", name: "HQ", kind: "headquarters", repo: "." },
    { key: "lifemaxing", name: "LifeMax", repo: "." },
  ] });
  const keys = launchableProjects({ hqRoot: dir }).map((p) => p.key);
  assert.deepEqual(keys, ["lifemaxing"]);
});

test("a paused project is shown with its reason, not hidden", () => {
  // "It is not there" and "it is paused" are different problems, and a picker
  // that silently drops a project sends the founder hunting for a bug.
  const dir = hq({
    projects: [{ key: "lifemaxing", name: "LifeMax", repo: "." }],
    control: { version: 1, projects: { lifemaxing: { status: "paused" } } },
    git: true,
  });
  const [project] = launchableProjects({ hqRoot: dir });
  assert.equal(project.launchable, false);
  assert.equal(project.blockedReason, "paused");
});

test("a project with no git tree on the machine cannot be launched into", () => {
  const dir = hq({ projects: [{ key: "ghost", name: "Ghost", repo: "~/definitely/not/here" }] });
  const [project] = launchableProjects({ hqRoot: dir });
  assert.equal(project.launchable, false);
  assert.match(project.blockedReason, /git working tree/);
});

test("launchable projects sort first, so the common case is one tap", () => {
  const dir = hq({
    projects: [{ key: "zzz", name: "Zed", repo: "." }, { key: "ghost", name: "Ghost", repo: "~/nope" }],
    control: { version: 1, projects: {} },
    git: true,
  });
  const projects = launchableProjects({ hqRoot: dir });
  assert.equal(projects[0].key, "zzz");
  assert.equal(projects[0].launchable, true);
});

test("the overnight plan crosses the boundary without host paths", () => {
  const dir = hq({
    projects: [{ key: "p", name: "P", repo: "." }],
    queue: { version: 1, status: "running", currentItemId: "night-1", items: [
      { id: "night-1", objective: "Ship the thing", projectId: "p", repo: "/home/someone/secret/path", status: "running" },
    ] },
  });
  const plan = overnightPlan({ hqRoot: dir });
  assert.equal(plan.status, "running");
  assert.equal(plan.items[0].objective, "Ship the thing");
  assert.ok(!("repo" in plan.items[0]), "a host path must not be published");
});

test("a missing queue is an idle plan, never a throw", () => {
  const dir = hq({ projects: [{ key: "p", name: "P", repo: "." }] });
  const snap = buildLaunchSnapshot({ hqRoot: dir });
  assert.equal(snap.overnight.status, "idle");
  assert.deepEqual(snap.overnight.items, []);
  assert.equal(snap.readOnly, true);
  assert.equal(snap.summary.queued, 0);
});

test("the published limits agree with the store that enforces them", async () => {
  // These are duplicated across the factory/dashboard boundary on purpose;
  // if they drift, the console offers a ninth slot the machine will refuse.
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../dashboard/backend/lib/overnightQueue.mjs", import.meta.url), "utf8"));
  assert.match(source, new RegExp(`MAX_ITEMS = ${OVERNIGHT_LIMIT}\\b`));
  assert.match(source, new RegExp(`MAX_OBJECTIVE_LENGTH = ${MAX_OBJECTIVE_LENGTH}\\b`));
});

// ── the model the view renders ────────────────────────────────────────────

test("no launch panel reads as unavailable, never as nothing to launch", async () => {
  const restore = installDom();
  try {
    const { launchModel } = await import("../../control-plane/public/launch.mjs");
    const model = launchModel({ panels: {} });
    assert.equal(model.available, false);
    assert.match(model.reason, /has not published/);
  } finally { restore(); }
});

// ── the confirmation: the whole point of the screen ───────────────────────

async function mountLaunch(snap, sent) {
  const mod = await import("../../control-plane/public/launch.mjs");
  mod.resetLaunchDraft();
  const view = root();
  const draw = () => mod.renderLaunch(view, snap, {
    onIntent: (kind, args, button, key) => sent.push({ kind, args, key }),
    intentStateFor: () => null,
  });
  mod.setLaunchRerender(draw);
  draw();
  return { view, draw, mod };
}

const buttonSaying = (view, label) => view.all((n) => n.tagName === "BUTTON" && n.textContent === label)[0];

test("pressing Start it now enqueues NOTHING until it is confirmed", async () => {
  const restore = installDom();
  try {
    const sent = [];
    const { view } = await mountLaunch(snapshot(), sent);

    const field = view.all((n) => n.tagName === "TEXTAREA")[0];
    field.value = "Make onboarding finish in under a minute";
    field.input();

    buttonSaying(view, "Start it now").click();
    assert.deepEqual(sent, [], "an objective was enqueued without being read back");

    // The read-back must show the project by name and the objective verbatim.
    const confirm = view.byClass("launch-confirm")[0];
    assert.ok(confirm, "no confirmation was shown");
    assert.match(confirm.textContent, /LifeMax/);
    assert.match(confirm.textContent, /Make onboarding finish in under a minute/);
    assert.match(confirm.textContent, /spends real money/);

    buttonSaying(view, "Yes, start it").click();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "objective.start");
    assert.deepEqual(sent[0].args, { objective: "Make onboarding finish in under a minute", projectId: "lifemaxing" });
  } finally { restore(); }
});

test("cancelling the read-back enqueues nothing and keeps the objective", async () => {
  const restore = installDom();
  try {
    const sent = [];
    const { view } = await mountLaunch(snapshot(), sent);
    const field = view.all((n) => n.tagName === "TEXTAREA")[0];
    field.value = "Something expensive";
    field.input();
    buttonSaying(view, "Start it now").click();
    buttonSaying(view, "Cancel").click();
    assert.deepEqual(sent, []);
    assert.equal(view.all((n) => n.tagName === "TEXTAREA")[0].value, "Something expensive");
  } finally { restore(); }
});

test("editing after a read-back invalidates it — what was read is no longer what would run", async () => {
  const restore = installDom();
  try {
    const sent = [];
    const { view } = await mountLaunch(snapshot(), sent);
    let field = view.all((n) => n.tagName === "TEXTAREA")[0];
    field.value = "Original";
    field.input();
    buttonSaying(view, "Start it now").click();
    assert.ok(view.byClass("launch-confirm")[0]);

    field = view.all((n) => n.tagName === "TEXTAREA")[0];
    field.value = "Original, but much more expensive";
    field.input();
    assert.equal(view.byClass("launch-confirm").length, 0, "a stale confirmation survived an edit");
    assert.deepEqual(sent, []);
  } finally { restore(); }
});

test("planning the night says plainly that nothing runs now", async () => {
  const restore = installDom();
  try {
    const sent = [];
    const { view } = await mountLaunch(snapshot(), sent);
    const field = view.all((n) => n.tagName === "TEXTAREA")[0];
    field.value = "Tidy the settings screen";
    field.input();
    buttonSaying(view, "Add to tonight's plan").click();
    const confirm = view.byClass("launch-confirm")[0];
    assert.match(confirm.textContent, /Nothing runs now/);
    buttonSaying(view, "Yes, plan it").click();
    assert.equal(sent[0].kind, "overnight.add");
  } finally { restore(); }
});

test("an empty objective is refused before any confirmation", async () => {
  const restore = installDom();
  try {
    const sent = [];
    const { view } = await mountLaunch(snapshot(), sent);
    buttonSaying(view, "Start it now").click();
    assert.equal(view.byClass("launch-confirm").length, 0);
    assert.deepEqual(sent, []);
  } finally { restore(); }
});

test("a blocked project offers no way to spend money on it", async () => {
  const restore = installDom();
  try {
    const sent = [];
    const snap = snapshot({ projects: [{ key: "lifemaxing", name: "LifeMax", launchable: false, blockedReason: "paused" }] });
    const { view } = await mountLaunch(snap, sent);
    assert.equal(buttonSaying(view, "Start it now"), undefined);
    assert.equal(buttonSaying(view, "Add to tonight's plan"), undefined);
    assert.match(view.textContent, /cannot be handed work right now — paused/);
  } finally { restore(); }
});

test("a full plan says so rather than offering a ninth slot", async () => {
  const restore = installDom();
  try {
    const items = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, objective: `o${i}`, projectId: "lifemaxing", status: "queued" }));
    const { view } = await mountLaunch(snapshot({ overnight: { items } }), []);
    assert.match(view.textContent, /Tonight's plan is full at 8/);
  } finally { restore(); }
});

test("the plan names each item by its objective, with the id muted", async () => {
  const restore = installDom();
  try {
    const { view } = await mountLaunch(snapshot({
      overnight: { items: [{ id: "night-abc", objective: "Rebuild the home screen", projectId: "lifemaxing", status: "queued" }] },
    }), []);
    const item = view.byClass("launch-item")[0];
    assert.match(item.children[0].textContent, /Rebuild the home screen/, "the objective must lead the row");
    assert.equal(view.byClass("home-id")[view.byClass("home-id").length - 1].textContent, "night-abc");
    assert.match(view.textContent, /waiting for tonight/);
  } finally { restore(); }
});

// ── the protocol these two kinds go through ───────────────────────────────

test("both kinds Launch uses are allowlisted with exactly the args it sends", () => {
  assert.deepEqual(INTENT_KINDS["objective.start"].args, ["objective", "projectId"]);
  assert.deepEqual(INTENT_KINDS["overnight.add"].args, ["objective", "projectId"]);
});

test("an intent still cannot carry a command", () => {
  // The screen is new; the rule is not. A founder typing an outcome has no
  // reason to produce any of these and a probe has every reason to.
  for (const objective of ["rm -rf /; echo", "../../etc/passwd", "/etc/passwd", "file:///etc/passwd", "require('fs')"]) {
    const result = validateIntent({ kind: "objective.start", args: { objective, projectId: "lifemaxing" } });
    assert.equal(result.ok, false, `accepted a command-shaped objective: ${objective}`);
  }
  assert.equal(validateIntent({ kind: "objective.start", args: { objective: "Make onboarding fast", projectId: "lifemaxing" } }).ok, true);
});

test("an unknown argument is rejected rather than trimmed", () => {
  const result = validateIntent({ kind: "overnight.add", args: { objective: "fine", projectId: "p", repo: "/home/joao-vitor" } });
  assert.equal(result.ok, false);
});

test("the machine registers a handler for both kinds", async () => {
  // A kind that is allowlisted but unhandled reports "nothing was run" rather
  // than failing silently — but Launch must not ship in that state.
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../scripts/hq-intents.mjs", import.meta.url), "utf8"));
  assert.match(source, /"objective\.start": async/);
  assert.match(source, /"overnight\.add": async/);
  // Both must go through the same gate, so they cannot drift apart from the
  // dashboard's own rules about what may be spent on.
  assert.match(source, /function requireRunnableProject\(/);
  // Both call sites, not counting the definition.
  assert.equal((source.match(/= requireRunnableProject\(control, projectId\)/g) || []).length, 2);
});

test("starting an objective never builds a shell string", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../scripts/hq-intents.mjs", import.meta.url), "utf8"));
  const handler = source.slice(source.indexOf('"objective.start"'), source.indexOf('"overnight.add"'));
  assert.match(handler, /"--objective", objective/, "the objective must be an argv value");
  assert.ok(!/shell\s*:\s*true/.test(handler), "spawn must not use a shell");
  assert.ok(!/exec\(|execSync/.test(handler), "no exec form may be used here");
});

test("planning the night never starts the night", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../scripts/hq-intents.mjs", import.meta.url), "utf8"));
  const handler = source.slice(source.indexOf('"overnight.add"'), source.indexOf('"decision.resolve"'));
  assert.match(handler, /addOvernightItem/);
  assert.ok(!/startOvernight/.test(handler), "adding to the plan must not begin spending");
});
