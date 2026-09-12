import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildWorkProposals, rankProposals, DEFAULT_LIMIT } from "../lib/hq/proposer.mjs";

// A goal as the projection actually emits it (factory/lib/hq/goals.mjs).
function goal(id, progress, { level = "project", children = [], title = null, projectId = null } = {}) {
  return {
    id, level, title: title || `goal ${id}`, parentId: null,
    projectId, objectiveId: null, children,
    progress: { state: "active", percent: 0, total: 0, complete: 0, blocked: 0, active: 0, unknown: 0, ...progress },
  };
}

// ── the hard rule ─────────────────────────────────────────────────────────

test("proposes nothing when there is nothing in canonical state", () => {
  assert.deepEqual(rankProposals({ goals: [], findings: [] }), []);
});

test("every proposal points at something real — never an invented objective", () => {
  const proposals = rankProposals({
    goals: [goal("g1", { total: 4, blocked: 2 })],
    findings: [{ title: "flaky release seat", occurrences: 3 }],
  });
  assert.equal(proposals.length, 2);
  for (const p of proposals) {
    const referent = p.goalId || p.title;
    assert.ok(referent, "a proposal with no referent is an invented objective");
    assert.ok(p.evidence.source, "every proposal must name where its evidence came from");
  }
});

// ── candidate selection ───────────────────────────────────────────────────

test("blocked work is attributed to the leaf, never double-counted up the tree", () => {
  // The company goal reads blocked only because its child is. Counting both
  // would report the same 3 tasks twice and rank the useless parent first.
  const child = goal("child", { total: 5, blocked: 3 });
  const parent = goal("parent", { total: 5, blocked: 3 }, { level: "company", children: [child] });
  const proposals = rankProposals({ goals: [parent] });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].goalId, "child");
});

test("a goal being worked on is not proposed as neglected", () => {
  const proposals = rankProposals({ goals: [goal("g", { total: 4, complete: 1, active: 3 })] });
  assert.deepEqual(proposals, []);
});

test("a finished goal is not proposed", () => {
  const proposals = rankProposals({ goals: [goal("g", { total: 4, complete: 4 })] });
  assert.deepEqual(proposals, []);
});

test("a goal with nothing recorded is silence, not neglect", () => {
  // total 0 means no canonical work exists to judge. Proposing it would be
  // inventing a referent out of an empty projection.
  const proposals = rankProposals({ goals: [goal("g", { total: 0 })] });
  assert.deepEqual(proposals, []);
});

test("neglect is work nobody picked up — no active, no blockage, not done", () => {
  const proposals = rankProposals({ goals: [goal("g", { total: 5, complete: 1 })] });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, "neglected");
  assert.equal(proposals[0].evidence.remaining, 4);
});

test("a finding below the founder's threshold is not yet a pattern", () => {
  const findings = [{ title: "seen once", occurrences: 1 }, { title: "seen twice", occurrences: 2 }];
  const proposals = rankProposals({ goals: [], findings, threshold: 2 });
  assert.deepEqual(proposals.map((p) => p.title), ["seen twice"]);
});

test("a finding with no title is dropped rather than rendered blank", () => {
  const proposals = rankProposals({ goals: [], findings: [{ occurrences: 9 }], threshold: 2 });
  assert.deepEqual(proposals, []);
});

// ── ranking ───────────────────────────────────────────────────────────────

test("blocked work outranks a systemic finding, which outranks neglect", () => {
  const proposals = rankProposals({
    goals: [goal("blocked", { total: 2, blocked: 1 }), goal("idle", { total: 9, complete: 0 })],
    findings: [{ title: "pattern", occurrences: 2 }],
    threshold: 2,
    limit: 5,
  });
  assert.deepEqual(proposals.map((p) => p.kind), ["unblock", "systemic", "neglected"]);
});

test("within a kind, the larger problem ranks first", () => {
  const proposals = rankProposals({
    goals: [goal("small", { total: 20, blocked: 1 }), goal("big", { total: 20, blocked: 12 })],
    limit: 5,
  });
  assert.deepEqual(proposals.map((p) => p.goalId), ["big", "small"]);
});

test("ties order deterministically, so the panel does not reshuffle between reads", () => {
  const goals = [goal("b", { total: 4, blocked: 2 }), goal("a", { total: 4, blocked: 2 })];
  const once = rankProposals({ goals, limit: 5 }).map((p) => p.goalId);
  const twice = rankProposals({ goals: [...goals].reverse(), limit: 5 }).map((p) => p.goalId);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, ["a", "b"]);
});

test("the list is capped, and three is the default", () => {
  const goals = Array.from({ length: 9 }, (_, i) => goal(`g${i}`, { total: 10, blocked: i + 1 }));
  assert.equal(rankProposals({ goals }).length, DEFAULT_LIMIT);
  assert.equal(DEFAULT_LIMIT, 3);
  assert.equal(rankProposals({ goals, limit: 1 }).length, 1);
  assert.equal(rankProposals({ goals, limit: 0 }).length, 0);
});

test("ranks are contiguous from 1", () => {
  const goals = Array.from({ length: 3 }, (_, i) => goal(`g${i}`, { total: 10, blocked: i + 1 }));
  assert.deepEqual(rankProposals({ goals }).map((p) => p.rank), [1, 2, 3]);
});

// ── the reason shown to the founder ───────────────────────────────────────

test("every proposal explains itself in numbers the founder can check", () => {
  const [p] = rankProposals({ goals: [goal("g", { total: 20, blocked: 12, active: 2 })] });
  assert.match(p.why, /12 items of 20/);
  assert.match(p.why, /2 still active/);
});

test("singular and plural both read correctly", () => {
  const [one] = rankProposals({ goals: [goal("g", { total: 3, blocked: 1 })] });
  assert.match(one.why, /1 item of 3 under this goal is blocked/);
  assert.match(one.why, /nothing active/);
});

// ── degradation ───────────────────────────────────────────────────────────

function hq() {
  const root = mkdtempSync(join(tmpdir(), "hq-proposer-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "factory.config.json"),
    JSON.stringify({ learning: { patternThreshold: 4 } }), "utf8");
  return root;
}

test("an HQ with no goals reports unavailable rather than proposing blindly", () => {
  const snapshot = buildWorkProposals({ hqRoot: hq() });
  assert.equal(snapshot.available, false);
  assert.deepEqual(snapshot.proposals, []);
  // "nothing to propose" and "nothing to propose from" must stay distinguishable.
  assert.equal(typeof snapshot.considered.goals, "number");
});

test("it reads the founder's pattern threshold, not one of its own", () => {
  assert.equal(buildWorkProposals({ hqRoot: hq() }).threshold, 4);
});

test("a malformed config costs the threshold, never the snapshot", () => {
  const root = hq();
  writeFileSync(join(root, "factory", "factory.config.json"), "{ not json", "utf8");
  const snapshot = buildWorkProposals({ hqRoot: root });
  assert.equal(snapshot.threshold, 2);
  assert.ok(Array.isArray(snapshot.proposals));
});

test("it never throws, whatever it is handed", () => {
  assert.doesNotThrow(() => buildWorkProposals({ hqRoot: "/nonexistent/path/xyz" }));
  assert.doesNotThrow(() => buildWorkProposals({}));
  assert.doesNotThrow(() => rankProposals({ goals: [null, undefined, {}], findings: [null] }));
});

test("it declares itself report-only", () => {
  // The contract the panel relies on to say so, and the guarantee that nothing
  // here promotes work on its own.
  assert.equal(buildWorkProposals({ hqRoot: hq() }).reportOnly, true);
});
