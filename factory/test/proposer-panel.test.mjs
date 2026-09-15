import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { proposerPanel } from "../../dashboard/backend/public/lib/proposerView.mjs";

const proposal = (over = {}) => ({
  rank: 1, kind: "unblock",
  title: "OpenClaw Agents Headquarter is the canonical operational layer",
  why: "12 items of 20 under this goal are blocked, and 2 still active.",
  goalId: "project-openclaw-factory", goalLevel: "project", projectId: "openclaw-factory",
  evidence: { blocked: 12, total: 20, active: 2, complete: 0, percent: 0, source: "goal projection" },
  ...over,
});

// Deliberately changed from the original "a ranked proposal shows its reasoning
// and the numbers behind it" test: that test used to assert `Source: goal
// projection` was rendered. This panel now drops the raw provenance line for
// every proposal (the "Ranked from canonical state" lede already says where the
// numbers come from), while still showing the reasoning and evidence a founder
// needs to check the ranking, per the approved architecture plan and the
// reviewer's finding that suppressing why/the bar was an undisclosed regression.
test("a ranked proposal shows its reasoning and the numbers behind it, without a raw provenance line", () => {
  const html = proposerPanel({ available: true, proposals: [proposal()], considered: { goals: 3 } });
  assert.match(html, /12 items of 20/);
  assert.match(html, /12 blocked/);
  assert.match(html, /openclaw-factory/);
  assert.doesNotMatch(html, /Source: goal projection/);
});

test("the Proposed work panel is wired to the proposals payload, not goal projection data", () => {
  const source = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");
  assert.match(source, /const \[[^\]]*\bproposals\b[^\]]*\] = await Promise\.all/);
  assert.match(source, /apiJson\("\/api\/hq\/proposals"\)/);
  assert.match(source, /proposerPanel\(proposals,/);

  const html = proposerPanel({ available: true, proposals: [], considered: { goals: 1 } });
  assert.match(html, /Nothing is blocked, recurring or untouched across 1 goal/);
  assert.doesNotMatch(html, /goal projection/i);
});

test("the panel states that it never starts work", () => {
  const html = proposerPanel({ available: true, proposals: [proposal()] });
  assert.match(html, /nothing here is started automatically/i);
});

// The distinction the whole panel rests on: "nothing to propose" is good news,
// "nothing to propose from" means the inputs are missing and it is blind.
test("no proposals reads as clear, not as broken", () => {
  const html = proposerPanel({ available: true, proposals: [], considered: { goals: 4 } });
  assert.match(html, /Clear/);
  assert.match(html, /Nothing is blocked, recurring or untouched across 4 goals/);
});

test("no goals configured reads as not configured, never as clear", () => {
  const html = proposerPanel({ available: false, proposals: [] });
  assert.match(html, /Not configured/);
  assert.doesNotMatch(html, /Clear/);
  assert.match(html, /factory\/goals\.json/);
});

test("a missing payload degrades instead of throwing", () => {
  assert.doesNotThrow(() => proposerPanel(null));
  assert.match(proposerPanel(null), /not available/i);
  assert.doesNotThrow(() => proposerPanel({ available: true }));
});

test("warnings are surfaced rather than swallowed", () => {
  const html = proposerPanel({ available: true, proposals: [], warnings: ["goal registry unavailable", "b"] });
  assert.match(html, /goal registry unavailable/);
  assert.match(html, /\+1 more/);
});

test("proposal text is escaped, so state cannot inject markup into the view", () => {
  const html = proposerPanel({
    available: true,
    proposals: [proposal({ title: "<img src=x onerror=alert(1)>", why: "<script>bad()</script>" })],
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.match(html, /&lt;img src=x/);
});

test("the evidence bar is omitted rather than drawn to a zero scale", () => {
  const html = proposerPanel({
    available: true,
    proposals: [proposal({ kind: "systemic", evidence: { occurrences: 3, threshold: 2, source: "learning findings" } })],
  });
  assert.doesNotMatch(html, /proposer-bar/);
  assert.match(html, /Recurring/);
});

test("a neglected-only list is not styled as needing attention", () => {
  const html = proposerPanel({
    available: true,
    proposals: [proposal({ kind: "neglected", why: "4 of 5 items remain", evidence: { remaining: 4, total: 5, source: "x" } })],
  });
  assert.match(html, /Suggestions/);
  assert.match(html, /Untouched/);
});
