// The renderer's job is to be honest about a snapshot it cannot verify.
//
// It runs in a browser that cannot reach the factory, over data produced by a
// publisher that strips secrets and truncates long fields on the way out. So a
// panel can legitimately arrive half-shaped, and the two failure modes that
// matter are not "looks wrong":
//
//   1. THROWING. One missing key must not blank the page. A renderer that dies
//      on a malformed panel tells the founder nothing at all, which is strictly
//      worse than a panel saying it has nothing to show.
//
//   2. LOOKING LIVE. Everything rendered is as old as `publishedAt`. A number
//      shown without that context reads as current, and a founder acting on a
//      stale cost total or an already-answered decision is the specific harm
//      this whole design exists to avoid.
//
// The fixtures mirror shapes observed in a real published snapshot rather than
// shapes invented here — `company.agents` is an object with its own `agents`
// array and `summary`, not a bare array, and getting that wrong is exactly the
// kind of mistake these tests are for.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentsPanel,
  attentionPanel,
  budgetsPanel,
  compact,
  freshness,
  money,
  panelsFor,
  projectsPanel,
  statsFrom,
  unavailable,
} from "../../control-plane/public/render.mjs";

function realisticSnapshot(overrides = {}) {
  return {
    version: 1,
    contract: "hq.mirror/1",
    publishedAt: new Date().toISOString(),
    publisher: "factory-machine",
    panels: {
      company: {
        summary: { projects: 1, activeProjects: 1, projectsNeedingAttention: 0, agents: 12, openDecisions: 0 },
        projects: [{ key: "lifemaxing", name: "LifeMax", status: "active", mission: "Ship the backend." }],
        agents: {
          agents: [{ id: "chief-of-staff", name: "Chief of Staff Agent", role: "Orchestration", status: "idle" }],
          summary: { total: 12, working: 0, blocked: 0, idle: 12 },
        },
        decisions: [],
        recommendedActions: [
          { priority: 4, project: "lifemaxing", action: "Consider running the app locally.", rationale: "Opportunity." },
        ],
      },
      operations: { summary: { tasks: 0, activeRuns: 0, blockedRuns: 0, deadLetters: 0, stallingTasks: 0 } },
      deployments: { summary: { projects: 2, neverDeployed: 2 }, deployments: [] },
      budgets: { totals: { inputTokens: 182, outputTokens: 374, costMicros: 8208, events: 18, unpricedEvents: 0 } },
      goals: { available: false, summary: { state: "unavailable" }, goals: [] },
    },
    ...overrides,
  };
}

// --- rule 1: never throw on data --------------------------------------------

test("no panel throws on a snapshot that is missing everything", () => {
  for (const snapshot of [{}, { panels: {} }, { panels: null }, null, undefined]) {
    assert.doesNotThrow(() => panelsFor(snapshot), `panelsFor threw on ${JSON.stringify(snapshot)}`);
    assert.doesNotThrow(() => statsFrom(snapshot?.panels), `statsFrom threw on ${JSON.stringify(snapshot)}`);
  }
});

test("no panel throws when its fields are the wrong type", () => {
  const hostile = {
    panels: {
      company: { summary: "not an object", projects: "not an array", agents: 42, recommendedActions: null },
      operations: { summary: null },
      deployments: { deployments: {} },
      budgets: { totals: [] },
      goals: { goals: "nope" },
    },
  };
  assert.doesNotThrow(() => panelsFor(hostile));
  assert.doesNotThrow(() => statsFrom(hostile.panels));
  for (const panel of panelsFor(hostile)) {
    assert.equal(typeof panel.title, "string");
    assert.ok(Array.isArray(panel.rows), `${panel.title} must always expose rows`);
  }
});

test("a panel that failed on the machine says so instead of rendering blank", () => {
  const panels = { company: { unavailable: true, reason: "ENOENT reading state" } };
  assert.match(unavailable(panels.company), /ENOENT/);
  const projects = projectsPanel(panels);
  assert.equal(projects.rows.length, 0);
  assert.match(projects.note, /ENOENT/);
});

test("one panel's bug costs only that panel", () => {
  // A getter that throws stands in for a renderer bug on real-world data.
  const panels = {
    company: {
      get projects() {
        throw new Error("boom");
      },
    },
    budgets: { totals: { costMicros: 1_000_000 } },
  };
  const rendered = panelsFor({ panels });
  assert.ok(rendered.some((p) => /could not be rendered/.test(p.note || "")), "the broken panel must report itself");
  assert.ok(rendered.some((p) => p.title === "Spend"), "the healthy panel must still render");
});

// --- rule 2: never invent freshness -----------------------------------------

test("a fresh snapshot is not marked stale, and an old one is", () => {
  const now = Date.now();
  assert.equal(freshness(new Date(now - 10_000).toISOString(), now).stale, false);
  assert.equal(freshness(new Date(now - 30 * 60_000).toISOString(), now).stale, true);
});

test("an unparseable publishedAt is treated as stale, never as fresh", () => {
  // 12345 is the interesting one: Date.parse reads it as the YEAR 12345, which
  // lands in the future, clamps to zero seconds and renders as "0s ago" — a
  // garbage timestamp presenting itself as the freshest possible data.
  for (const value of ["", null, undefined, "not-a-date", 12345, {}, [], "12345"]) {
    const age = freshness(value);
    assert.equal(age.stale, true, `${JSON.stringify(value)} must be stale`);
    assert.equal(age.unknown, true, `${JSON.stringify(value)} must be unknown`);
  }
});

test("a snapshot dated in the future is wrong, not fresh", () => {
  const now = Date.now();
  const age = freshness(new Date(now + 3 * 3_600_000).toISOString(), now);
  assert.equal(age.unknown, true, "a future timestamp must not read as live");
  assert.equal(age.stale, true);

  // Ordinary clock drift is still fresh, not alarming.
  assert.equal(freshness(new Date(now + 5_000).toISOString(), now).unknown, false);
});

test("age is described in units a reader can act on", () => {
  const now = Date.now();
  assert.match(freshness(new Date(now - 5_000).toISOString(), now).label, /^\d+s ago$/);
  assert.match(freshness(new Date(now - 600_000).toISOString(), now).label, /^\d+m ago$/);
  assert.match(freshness(new Date(now - 7_200_000).toISOString(), now).label, /^\d+h ago$/);
  assert.match(freshness(new Date(now - 3 * 86_400_000).toISOString(), now).label, /^\d+d ago$/);
});

// --- honesty about money ----------------------------------------------------

test("cost is shown with its unit and never rounded down to nothing", () => {
  assert.equal(money(0), "$0.00");
  assert.equal(money(8208), "<$0.01");
  assert.equal(money(1_500_000), "$1.50");
});

test("unpriced events are surfaced, because the total excludes them", () => {
  const withUnpriced = budgetsPanel({ budgets: { totals: { costMicros: 0, unpricedEvents: 18 } } });
  const row = withUnpriced.rows.find((r) => /unpriced/i.test(r.primary));
  assert.ok(row, "unpriced events must appear");
  assert.match(row.secondary, /not included/i);
  assert.equal(row.tone, "warn");

  const clean = budgetsPanel({ budgets: { totals: { costMicros: 0, unpricedEvents: 0 } } });
  assert.equal(clean.rows.some((r) => /unpriced/i.test(r.primary)), false);
});

// --- shapes taken from a real snapshot --------------------------------------

test("agents are read from company.agents.agents, not company.agents", () => {
  const snapshot = realisticSnapshot();
  const panel = agentsPanel(snapshot.panels);
  assert.equal(panel.rows.length, 1);
  assert.equal(panel.rows[0].primary, "Chief of Staff Agent");
});

test("the headline stats read a real snapshot correctly", () => {
  const stats = statsFrom(realisticSnapshot().panels);
  const byLabel = Object.fromEntries(stats.map((s) => [s.label, s]));
  assert.equal(byLabel.Projects.value, "1");
  assert.equal(byLabel.Agents.value, "12");
  assert.equal(byLabel["Needs you"].value, "0");
  assert.equal(byLabel["Needs you"].attention, false);
});

test("work waiting on the founder is flagged, and outranks advice", () => {
  const snapshot = realisticSnapshot();
  snapshot.panels.company.decisions = [{ question: "Ship read-only this milestone?", why: "Safe work is done." }];
  snapshot.panels.company.summary.openDecisions = 1;

  const stats = statsFrom(snapshot.panels);
  assert.equal(stats.find((s) => s.label === "Needs you").attention, true);

  const panel = attentionPanel(snapshot.panels);
  assert.equal(panel.rows[0].primary, "Ship read-only this milestone?");
  assert.equal(panel.rows[0].meta, "decision");
});

test("a panel the machine publishes but this view cannot render is reported, not dropped", () => {
  const snapshot = realisticSnapshot();
  snapshot.panels.somethingNewer = { version: 1, data: [] };
  const rendered = panelsFor(snapshot);
  const unknown = rendered.find((p) => p.title === "somethingNewer");
  assert.ok(unknown, "an unknown panel must still appear");
  assert.equal(unknown.unknown, true);
  assert.match(unknown.note, /does not know how to show it yet/);
});

test("large numbers stay readable", () => {
  assert.equal(compact(999), "999");
  assert.equal(compact(1500), "1.5k");
  assert.equal(compact(25_000), "25k");
  assert.equal(compact(3_400_000), "3.4M");
});

// --- founder intents ---------------------------------------------------------

test("a queued request is never shown as finished", async () => {
  const { intentsPanel } = await import("../../control-plane/public/render.mjs");
  const panel = intentsPanel({
    pending: [{ id: "a", kind: "task.retry", args: { taskId: "obj-1" } }],
    results: [{ id: "b", status: "done", detail: "resumed obj-2" }],
  });
  const queued = panel.rows.find((r) => r.meta === "queued");
  const finished = panel.rows.find((r) => r.meta === "done");
  assert.ok(queued, "a pending intent must read as queued");
  assert.ok(finished, "a finished intent must read as done");
  // The machine executes on its next poll; claiming otherwise is the one lie
  // this topology makes easy to tell.
  assert.notEqual(queued.meta, "done");
});

test("a failed request is visible, not quietly dropped", async () => {
  const { intentsPanel } = await import("../../control-plane/public/render.mjs");
  const panel = intentsPanel({ pending: [], results: [{ id: "b", status: "failed", detail: "no such task" }] });
  assert.equal(panel.rows[0].tone, "bad");
  assert.match(panel.rows[0].secondary, /no such task/);
});

test("the page never offers a choice the factory did not", async () => {
  const { decisionActions } = await import("../../control-plane/public/render.mjs");
  const offered = decisionActions({ id: "t:1", question: "Ship it?", options: ["A. Yes", "B. No"] });
  assert.deepEqual(offered.options, ["A. Yes", "B. No"]);
  assert.equal(offered.freeText, false);

  // No recorded options means a free-text reply, never an invented menu.
  const open = decisionActions({ id: "t:2", question: "What next?" });
  assert.deepEqual(open.options, []);
  assert.equal(open.freeText, true);
});

test("a decision without an id cannot be answered from here", async () => {
  const { answerableDecisions } = await import("../../control-plane/public/render.mjs");
  const decisions = answerableDecisions({
    company: { decisions: [{ question: "no id" }, { id: "t:1", question: "has id" }] },
  });
  assert.equal(decisions.length, 1, "an answer with nowhere to go must not be offered");
  assert.equal(decisions[0].id, "t:1");
});

test("intent rendering never throws on malformed queue data", async () => {
  const { intentsPanel, answerableDecisions } = await import("../../control-plane/public/render.mjs");
  for (const queue of [null, undefined, {}, { pending: "no" }, { results: 5 }, { pending: [null], results: [null] }]) {
    assert.doesNotThrow(() => intentsPanel(queue), `threw on ${JSON.stringify(queue)}`);
  }
  for (const panels of [null, undefined, {}, { company: { decisions: "no" } }, { company: { unavailable: true } }]) {
    assert.doesNotThrow(() => answerableDecisions(panels));
  }
});

// --- what the factory is doing ----------------------------------------------
//
// "There is no way to track what the agents are doing" was true while the
// snapshot already carried 30 activity events and 22 tasks. An agent status
// flag says "working"; an event says what it is working ON, and only the second
// answers the question.

test("the activity feed names the agent, the action and the task", async () => {
  const { activityPanel } = await import("../../control-plane/public/render.mjs");
  const panel = activityPanel({
    company: {
      activityFeed: [
        { at: new Date().toISOString(), type: "dispatch-running", stage: "reviewer", actor: "claude", taskId: "obj-c58897c0-integration", project: "lifemaxing" },
      ],
    },
  });
  assert.equal(panel.rows.length, 1);
  assert.match(panel.rows[0].primary, /claude/);
  assert.match(panel.rows[0].primary, /is running/);
  assert.match(panel.rows[0].primary, /integration/);
  assert.match(panel.rows[0].secondary, /lifemaxing/);
});

test("an unmapped event type still renders rather than vanishing", async () => {
  const { activityPanel } = await import("../../control-plane/public/render.mjs");
  const panel = activityPanel({
    company: { activityFeed: [{ at: new Date().toISOString(), type: "something-new", actor: "agent", taskId: "obj-1-node" }] },
  });
  assert.equal(panel.rows.length, 1, "a new event type is information, not a reason to drop the row");
  assert.match(panel.rows[0].primary, /something-new/);
});

test("a failure reads as a failure", async () => {
  const { activityPanel } = await import("../../control-plane/public/render.mjs");
  const panel = activityPanel({
    company: { activityFeed: [{ at: new Date().toISOString(), type: "dispatch-failed", actor: "qa", taskId: "obj-1-node" }] },
  });
  assert.equal(panel.rows[0].tone, "bad");
});

test("tasks are ordered by what is moving, not alphabetically", async () => {
  const { tasksPanel } = await import("../../control-plane/public/render.mjs");
  const old = "2026-09-01T00:00:00.000Z";
  const recent = "2026-09-14T00:00:00.000Z";
  const panel = tasksPanel({
    operations: {
      tasks: [
        { taskId: "obj-1-zzz-merged", status: "merged", updatedAt: recent },
        { taskId: "obj-1-aaa-blocked", status: "blocked", updatedAt: old },
        { taskId: "obj-1-mmm-active", status: "active", updatedAt: old },
      ],
    },
  });
  assert.deepEqual(
    panel.rows.map((r) => r.primary),
    ["mmm active", "aaa blocked", "zzz merged"],
    "active first, then blocked, then finished",
  );
});

test("a task id is readable without its objective prompt", async () => {
  const { shortTaskId } = await import("../../control-plane/public/render.mjs");
  assert.equal(shortTaskId("obj-c58897c0-integration"), "integration");
  assert.equal(shortTaskId("obj-039f0f5a-deployment-capability-core"), "deployment capability core");
  assert.equal(shortTaskId("task-ca3c3cdf"), "task-ca3c3cdf");
  // Empty, not a dash: activityPanel omits the trailing segment entirely, so a
  // missing id reads "claude is running" rather than "claude is running —".
  assert.equal(shortTaskId(null), "");
  assert.equal(shortTaskId(undefined), "");
});

test("spend is shown even when no budget policy is configured", async () => {
  const { budgetsPanel } = await import("../../control-plane/public/render.mjs");
  // `available/configured: false` means no POLICY, not no spend. Conflating the
  // two hid a real ledger behind "not configured" while the header showed the
  // very same numbers.
  const panel = budgetsPanel({
    budgets: { available: false, configured: false, totals: { costMicros: 82_000, events: 47, inputTokens: 10, outputTokens: 20 } },
  });
  const total = panel.rows.find((r) => /total cost/i.test(r.primary));
  assert.ok(total, "recorded spend must be shown");
  assert.equal(total.meta, "$0.08");
  assert.match(panel.note, /no budget policy/i);
});

test("spend with no totals at all says so", async () => {
  const { budgetsPanel } = await import("../../control-plane/public/render.mjs");
  assert.equal(budgetsPanel({ budgets: { available: false } }).rows.length, 0);
  assert.equal(budgetsPanel({}).rows.length, 0);
});

test("activity and task panels never throw on malformed data", async () => {
  const { activityPanel, tasksPanel, ago } = await import("../../control-plane/public/render.mjs");
  for (const panels of [{}, { company: null }, { company: { activityFeed: "no" } }, { operations: { tasks: 5 } }, { company: { activityFeed: [null] } }, { operations: { tasks: [null] } }]) {
    assert.doesNotThrow(() => activityPanel(panels), `activityPanel threw on ${JSON.stringify(panels)}`);
    assert.doesNotThrow(() => tasksPanel(panels), `tasksPanel threw on ${JSON.stringify(panels)}`);
  }
  for (const value of [null, undefined, 12345, "nope", {}]) assert.equal(ago(value), "unknown");
});

test("a decision carries its context and the factory's recommendation", async () => {
  const { decisionActions } = await import("../../control-plane/public/render.mjs");
  // Both were computed by the factory and dropped by the first renderer. A
  // question with no context forces the founder back to the local dashboard to
  // answer it, which defeats having a control plane they can reach anywhere.
  const offered = decisionActions({
    id: "task-ca3c3cdf:reviewer",
    project: "lifemaxing",
    question: "How should the team verify the remaining production risk?",
    why: "The reviewer cannot verify the remote production database behavior.",
    recommendation: "A: provision a temporary test database.",
    options: ["A: provision a temporary test database", "B: use the extended sandbox"],
  });
  assert.match(offered.why, /cannot verify/);
  assert.match(offered.recommendation, /temporary test database/);
  assert.equal(offered.project, "lifemaxing");
  assert.equal(offered.options.length, 2);
});

test("a decision with no context still renders", async () => {
  const { decisionActions } = await import("../../control-plane/public/render.mjs");
  const bare = decisionActions({ id: "t:1", question: "Now what?" });
  assert.equal(bare.why, "");
  assert.equal(bare.recommendation, "");
  assert.equal(bare.freeText, true);
});
