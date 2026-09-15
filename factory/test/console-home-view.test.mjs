// Home has one job: answer "does anything need me right now?" without ever
// implying it is live when it is not.
//
// The 11h42m stale mirror is the case that matters. It rendered identically to
// a fresh one, which is how five days of shipped work went unseen.
import test from "node:test";
import assert from "node:assert/strict";

import { ageLine, homeAttention, homeDecisions, homeModel, homePulse, splitQuestion } from "../../control-plane/public/home.mjs";

const NOW = Date.parse("2026-09-15T03:00:00.000Z");

function snapshot(overrides = {}) {
  return {
    contract: "hq.mirror/1",
    publishedAt: new Date(NOW - 40_000).toISOString(),
    panels: {
      company: {
        summary: { projects: 2 },
        decisions: [{
          id: "task-ca3c3cdf:reviewer",
          taskId: "task-ca3c3cdf",
          project: "lifemaxing",
          question: "How should the team verify the remaining production risk?",
          why: "The reviewer cannot verify remote database behaviour.",
          recommendation: "A: provision a temporary test database.",
          options: ["A: provision a temporary test database", "B: use the deployed smoke test"],
          risk: "high",
          requestedAt: "2026-09-09T01:59:18.975Z",
        }],
      },
      operations: {
        summary: { tasks: 21, activeRuns: 0, blockedRuns: 1 },
        tasks: [
          { taskId: "obj-a", status: "active", stage: "builder", updatedAt: "2026-09-14T00:00:00.000Z" },
          { taskId: "obj-b", status: "blocked", stage: "reviewer", updatedAt: "2026-09-14T00:00:00.000Z" },
          { taskId: "obj-c", status: "failed", stage: "qa", updatedAt: "2026-09-14T00:00:00.000Z" },
        ],
        objectives: [],
      },
      budgets: { totals: { costMicros: 85068, unpricedEvents: 2 } },
    },
    ...overrides,
  };
}

test("the age line gives a clock time AND a spoken age", () => {
  const age = ageLine(new Date(NOW - 40_000).toISOString(), NOW);
  assert.match(age.line, /^as of \d\d:\d\d, 40 seconds ago$/);
  assert.equal(age.stale, false);
});

test("an 11-hour-old mirror is stale and says so in hours", () => {
  const age = ageLine(new Date(NOW - 11.7 * 3600 * 1000).toISOString(), NOW);
  assert.equal(age.stale, true, "this is the case that must be impossible to mistake for live");
  assert.match(age.line, /12 hours ago|11 hours ago/);
});

test("a snapshot with no usable timestamp is treated as stale, not as fresh", () => {
  for (const bad of [undefined, null, 12345, "not-a-date", ""]) {
    const age = ageLine(bad, NOW);
    assert.equal(age.stale, true, `${JSON.stringify(bad)} must not read as live`);
    assert.match(age.line, /age unknown/);
  }
});

test("decisions carry their question and options", () => {
  const [decision] = homeDecisions(snapshot().panels);
  assert.equal(decision.id, "task-ca3c3cdf:reviewer");
  assert.match(decision.question, /verify the remaining production risk/);
  assert.equal(decision.options.length, 2);
  assert.equal(decision.risk, "high");
  assert.match(decision.recommendation, /^A:/);
});

test("only blocked and failed work is surfaced, never active work", () => {
  const items = homeAttention(snapshot().panels);
  assert.deepEqual(items.map((i) => i.id).sort(), ["obj-b", "obj-c"]);
  assert.ok(!items.some((i) => i.id === "obj-a"), "active work is not a problem");
});

test("an unhealthy objective is surfaced with its finding", () => {
  const snap = snapshot();
  snap.panels.operations.objectives = [{
    objectiveId: "obj-c58897c0",
    healthy: false,
    recordedAt: "2026-09-14T04:35:45.107Z",
    findings: [{ severity: "high", code: "objective-task-divergence", message: "node X is blocked but its task is active" }],
  }];
  const items = homeAttention(snap.panels);
  const objective = items.find((i) => i.kind === "objective");
  assert.ok(objective);
  assert.match(objective.detail, /blocked but its task is active/);
});

test("pulse is one line of numbers, and spend is labelled honestly", () => {
  const pulse = homePulse(snapshot().panels);
  assert.equal(pulse.running, 0);
  assert.equal(pulse.tasks, 21);
  assert.equal(pulse.projects, 2);
  // "spend to date", not "today": the snapshot carries no per-day bucket, and
  // labelling an all-time total as today's would be undetectable to the viewer.
  assert.equal(pulse.spendLabel, "$0.09");
  assert.equal(pulse.unpricedEvents, 2);
});

test("nothing waiting reads as calm, not as an empty dashboard", () => {
  const snap = snapshot();
  snap.panels.company.decisions = [];
  snap.panels.operations.tasks = [{ taskId: "obj-a", status: "active", stage: "builder" }];
  const model = homeModel(snap, NOW);
  assert.equal(model.calm, true);
  assert.equal(model.decisions.length, 0);
  assert.equal(model.attention.length, 0);
});

test("a decision outranks a stuck task: order is the design", () => {
  const model = homeModel(snapshot(), NOW);
  assert.equal(model.calm, false);
  assert.equal(model.decisions.length, 1);
  assert.equal(model.attention.length, 2);
});

test("unavailable panels degrade to empty, never throw", () => {
  const broken = {
    publishedAt: new Date(NOW).toISOString(),
    panels: {
      company: { unavailable: true, reason: "builder failed" },
      operations: { unavailable: true, reason: "builder failed" },
      budgets: { unavailable: true, reason: "builder failed" },
    },
  };
  const model = homeModel(broken, NOW);
  assert.deepEqual(model.decisions, []);
  assert.deepEqual(model.attention, []);
  assert.equal(model.calm, true);
  assert.equal(model.pulse.tasks, 0);
});

test("an empty snapshot does not throw", () => {
  for (const empty of [{}, { panels: {} }, { panels: null }]) {
    const model = homeModel(empty, NOW);
    assert.equal(model.calm, true);
    assert.equal(model.age.stale, true, "no timestamp means not live");
  }
});

test("a wall-of-text question is clamped to a headline without losing a word", () => {
  // The live mirror's recovery escalation writes 558 characters of dispatch ids
  // and redacted paths into `question`. Rendered as a heading it is a wall of
  // bold text harder to read than the raw JSON.
  const long =
    "Recovery could not continue after 1 bounded attempt(s): product dispatch wrote no result file "
    + "(session agent:architect:factory-obj-74ffa4cc-control-plane-app-shell-recovery-1-diagnose); "
    + "redacted executor output captured at evidence/obj-74ffa4cc-recovery-1-diagnose-missing-result.md.";
  const { question, why } = splitQuestion(long, "The product stage cannot continue without founder direction.");

  assert.ok(question.length <= 165, `headline should be scannable, got ${question.length}`);
  assert.match(question, /^Recovery could not continue/);
  // Nothing is discarded — the remainder leads the detail line.
  assert.match(why, /redacted executor output|session agent:architect/);
  assert.match(why, /cannot continue without founder direction/);
});

test("a short question is left exactly as written", () => {
  const q = "How should the team verify the remaining production risk?";
  const { question, why } = splitQuestion(q, "Because the reviewer cannot.");
  assert.equal(question, q);
  assert.equal(why, "Because the reviewer cannot.");
});

test("spend is read from a panel that is actually up", () => {
  // budgets.available goes false for an ordinary warning (two unpriced events),
  // and unavailable() treats that as a dead panel — which rendered a real $0.09
  // as "$0.00 spend to date".
  const panels = {
    operations: { summary: { tasks: 21, activeRuns: 0, blockedRuns: 1 }, costs: { totals: { costMicros: 85068, unpricedEvents: 2 } }, tasks: [], objectives: [] },
    budgets: { available: false, reason: "2 cost event(s) have no provider price", totals: { costMicros: 85068, unpricedEvents: 2 } },
    company: { summary: { projects: 2 }, decisions: [] },
  };
  const pulse = homePulse(panels);
  assert.equal(pulse.spendLabel, "$0.09", "a real cost must not render as $0.00");
  assert.equal(pulse.unpricedEvents, 2);
});

// ─── A4: no machine text as a headline ───────────────────────────────────────

test("a recovery escalation's machine prose never becomes the title", async () => {
  const { plainQuestion, plainContext, technicalOf } = await import("../../control-plane/public/home.mjs");
  const raw = "Recovery could not continue after 1 bounded attempt(s): product dispatch wrote no result file "
    + "(session agent:architect:factory-obj-74ffa4cc-control-plane-app-shell-recovery-1-diagnose); "
    + "redacted executor output captured at evidence/obj-74ffa4cc-recovery-1-diagnose-missing-result.md. "
    + "Reason: Gateway agent call connection closed. Check `openclaw gateway status`.";

  const title = plainQuestion(raw);
  assert.doesNotMatch(title, /session agent:/, "no session keys in a headline");
  assert.doesNotMatch(title, /evidence\//, "no evidence paths in a headline");
  assert.doesNotMatch(title, /obj-74ffa4cc/, "no task ids in a headline");
  assert.doesNotMatch(title, /`/, "no backticked machine literals");
  assert.ok(title.length <= 155);

  // Nothing is deleted — the original survives for the fold.
  const technical = technicalOf(raw, "");
  assert.match(technical, /session agent:architect/);
  assert.match(technical, /evidence\/obj-74ffa4cc/);
});

test("when nothing human survives, the card says what it is", async () => {
  const { plainQuestion } = await import("../../control-plane/public/home.mjs");
  const allMachine = "agent:qa:factory-obj-x-1 `gh` evidence/a.md obj-abcdef123";
  assert.equal(plainQuestion(allMachine), "The factory needs a decision before it can continue.");
});

test("context never just repeats the title", async () => {
  const { plainContext } = await import("../../control-plane/public/home.mjs");
  assert.equal(plainContext("Same words here.", "Same words here."), "");
  assert.equal(plainContext("The reviewer cannot verify remote behaviour.", "Different question?"),
    "The reviewer cannot verify remote behaviour.");
});

// ─── what finished recently ──────────────────────────────────────────────────

test("finished work is surfaced, newest first, with cost and links", async () => {
  const { homeFinished } = await import("../../control-plane/public/home.mjs");
  const panels = {
    operations: {
      costs: { byTask: { "obj-a": { costMicros: 22030000 } } },
      tasks: [
        { taskId: "obj-a", outcome: "Rebuild the frontend as an RPG.", projectId: "lifemaxing", status: "merged", updatedAt: "2026-09-14T02:30:00.000Z", prUrl: "https://github.com/x/y/pull/5" },
        { taskId: "obj-b", outcome: "Add the backend loop.", projectId: "lifemaxing", status: "merged", updatedAt: "2026-09-12T02:10:00.000Z" },
        { taskId: "obj-c", outcome: "Still going.", status: "active", updatedAt: "2026-09-15T00:00:00.000Z" },
      ],
      objectives: [],
    },
  };
  const done = homeFinished(panels);
  // Active work is not "finished".
  assert.deepEqual(done.map((d) => d.id), ["obj-a", "obj-b"]);
  assert.equal(done[0].title, "Rebuild the frontend as an RPG.");
  assert.equal(done[0].cost.costMicros, 22030000);
  assert.equal(done[0].prUrl, "https://github.com/x/y/pull/5");
});

test("nothing finished says so in one line, and does not pad", async () => {
  const { homeFinished } = await import("../../control-plane/public/home.mjs");
  assert.deepEqual(homeFinished({ operations: { tasks: [{ taskId: "a", status: "active" }], objectives: [] } }), []);
});

test("the spend line names its window and admits when it is a floor", () => {
  const complete = homePulse({
    operations: { summary: { tasks: 3 }, costs: { totals: { costMicros: 85068, unpricedEvents: 0, events: 48 } }, tasks: [], objectives: [] },
    company: { summary: { projects: 2 } },
  });
  assert.equal(complete.spendWindow, "across all 48 recorded runs");
  assert.equal(complete.spendComplete, true);

  const partial = homePulse({
    operations: { summary: { tasks: 3 }, costs: { totals: { costMicros: 85068, unpricedEvents: 2, events: 48 } }, tasks: [], objectives: [] },
    company: { summary: { projects: 2 } },
  });
  // A missing price must never read as free — say the number is a floor.
  assert.equal(partial.spendComplete, false);
  assert.equal(partial.unpricedEvents, 2);
});
