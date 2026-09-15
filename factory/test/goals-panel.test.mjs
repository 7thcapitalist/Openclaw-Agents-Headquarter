import test from "node:test";
import assert from "node:assert/strict";
import { goalsPanel } from "../../dashboard/backend/public/lib/goalsView.mjs";

const SNAPSHOT = {
  version: 1,
  available: true,
  configured: true,
  warnings: [],
  summary: { state: "blocked", percent: 40, total: 10, complete: 4, blocked: 2, active: 1, pending: 3 },
  roots: [{
    id: "company", level: "company", title: "Run a factory the founder controls", projectId: null, objectiveId: null,
    progress: { state: "blocked", percent: 40, total: 10, complete: 4, blocked: 2, active: 1, pending: 3 },
    children: [{
      id: "project-hq", level: "project", title: "Operate HQ", projectId: "openclaw-factory", objectiveId: null,
      progress: { state: "active", percent: 50, total: 4, complete: 2, blocked: 0, active: 1, pending: 1 },
      children: [],
    }],
  }],
};

test("renders an honest unavailable state", () => {
  const html = goalsPanel(null);
  assert.match(html, /Unavailable/);
  assert.match(html, /not available/);
});

test("tells the founder how to configure goals instead of showing a fake zero", () => {
  const html = goalsPanel({ version: 1, available: true, configured: false, warnings: [], summary: {}, roots: [] });
  assert.match(html, /Not configured/);
  assert.match(html, /factory\/goals\.json/);
  assert.doesNotMatch(html, /0%/);
});

test("renders the hierarchy, rollups, and blocked counts", () => {
  const html = goalsPanel(SNAPSHOT);
  assert.match(html, /Run a factory the founder controls/);
  assert.match(html, /Operate HQ/);
  assert.match(html, /4 of 10 tracked units complete/);
  assert.match(html, /2 blocked/);
  assert.match(html, /40% · 4\/10/);
  assert.match(html, /50% · 2\/4/);
  assert.match(html, /goal projection/);
});

test("a goal with no linked canonical work says so rather than reporting 0%", () => {
  const html = goalsPanel({
    ...SNAPSHOT,
    roots: [{ ...SNAPSHOT.roots[0], progress: { state: "unavailable", percent: 0, total: 0, complete: 0, blocked: 0, active: 0 }, children: [] }],
  });
  assert.match(html, /No linked work/);
});

test("labels degraded data instead of presenting incomplete totals as fact", () => {
  const html = goalsPanel({ ...SNAPSHOT, available: false, warnings: ["objective obj-1 state unavailable"] });
  assert.match(html, /totals are incomplete/);
});

test("escapes goal titles and project identifiers", () => {
  const html = goalsPanel({
    ...SNAPSHOT,
    roots: [{ ...SNAPSHOT.roots[0], title: "<script>alert(1)</script>", projectId: "\"><img src=x>", children: [] }],
  });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;script&gt;/);
});

test("the progress bar carries an accessible label and a bounded width", () => {
  const html = goalsPanel({ ...SNAPSHOT, summary: { ...SNAPSHOT.summary, percent: -5 } });
  assert.match(html, /role="img" aria-label="0 percent of tracked work complete"/);
  assert.match(html, /style="width:0%"/);
  assert.match(goalsPanel(SNAPSHOT), /aria-labelledby="factory-goals-title"/);
});

// Every state the projection can emit must render as itself. `partial` and
// `unknown` exist so incomplete data cannot be mistaken for progress; falling
// through to a generic label would defeat them.

test("a partly-tracked rollup shows the label, not a misleadingly exact percentage", () => {
  const html = goalsPanel({
    ...SNAPSHOT,
    summary: { state: "partial", percent: 100, total: 2, complete: 2, blocked: 0, active: 0, unknown: 0, unavailable: 1 },
    roots: [{ ...SNAPSHOT.roots[0], progress: { state: "partial", percent: 100, total: 2, complete: 2, blocked: 0, active: 0, unavailable: 1 }, children: [] }],
  });
  assert.match(html, /Partly tracked/);
  assert.doesNotMatch(html, /100% · 2\/2/, "a partial rollup must not present an exact percentage");
  assert.match(html, /1 goal with no linked work/);
});

test("an unrecognised canonical status is surfaced, not hidden", () => {
  const html = goalsPanel({
    ...SNAPSHOT,
    summary: { state: "unknown", percent: 0, total: 1, complete: 0, blocked: 0, active: 0, unknown: 1 },
    roots: [{ ...SNAPSHOT.roots[0], progress: { state: "unknown", percent: 0, total: 1, complete: 0, blocked: 0, active: 0, unknown: 1 }, children: [] }],
  });
  assert.match(html, /Unrecognised state/);
  assert.match(html, /1 unrecognised/);
});
