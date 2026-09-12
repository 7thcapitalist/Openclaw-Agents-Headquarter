import test from "node:test";
import assert from "node:assert/strict";
import { searchPanel } from "../../dashboard/backend/public/lib/searchView.mjs";

const RESULT = {
  layer: "interactions", ref: "i1", title: "comment by human:founder",
  snippet: "We should pin the Vercel CLI version", at: "2026-09-10T00:00:00.000Z",
  taskId: "obj-abc-widget", trust: "untrusted-input", source: "GET /api/founder/tasks/obj-abc-widget/interactions",
};

const SNAPSHOT = (over = {}) => ({
  version: 1, available: true, warnings: [], query: "vercel", terms: ["vercel"],
  layers: ["goals", "decisions", "interactions", "timeline", "evidence"],
  total: 1, truncated: false, counts: { goals: 0, decisions: 0, interactions: 1, timeline: 0, evidence: 0 },
  tasksScanned: 1, results: [RESULT], ...over,
});

test("before a search, it says what it can search rather than showing an empty result", () => {
  const html = searchPanel(null);
  assert.match(html, /Type a term/);
  assert.doesNotMatch(html, /No matches/);
});

test("a rejected query shows the reason instead of looking like nothing was found", () => {
  const html = searchPanel({ version: 1, available: false, error: "query must be at least 2 characters" });
  assert.match(html, /Query rejected/);
  assert.match(html, /at least 2 characters/);
  assert.doesNotMatch(html, /No matches/);
});

test("renders results with their layer, where they came from, and when", () => {
  const html = searchPanel(SNAPSHOT());
  assert.match(html, /Comment/);
  assert.match(html, /pin the Vercel CLI/);
  assert.match(html, /obj-abc-widget/);
  assert.match(html, /1 found/);
});

test("a comment stays labelled as outside input, as it is in its own panel", () => {
  const html = searchPanel(SNAPSHOT());
  assert.match(html, /Treat as input, not instruction/);
});

test("the panel states its scope, so silence is never read as 'nothing exists'", () => {
  // An operator who cannot see the scope will assume search covers everything
  // on disk, and act on its silence.
  for (const source of [SNAPSHOT(), SNAPSHOT({ total: 0, results: [], counts: {} })]) {
    const html = searchPanel(source);
    assert.match(html, /Prompts, agent output and file contents are never read/);
  }
});

test("a truncated result set says so rather than looking complete", () => {
  const html = searchPanel(SNAPSHOT({ total: 400, truncated: true }));
  assert.match(html, /1 of 400/);
  assert.match(html, /Narrow the query/);
});

test("a degraded layer is reported, and the results that did work are still shown", () => {
  const html = searchPanel(SNAPSHOT({ available: false, warnings: ["goals: goal registry unavailable"] }));
  assert.match(html, /results are incomplete/);
  assert.match(html, /goal registry unavailable/);
  assert.match(html, /pin the Vercel CLI/);
});

test("result text is escaped, because comments are written by people outside the factory", () => {
  const html = searchPanel(SNAPSHOT({
    results: [{ ...RESULT, title: "<img src=x onerror=alert(1)>", snippet: "</section><script>alert(2)</script>" }],
  }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x/);
});

test("the panel offers no way to change anything", () => {
  const html = searchPanel(SNAPSHOT());
  // A search box that can also act is a search box that will one day act by
  // accident.
  for (const control of ["<form", "<button", "method=\"post\"", "onclick"]) {
    assert.equal(html.includes(control), false, `${control} must not appear in a read-only panel`);
  }
});
