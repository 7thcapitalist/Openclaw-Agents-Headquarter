#!/usr/bin/env node
// Cost per run from the HQ cost ledger.
//
//   node scripts/hq-cost-by-run.mjs                       # HQ_ROOT or this repo
//   node scripts/hq-cost-by-run.mjs --hq-root <dir>
//   node scripts/hq-cost-by-run.mjs --split 2026-10-22T23:03:06Z   # before/after totals
//   node scripts/hq-cost-by-run.mjs --json
//
// Read-only. Format: docs/software-factory/PAPERCLIP_COST_LEDGER.md.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCostEvents, summarizeCostLedger } from "../factory/lib/hq/cost-ledger.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const hqRoot = resolve(opt("--hq-root") || process.env.HQ_ROOT || join(dirname(fileURLToPath(import.meta.url)), ".."));
const ledger = join(hqRoot, ".openclaw-factory", "telemetry", "cost-events.ndjson");
const split = opt("--split");

const events = readCostEvents(ledger);
const replaced = new Set(events.filter((e) => e.replacesEventId).map((e) => e.replacesEventId));
const rows = new Map();
for (const e of events) {
  if (e.eventType === "reversal" || replaced.has(e.eventId)) continue;
  const key = e.runId || e.sourceEventId;
  const r = rows.get(key) || { run: key, task: e.taskId, stage: e.stage, model: e.model, at: e.occurredAt, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costMicros: 0, unpriced: 0 };
  r.inputTokens += e.inputTokens; r.cachedInputTokens += e.cachedInputTokens; r.outputTokens += e.outputTokens;
  if (e.costMicros == null) r.unpriced += 1; else r.costMicros += e.costMicros;
  rows.set(key, r);
}
const list = [...rows.values()].sort((a, b) => a.at.localeCompare(b.at));
const usd = (m) => (m / 1e6).toFixed(4);
const tot = (xs) => xs.reduce((t, r) => ({ runs: t.runs + 1, tokens: t.tokens + r.inputTokens + r.cachedInputTokens + r.outputTokens, costMicros: t.costMicros + r.costMicros, unpriced: t.unpriced + r.unpriced }), { runs: 0, tokens: 0, costMicros: 0, unpriced: 0 });

if (args.includes("--json")) {
  console.log(JSON.stringify({ ledger, runs: list, total: tot(list), summary: summarizeCostLedger(events) }, null, 2));
} else if (!list.length) {
  console.log(`Sem eventos em ${ledger}`);
} else {
  console.log("run | task | stage | model | in | cached | out | usd | unpriced");
  for (const r of list) console.log([r.run, r.task, r.stage, r.model, r.inputTokens, r.cachedInputTokens, r.outputTokens, usd(r.costMicros), r.unpriced].join(" | "));
  const line = (label, xs) => { const t = tot(xs); console.log(`${label}: ${t.runs} runs, ${t.tokens} tokens, US$ ${usd(t.costMicros)}, ${t.unpriced} sem preço`); };
  if (split) {
    line(`antes de ${split}`, list.filter((r) => r.at < split));
    line(`depois de ${split}`, list.filter((r) => r.at >= split));
  }
  line("total", list);
}
