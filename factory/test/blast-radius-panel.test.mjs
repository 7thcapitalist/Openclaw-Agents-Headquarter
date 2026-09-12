import test from "node:test";
import assert from "node:assert/strict";

import { blastRadiusPanel } from "../../dashboard/backend/public/lib/blastRadiusView.mjs";

const report = (over = {}) => ({
  version: 1, available: true, enforcement: "alert-only", threshold: 20,
  summary: { runs: 4, overThreshold: 1, widestRun: 26 },
  runs: [{ runId: "run-abc", subjects: 26, atOrOverThreshold: true, actor: "backend-builder" }],
  warnings: [], ...over,
});

test("a run over the threshold is called out without claiming anything was refused", () => {
  const html = blastRadiusPanel(report());
  assert.match(html, /1 over threshold/);
  assert.match(html, /26/);
  assert.match(html, /Alert-only: nothing is refused/);
});

test("all runs within the threshold read as healthy", () => {
  const html = blastRadiusPanel(report({ summary: { runs: 4, overThreshold: 0, widestRun: 3 }, runs: [] }));
  assert.match(html, /Within threshold/);
  assert.doesNotMatch(html, /over threshold/);
});

// The distinction that matters on a factory that has not recorded reach yet:
// "nothing measured" is not the same claim as "nothing exceeded".
test("no runs measured does not read as a clean bill of health", () => {
  const html = blastRadiusPanel(report({ summary: { runs: 0, overThreshold: 0, widestRun: 0 }, runs: [] }));
  assert.match(html, /No runs measured/);
  assert.doesNotMatch(html, /Within threshold/);
  assert.match(html, /threshold of 20/);
});

test("an unreadable report says so rather than rendering zeros", () => {
  const html = blastRadiusPanel({ available: false, error: "run records unreadable" });
  assert.match(html, /Unavailable/);
  assert.match(html, /run records unreadable/);
});

test("a missing payload degrades instead of throwing", () => {
  assert.doesNotThrow(() => blastRadiusPanel(null));
  assert.match(blastRadiusPanel(null), /not available/i);
});

test("run identifiers are escaped, so state cannot inject markup", () => {
  const html = blastRadiusPanel(report({
    runs: [{ runId: "<img src=x onerror=alert(1)>", subjects: 2, atOrOverThreshold: false }],
  }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("bars share one scale, so rows are comparable to each other", () => {
  const html = blastRadiusPanel(report({
    summary: { runs: 2, overThreshold: 0, widestRun: 10 },
    runs: [{ runId: "a", subjects: 10 }, { runId: "b", subjects: 5 }],
  }));
  // Against a threshold of 20: 10 -> 50%, 5 -> 25%. Not 100%/50%.
  assert.match(html, /width:50%/);
  assert.match(html, /width:25%/);
});

test("warnings are surfaced rather than swallowed", () => {
  const html = blastRadiusPanel(report({ warnings: ["ledger partially unreadable", "b"] }));
  assert.match(html, /ledger partially unreadable/);
  assert.match(html, /\+1 more/);
});
