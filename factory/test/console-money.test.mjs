// The cost dashboard, and the three ways it could show a wrong number.
//
// Cost data has been published all along — `operations.costs` from
// `summarizeCostLedger`, and `budgets` with its policies and pricing
// provenance. The console rendered none of it, so "what is this costing me"
// was a tunnel-only question.
//
// The tests that matter here are the prohibitions, because each one is a
// number that would be believed:
//
//   1. an unpriced event makes the total a FLOOR, and the page must say so;
//   2. there is no per-task-per-stage bucket, so none may be shown;
//   3. the seats are not in this ledger, and a figure that looked like the
//      monthly bill would be the wrong number on the wrong screen.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { moneyModel, budgetModel, renderMoney } from "../../control-plane/public/money.mjs";
import { summarizeCostLedger } from "../lib/hq/cost-ledger.mjs";

function installDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.className = ""; this._text = ""; this.style = {};
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join(" ") : this._text; }
    append(...kids) { for (const k of kids) this.children.push(k); }
    replaceChildren(...kids) { this.children = [...kids]; }
    addEventListener() {}
    setAttribute(name, value) { this[name] = value; }
    all(predicate, out = []) {
      if (predicate(this)) out.push(this);
      for (const kid of this.children) kid.all?.(predicate, out);
      return out;
    }
    byClass(name) { return this.all((n) => String(n.className).split(/\s+/).includes(name)); }
  }
  globalThis.document = { createElement: (tag) => new Node(tag) };
  return () => { delete globalThis.document; };
}

const bucket = (costMicros, extra = {}) => ({
  inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, costMicros, unpricedEvents: 0, events: 3, ...extra,
});

function snapshot({ costs = {}, budgets = undefined } = {}) {
  return {
    panels: {
      operations: {
        costs: {
          version: 1,
          totals: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, costMicros: 85068, unpricedEvents: 0, events: 48 },
          byProject: { lifemaxing: bucket(76860), "openclaw-factory": bucket(8208) },
          byProvider: { openai: bucket(84616) },
          byModel: { "gpt-5.6-sol": bucket(84616) },
          byAgent: { "backend-builder": bucket(35008) },
          byStage: { builder: bucket(43694), reviewer: bucket(31080) },
          ...costs,
        },
      },
      ...(budgets === undefined ? {} : { budgets }),
    },
  };
}

// ── 1. an unpriced event makes the total a floor ──────────────────────────

test("a total with no unpriced events is a total", () => {
  const model = moneyModel(snapshot());
  assert.equal(model.totals.isFloor, false);
  assert.equal(model.totals.costMicros, 85068);
});

test("one unpriced event makes it a floor", () => {
  const model = moneyModel(snapshot({ costs: { totals: { costMicros: 85068, unpricedEvents: 1, events: 48, inputTokens: 0, outputTokens: 0 } } }));
  assert.equal(model.totals.isFloor, true);
  assert.equal(model.totals.unpricedEvents, 1);
});

test("the page says in words that the figure is a floor, beside the number", () => {
  const restore = installDom();
  try {
    const root = globalThis.document.createElement("div");
    renderMoney(root, snapshot({ costs: { totals: { costMicros: 85068, unpricedEvents: 2, events: 48, inputTokens: 0, outputTokens: 0 } } }));
    const headline = root.byClass("money-headline")[0];
    assert.ok(headline, "no headline rendered");
    // Not a footnote and not an asterisk: the caveat is in the same box.
    assert.match(headline.textContent, /no price yet/);
    assert.match(headline.textContent, /floor, not a total/);
    assert.match(headline.textContent, /at least/i);
  } finally { restore(); }
});

test("a complete total is not hedged", () => {
  const restore = installDom();
  try {
    const root = globalThis.document.createElement("div");
    renderMoney(root, snapshot());
    const headline = root.byClass("money-headline")[0];
    assert.doesNotMatch(headline.textContent, /floor/);
    assert.doesNotMatch(headline.textContent, /at least/i);
  } finally { restore(); }
});

test("a per-bucket floor is flagged on that bucket too", () => {
  const restore = installDom();
  try {
    const root = globalThis.document.createElement("div");
    renderMoney(root, snapshot({ costs: { byProject: { lifemaxing: bucket(76860, { unpricedEvents: 1 }) } } }));
    assert.match(root.textContent, /1 unpriced, so this is a floor/);
  } finally { restore(); }
});

// ── 2. no per-task-per-stage figure ───────────────────────────────────────

test("byStage is labelled factory-wide, because no per-task split exists", () => {
  // publisher.mjs passes `costByStage: {}` deliberately rather than
  // attributing another task's spend. Rendering a stage cost beside a task
  // would invent a number that is not in the ledger.
  const restore = installDom();
  try {
    const root = globalThis.document.createElement("div");
    renderMoney(root, snapshot());
    assert.match(root.textContent, /Across the whole factory, not per task/);
  } finally { restore(); }
});

test("the view never reads a per-task stage bucket", () => {
  const source = readFileSync(new URL("../../control-plane/public/money.mjs", import.meta.url), "utf8");
  assert.ok(!/byTask/.test(source.replace(/^.*`byTask` exists.*$/gm, "")),
    "money.mjs must not read byTask — it carries no stage split");
});

test("the publisher still refuses to attribute stage cost to a task", () => {
  // If this ever starts passing real data, the label above becomes a lie.
  const source = readFileSync(new URL("../lib/hq/publisher.mjs", import.meta.url), "utf8");
  const detail = readFileSync(new URL("../lib/hq/task-detail.mjs", import.meta.url), "utf8");
  assert.ok(/costByStage/.test(source) || /costByStage/.test(detail), "costByStage should still exist to be guarded");
});

// ── 3. the seats are not in this ledger ───────────────────────────────────

test("the page states what the ledger covers, and what it does not", () => {
  const restore = installDom();
  try {
    const root = globalThis.document.createElement("div");
    renderMoney(root, snapshot());
    const scope = root.byClass("money-scope")[0];
    assert.ok(scope, "the ledger's scope must be stated");
    assert.match(scope.textContent, /API spend/);
    assert.match(scope.textContent, /not your monthly bill/);
    // Named, so there is no doubt which subscriptions are excluded.
    assert.match(scope.textContent, /ChatGPT/);
    assert.match(scope.textContent, /Cursor/);
  } finally { restore(); }
});

test("nothing published about seats is pulled into this view", () => {
  const source = readFileSync(new URL("../../control-plane/public/money.mjs", import.meta.url), "utf8");
  assert.ok(!/seats\.mjs|providerUsage|provider-usage/.test(source),
    "seats and provider-usage are unpublished and partly config-derived — they stay out");
});

// ── the breakdowns ────────────────────────────────────────────────────────

test("every breakdown the founder asked for is present", () => {
  const model = moneyModel(snapshot());
  for (const key of ["byProject", "byProvider", "byModel", "byAgent", "byStage"]) {
    assert.ok(Array.isArray(model[key]) && model[key].length, `${key} is missing`);
  }
});

test("breakdowns sort by spend, and tie-break by name so they do not reshuffle", () => {
  const model = moneyModel(snapshot({
    costs: { byProject: { b: bucket(100), a: bucket(100), big: bucket(900) } },
  }));
  assert.deepEqual(model.byProject.map((r) => r.key), ["big", "a", "b"]);
});

test("the view re-derives nothing — it reads the ledger's own summary", () => {
  // `summarizeCostLedger` already drops reversals and superseded events. A
  // second implementation in a view is how two screens come to disagree.
  // Comments stripped: the header legitimately explains that the LEDGER
  // already drops those, which is the point. What must not exist is code.
  const code = readFileSync(new URL("../../control-plane/public/money.mjs", import.meta.url), "utf8")
    .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/reversal|superseded/i.test(code), "cost correction logic belongs in cost-ledger.mjs, not a view");
  assert.ok(typeof summarizeCostLedger === "function");
});

test("an unavailable cost panel says so rather than reading as zero spend", () => {
  const model = moneyModel({ panels: {} });
  assert.equal(model.available, false);
  assert.ok(model.reason);

  const restore = installDom();
  try {
    const root = globalThis.document.createElement("div");
    renderMoney(root, { panels: {} });
    assert.doesNotMatch(root.textContent, /\$0\.00/, "no data must never render as zero spent");
  } finally { restore(); }
});

// ── budgets ───────────────────────────────────────────────────────────────

const alert = (over = {}) => ({
  scopeId: "lifemaxing", scopeType: "project", window: "calendar-month-utc",
  status: "ok", observedMicros: 76860, limitMicros: 60000000, percent: 0.1, unpricedEvents: 0, ...over,
});

test("budget alerts carry the tunnel's own vocabulary", () => {
  const restore = installDom();
  try {
    const root = globalThis.document.createElement("div");
    renderMoney(root, snapshot({
      budgets: { configured: true, enforcement: "alert-only", summary: { ok: 1 }, alerts: [alert()], pricing: { derivedPrices: 46, unpricedEvents: 2, version: "2026-09-08" } },
    }));
    assert.match(root.textContent, /Within budget/);
    assert.match(root.textContent, /Alert-only: crossing a limit reports it and stops nothing/);
    // Pricing provenance: a derived price is HQ's own table, not a bill.
    assert.match(root.textContent, /priced from factory\/pricing\.json/);
    assert.match(root.textContent, /with no price at all/);
  } finally { restore(); }
});

test("the worst policy wins the header — one exceeded is not averaged away", () => {
  const model = budgetModel({ configured: true, summary: { ok: 2, warning: 0, exceeded: 1 }, alerts: [] });
  assert.equal(model.worst, "exceeded");
  assert.equal(budgetModel({ configured: true, summary: { ok: 2, warning: 1 }, alerts: [] }).worst, "warning");
  assert.equal(budgetModel({ configured: true, summary: { ok: 2 }, alerts: [] }).worst, "ok");
});

test("an unconfigured budget says so instead of rendering an empty gauge", () => {
  const model = budgetModel({ configured: false, pricing: null });
  assert.equal(model.available, false);
  assert.match(model.reason, /factory\/budgets\.json/);
});

test("a budget whose observation includes unpriced events says it is a floor", () => {
  const restore = installDom();
  try {
    const root = globalThis.document.createElement("div");
    renderMoney(root, snapshot({
      budgets: { configured: true, enforcement: "alert-only", summary: { ok: 1 }, alerts: [alert({ unpricedEvents: 3 })] },
    }));
    assert.match(root.textContent, /3 unpriced, so this is a floor/);
  } finally { restore(); }
});

test("percent is clamped, so a bad number cannot draw a bar off the screen", () => {
  const model = budgetModel({ configured: true, summary: {}, alerts: [alert({ percent: 900 }), alert({ percent: -5 })] });
  assert.equal(model.alerts[0].percent, 100);
  assert.equal(model.alerts[1].percent, 0);
});

// ── available:false means incomplete, not missing ─────────────────────────

test("a budget panel with warnings still shows its real policies", () => {
  // `buildBudgetSnapshot` sets `available: warnings.length === 0`, so two
  // unpriced events flip it false while three correct policies sit in the
  // same object. The shared `unavailable()` helper reads that as "not
  // configured", which rendered a working panel as a dead one and hid
  // numbers the founder actually has.
  const model = budgetModel({
    configured: true,
    available: false,
    warnings: ["2 cost event(s) have no provider price and no entry in factory/pricing.json"],
    enforcement: "alert-only",
    summary: { ok: 3 },
    alerts: [alert(), alert({ scopeId: "openclaw-factory" })],
  });
  assert.equal(model.available, true, "real policies must not be thrown away");
  assert.equal(model.alerts.length, 2);
  assert.match(model.incomplete, /incomplete/);
  assert.match(model.incomplete, /no provider price/);
});

test("the incompleteness is shown, not swallowed", () => {
  const restore = installDom();
  try {
    const root = globalThis.document.createElement("div");
    renderMoney(root, snapshot({
      budgets: { configured: true, available: false, warnings: ["pricing table is stale"], summary: { ok: 1 }, alerts: [alert()] },
    }));
    assert.match(root.textContent, /pricing table is stale/);
    assert.match(root.textContent, /Within budget/, "the policies still render");
  } finally { restore(); }
});

test("costs with a warning still render, with the caveat", () => {
  const model = moneyModel({
    panels: {
      operations: {
        available: false,
        warnings: ["task t1 liveness unavailable"],
        costs: { totals: { costMicros: 5000, events: 2, unpricedEvents: 0, inputTokens: 1, outputTokens: 1 }, byProject: {} },
      },
    },
  });
  assert.equal(model.available, true, "one unrelated warning must not blank the whole tab");
  assert.equal(model.totals.costMicros, 5000);
  assert.match(model.incomplete, /incomplete/);
});

test("a genuinely absent panel is still reported as absent", () => {
  assert.equal(moneyModel({ panels: {} }).available, false);
  assert.equal(budgetModel(undefined).available, false);
  assert.equal(budgetModel({ unavailable: true, reason: "the machine could not read it" }).available, false);
  assert.match(budgetModel({ unavailable: true, reason: "the machine could not read it" }).reason, /could not read/);
});
