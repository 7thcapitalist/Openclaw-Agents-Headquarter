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

test("markdown snapshot: cost by run table and weekly total from cost-events", async () => {
  const { renderMarkdown } = await import("../../scripts/factory-weekly-cost-report.mjs");
  const ev = (o) => ({ version: 1, eventType: "usage", model: "claude-sonnet-5-5", inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, costMicros: 1500000, stage: "gate", ...o });
  const costEvents = [
    ev({ eventId: "e1", sourceEventId: "s1", runId: "run-a", taskId: "SOF-1", occurredAt: "2026-10-21T10:00:00Z" }),
    ev({ eventId: "e2", sourceEventId: "s2", runId: "run-a", taskId: "SOF-1", occurredAt: "2026-10-21T10:05:00Z", costMicros: 500000 }),
    ev({ eventId: "e3", sourceEventId: "s3", runId: "run-b", taskId: "SOF-2", occurredAt: "2026-10-21T11:00:00Z", costMicros: null }),
    ev({ eventId: "e4", sourceEventId: "s4", runId: "run-old", taskId: "SOF-3", occurredAt: "2026-09-01T11:00:00Z" }),
  ];
  const md = renderMarkdown(buildReport(runs, [], { now, costEvents }));
  const section = md.slice(md.indexOf("## Custo por run"), md.indexOf("## Quota"));
  assert.equal(section, [
    "## Custo por run (cost-events.ndjson)", "",
    "| Run | Tarefa | Etapa | Modelo | Tokens | Custo | Sem preço |", "|---|---|---|---|---|---|---|",
    "| run-a | SOF-1 | gate | claude-sonnet-5-5 | 300 | US$ 2.0000 | 0 |",
    "| run-b | SOF-2 | gate | claude-sonnet-5-5 | 150 | US$ 0.0000 | 1 |", "",
    "**Total semanal:** US$ 2.0000 em 2 runs, 450 tokens, 1 eventos sem preço (não somados)", "", "",
  ].join("\n"));
});

test("failures grouped by failure_reason with count, 3 causes", async () => {
  const { renderMarkdown } = await import("../../scripts/factory-weekly-cost-report.mjs");
  const f = (task, failure_reason, extra = {}) => ({ ts: "2026-10-21T10:00:00Z", studio: "software", task, result: "failed", failure_reason, ...extra });
  const rows = [
    f("t1", "teste falhou: assert"), f("t2", "teste falhou: assert", { quota_delta: { codex: 4 } }),
    f("t3", "timeout no gate"), f("t4", "  conflito   de merge "),
    f("t5", undefined), // falha antiga sem failure_reason
    { ts: "2026-10-21T10:00:00Z", studio: "software", task: "ok", result: "deployed" },
    f("old", "teste falhou: assert", { ts: "2026-09-01T10:00:00Z" }),
  ];
  const r = buildReport(rows, [], { now });
  assert.deepEqual(r.failuresByCause.map((x) => [x.cause, x.count]), [
    ["teste falhou: assert", 2], ["conflito de merge", 1], ["sem causa registrada", 1], ["timeout no gate", 1],
  ]);
  assert.equal(r.failuresByCause[0].cost.quotaPct, 4);
  assert.match(renderMarkdown(r), /\| teste falhou: assert \| 2 \| 4 \| 0 \|/);
  assert.match(render(r), /2x teste falhou: assert/);
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
