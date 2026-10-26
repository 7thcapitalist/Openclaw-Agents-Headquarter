// One-line "most expensive failure of the week" for the top of the weekly report.
// Joins failed ledger rows (failure_reason) with cost events: a cost event belongs
// to a failed run when its runId or taskId equals the ledger row's key.
import { existsSync, readFileSync } from "node:fs";

const WEEK_MS = 7 * 24 * 3600 * 1000;

export function readLedger(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try { if (line.trim()) rows.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return rows;
}

const usd = (micros) => `US$ ${(micros / 1e6).toFixed(2)}`;

// events: priced cost events ({ runId, taskId, costMicros }). Returns the failure or null.
export function costliestFailure({ ledger, events, now = new Date().toISOString() }) {
  const since = Date.parse(now) - WEEK_MS;
  const cost = new Map();
  for (const e of events) {
    if (e.costMicros == null) continue;
    for (const id of new Set([e.runId, e.taskId].filter(Boolean))) cost.set(id, (cost.get(id) || 0) + e.costMicros);
  }
  let best = null;
  for (const row of ledger) {
    if (row.status !== "failed" || !row.key) continue;
    const at = Date.parse(row.at);
    if (!(at >= since && at <= Date.parse(now))) continue;
    const costMicros = cost.get(row.key) || 0;
    if (!best || costMicros > best.costMicros) best = { run: row.key, cause: row.failure_reason || "falha desconhecida", costMicros, at: row.at };
  }
  return best;
}

export function costliestFailureLine(args) {
  const f = costliestFailure(args);
  if (!f) return "Falha mais cara da semana: nenhuma falha registrada.";
  return `Falha mais cara da semana: run ${f.run} — ${f.cause} — ${usd(f.costMicros)}`;
}

export function renderWeeklyReport({ ledger, events, now }) {
  return `${costliestFailureLine({ ledger, events, now })}\n\n# Relatório semanal da fábrica (até ${now.slice(0, 10)})\n`;
}
