import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgentProductivity } from "../../scripts/factory-doctor.mjs";

const CONFIG = JSON.stringify({
  agents: {
    entries: {
      architect: { model: { primary: "anthropic/claude-sonnet-5" } },
      reviewer: { model: { primary: "anthropic/claude-sonnet-5" } },
      qa: { model: { primary: "github-copilot/gpt-4.1" } },
      security: { model: { primary: "anthropic/claude-sonnet-5" } },
      release: { model: { primary: "anthropic/claude-sonnet-5" } },
    },
  },
});

function hq(dispatches) {
  const root = mkdtempSync(join(tmpdir(), "doctor-productivity-"));
  const dir = join(root, "dashboard", "backend", "data", "factory", "proj", "tasks", "t1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, task: { id: "t1" }, dispatches }));
  return root;
}

const ok = (stage, model, outcome = "pass") => ({
  stage, kind: "stage", status: "completed", outcome, summary: `${stage} did its job`,
  usage: { provider: model.split("/")[0], model: model.split("/")[1] },
});

// `openclaw models` proves a seat authenticates. It cannot tell you whether the
// model behind a role can finish an agentic task — which is exactly how the qa
// gate sat broken on lifemaxing while every health check read green.
test("a gate whose route never produced an artifact is flagged, with the route", () => {
  const root = hq([
    ok("product", "openai/gpt-5.6-sol"),
    ok("reviewer", "anthropic/claude-sonnet-5"),
    // The real shape: two qa dispatches on gpt-4.1, neither leaving an artifact.
    { stage: "qa", kind: "stage", status: "completed", outcome: "fail", summary: "qa agent could not run: the qa agent (qa) produced no result file", usage: { provider: "github-copilot", model: "gpt-4.1" } },
    { stage: "qa", kind: "stage", status: "failed", error: "qa dispatch wrote no result file (session agent:qa:factory-x)" },
  ]);
  const r = checkAgentProductivity(root, CONFIG);
  assert.equal(r.level, "warn");
  assert.match(r.line, /qa via github-copilot\/gpt-4\.1/);
  assert.match(r.line, /2 dispatches, 0 artifacts/);
  assert.match(r.detail, /qa=github-copilot\/gpt-4\.1/);
  assert.match(r.detail, /re-point it at a model that does/);
});

test("a gate that has produced an artifact on its route is not flagged", () => {
  const root = hq([
    { stage: "qa", kind: "stage", status: "failed", error: "qa dispatch wrote no result file" },
    { stage: "qa", kind: "stage", status: "failed", error: "qa dispatch wrote no result file" },
    // Re-pointed at a model that finishes: a real FAIL verdict is an artifact.
    ok("qa", "anthropic/claude-sonnet-5", "fail"),
  ]);
  const r = checkAgentProductivity(root, CONFIG);
  assert.equal(r.level, "ok");
});

// Recovery dispatches carry the failed stage's name but run on a different
// route. Counting them let a working recovery agent mask a dead gate agent —
// which is why the first version of this check reported the qa outage as fine.
test("recovery dispatches do not mask a dead gate route", () => {
  const root = hq([
    { stage: "qa", kind: "stage", status: "failed", error: "qa dispatch wrote no result file" },
    { stage: "qa", kind: "stage", status: "failed", error: "qa dispatch wrote no result file" },
    { stage: "qa", kind: "recovery-diagnose", status: "completed", outcome: "pass", summary: "diagnosed", usage: { provider: "openai", model: "gpt-5.6-sol" } },
    { stage: "qa", kind: "recovery-verify", status: "completed", outcome: "pass", summary: "verified", usage: { provider: "github-copilot", model: "gpt-4.1" } },
  ]);
  const r = checkAgentProductivity(root, CONFIG);
  assert.equal(r.level, "warn");
  assert.match(r.line, /qa via/);
});

test("one bad dispatch is not enough to accuse a route", () => {
  const root = hq([{ stage: "qa", kind: "stage", status: "failed", error: "qa dispatch wrote no result file" }]);
  assert.equal(checkAgentProductivity(root, CONFIG).level, "ok");
});

test("no history is not a complaint", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-productivity-empty-"));
  const r = checkAgentProductivity(root, CONFIG);
  assert.equal(r.level, "ok");
  assert.match(r.line, /no dispatch history/);
});
