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
test("markdown lists attempts and review_comments per run from the ledger", async () => {
  const { renderMarkdown } = await import("../../scripts/factory-weekly-cost-report.mjs");
  const rows = [
    { ts: "2026-10-21T10:00:00Z", studio: "software", task: "SOF-1", result: "pr", attempts: 3, review_comments: ["falta teste", "renomear campo"] },
    { ts: "2026-10-21T11:00:00Z", studio: "software", task: "SOF-2", result: "pr", review_comments: "ok" },
    { ts: "2026-10-21T12:00:00Z", studio: "website", task: "x", result: "deployed" },
  ];
  const r = buildReport(rows, [], { now });
  assert.equal(r.reviews.length, 2);
  const md = renderMarkdown(r);
  assert.ok(md.includes("## Tentativas e revisão por run"));
  assert.ok(md.includes("tentativas: 3, comentários de revisão: 2\n  - falta teste\n  - renomear campo"));
  assert.ok(md.includes("software/SOF-2** (2026-10-21T11:00:00Z) — tentativas: n/d, comentários de revisão: 1"));
  assert.ok(!md.includes("website/x**"));
});
test("prints average and max attempts per request from a ledger fixture", async () => {
  const { renderMarkdown, readJsonl } = await import("../../scripts/factory-weekly-cost-report.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "attempts-"));
  const rows = [
    { ts: "2026-10-21T10:00:00Z", studio: "software", task: "A", result: "pr", attempts: 1 },
    { ts: "2026-10-21T11:00:00Z", studio: "software", task: "B", result: "pr", attempts: 2 },
    { ts: "2026-10-21T12:00:00Z", studio: "software", task: "C", result: "pr", attempts: 6 },
    { ts: "2026-10-21T13:00:00Z", studio: "website", task: "D", result: "deployed" },
  ];
  writeFileSync(join(dir, "runs.jsonl"), rows.map((x) => JSON.stringify(x)).join(String.fromCharCode(10)) + String.fromCharCode(10));
  const r = buildReport(readJsonl(join(dir, "runs.jsonl")), [], { now });
  assert.deepEqual(r.attemptStats, { runs: 3, avg: 3, max: 6 });
  assert.ok(renderMarkdown(r).includes("média 3 · máximo 6"));
  assert.match(render(r), /Tentativas por pedido: média 3 · máximo 6 (3 runs)/);
  assert.equal(buildReport([], [], { now }).attemptStats.max, null);
});
