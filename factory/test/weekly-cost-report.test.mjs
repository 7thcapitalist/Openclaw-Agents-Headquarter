import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, classify, render } from "../../scripts/factory-weekly-cost-report.mjs";

const now = new Date("2026-10-22T12:00:00Z");
const runs = [
  { ts: "2026-10-21T10:00:00Z", studio: "website", task: "a", result: "deployed", cost: "plan" },
  { ts: "2026-10-21T11:00:00Z", studio: "website", task: "b", result: "failed 130497", cost: "8,75 creditos Higgsfield" },
  { at: "2026-10-20T11:00:00Z", studio: "roblox", task: "c", result: "bloqueado", quota_delta: { codex: 5, claude: 1 } },
  { ts: "2026-10-21T12:00:00Z", studio: "website", task: "d", result: "deployed (manual rebuild: fix)" },
  { ts: "2026-09-01T12:00:00Z", studio: "website", task: "old", result: "failed", quota_delta: { codex: 90 } },
];
test("ranks the most expensive failure inside the window", () => {
  const r = buildReport(runs, [{ provider: "codex", at: "2026-10-21T00:00:00Z", used_pct: 67 }], { now });
  assert.equal(r.rows, 4);
  assert.equal(r.failures, 2);
  assert.equal(r.reworks, 1);
  assert.equal(r.top.task, "c");
  assert.equal(r.quota.codex.usedPct, 67);
  assert.match(render(r), /roblox\/c/);
});
test("0 refacoes is not rework", () => assert.equal(classify({ result: "lote 1 gerado, 0 refacoes" }), null));
test("markdown highlights the costliest failure and counts attempts", async () => {
  const { renderMarkdown } = await import("../../scripts/factory-weekly-cost-report.mjs");
  const r = buildReport([...runs, { ts: "2026-10-21T13:00:00Z", studio: "website", task: "a", result: "deployed", minutes: 3 }], [], { now });
  const md = renderMarkdown(r);
  assert.match(md, /## Falha mais cara\n\n> \*\*\[failure\] roblox\/c/);
  assert.deepEqual(r.retried, [{ task: "website/a", attempts: 2 }]);
  assert.match(md, /website\/a: 2x/);
});
test("green-first rate counts only kind=pr rows with a boolean, inside the window", async () => {
  const { renderMarkdown } = await import("../../scripts/factory-weekly-cost-report.mjs");
  const pr = (green_first, ts = "2026-10-21T10:00:00Z") => ({ ts, studio: "software", kind: "pr", task: "t", result: "pr aberto", green_first });
  const r = buildReport([pr(true), pr(true), pr(false), pr(undefined), pr(false, "2026-09-01T00:00:00Z")], [], { now });
  assert.deepEqual({ p: r.greenFirst.prs, g: r.greenFirst.green, r: r.greenFirst.ratePct }, { p: 3, g: 2, r: 66.7 });
  assert.ok(renderMarkdown(r).includes("**66.7%** (2 de 3 PRs) — fonte: ledger/runs.jsonl"));
  assert.ok(render(r).includes("66.7% (2/3)"));
  assert.match(render(buildReport([], [], { now })), /sem dados/);
});
