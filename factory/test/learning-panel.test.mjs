import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { IDLE_REASON_LABELS, idleReasonLabel, learningPanel } from "../../dashboard/backend/public/lib/learningView.mjs";

const state = (over = {}) => ({
  available: true, mode: "shadow", idleReason: "seat-unknown",
  findings: [{ id: "L-7", title: "Repeated review churn", eligible: true, evidence: ["task-7:reviewer"] }],
  launches: [{ at: "2026-09-18T10:00:00Z", findingId: "L-7", objectiveId: "obj-learning-7" }],
  wouldHaveLaunched: [], proposals: [],
  credit: { usedBySelfImprovement: 12, wouldHaveExpired: 31, basis: "estimate" }, ...over,
});

test("renders findings, evidence links, launches, credit, and current mode", () => {
  const html = learningPanel(state(), { fmtTime: () => "Sep 18" });
  for (const expected of ["Repeated review churn", "task-7:reviewer", "href=\"#/tasks\"", "obj-learning-7", "Sep 18", "from finding L-7", "used by self-improvement", "would otherwise have expired", "estimate", "value=\"shadow\" selected"]) assert.match(html, new RegExp(expected));
});

test("renders shadow and founder-awaiting activity distinctly", () => {
  const html = learningPanel(state({ launches: [], wouldHaveLaunched: [{ at: "a", findingId: "L-1", objectiveId: "obj-shadow" }], proposals: [{ at: "b", findingId: "L-2", objectiveId: "obj-proposed" }] }));
  assert.match(html, /would have launched/);
  assert.match(html, /awaiting founder/);
});

test("every specified idle code has a non-empty human label", () => {
  for (const code of Object.keys(IDLE_REASON_LABELS)) {
    const html = learningPanel(state({ launches: [], findings: [], idleReason: code }));
    assert.match(html, new RegExp(idleReasonLabel(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), code);
  }
  assert.equal(idleReasonLabel("open-pr-cap", { openPrCount: 3 }), "3 PRs awaiting founder");
  assert.equal(idleReasonLabel("unknown-new-code"), "unknown-new-code");
  assert.equal(idleReasonLabel(null), null);
});

test("current idle reason remains visible when launch history exists", () => {
  assert.match(learningPanel(state()), /Anthropic headroom unknown/);
});

test("renders empty and unavailable states", () => {
  assert.match(learningPanel(state({ findings: [], launches: [], wouldHaveLaunched: [], proposals: [] })), /No findings or launches yet/);
  assert.match(learningPanel({ available: false, error: "read failed" }), /Learning state is unavailable: read failed/);
});

test("escapes finding, evidence, objective, and error content", () => {
  const html = learningPanel(state({
    findings: [{ title: "<script>x</script>", evidence: ["<img src=x>"] }],
    launches: [{ objective: "<b>bad</b>", findingId: "<i>x</i>" }],
  }));
  assert.doesNotMatch(html, /<script>|<img|<b>bad|<i>x/);
  assert.match(html, /&lt;script&gt;/);
});

test("dashboard registers, routes, fetches, renders, navigates, and writes mode", () => {
  const app = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../../dashboard/backend/server.mjs", import.meta.url), "utf8");
  for (const token of ["#/learning", 'segs[0] === "learning"', 'apiJson("/api/hq/idle-trigger")', "learningPanel(persisted", 'r.name === "learning"', 'apiJson("/api/hq/idle-trigger/mode"']) assert.ok(app.includes(token), token);
  assert.match(app, /persisted = \{ available: false, error:/, "a fetch failure renders the unavailable state");
  assert.match(server, /app\.post\("\/api\/hq\/idle-trigger\/mode"/);
  assert.match(server, /setIdleMode/);
});
