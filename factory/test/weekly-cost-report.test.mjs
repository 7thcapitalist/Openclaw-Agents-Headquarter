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
