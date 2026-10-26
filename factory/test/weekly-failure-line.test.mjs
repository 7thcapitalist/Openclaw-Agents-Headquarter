import test from "node:test";
import assert from "node:assert/strict";
import { costliestFailureLine, renderWeeklyReport } from "../lib/hq/weekly-failure-line.mjs";

const now = "2026-10-25T12:00:00.000Z";
const ledger = [
  { at: "2026-10-24T10:00:00.000Z", key: "aaa111", status: "failed", failure_reason: "quota esgotada" },
  { at: "2026-10-23T10:00:00.000Z", key: "bbb222", status: "failed", failure_reason: "testes quebraram" },
  { at: "2026-10-01T10:00:00.000Z", key: "old000", status: "failed", failure_reason: "antiga" },
  { at: "2026-10-24T11:00:00.000Z", key: "ok0001", pr: 5 },
];
const events = [
  { runId: "aaa111", costMicros: 1_500_000 },
  { runId: "aaa111", costMicros: 500_000 },
  { taskId: "bbb222", costMicros: 900_000 },
  { runId: "old000", costMicros: 99_000_000 },
  { runId: "ok0001", costMicros: 50_000_000 },
];

test("fixture: linha no topo com run, causa e custo", () => {
  const out = renderWeeklyReport({ ledger, events, now });
  assert.equal(out.split("\n")[0], "Falha mais cara da semana: run aaa111 — quota esgotada — US$ 2.00");
});

test("semana sem falhas", () => {
  const line = costliestFailureLine({ ledger: [ledger[3], ledger[2]], events, now });
  assert.equal(line, "Falha mais cara da semana: nenhuma falha registrada.");
});
