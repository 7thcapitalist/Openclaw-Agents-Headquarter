#!/usr/bin/env node
// Painel de pedidos: tempo decorrido e % de quota gasta por pedido, lidos do ledger
// do inbox (linhas {at, key, status?}) e de cost-events.ndjson (taskId === key).
// Uso: node scripts/pedidos-status.mjs [--ledger f] [--costs f] [--quota-tokens n]
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_QUOTA_TOKENS = 5000000;

function readNdjson(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : m ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// Pedido = key. Tempo = primeira -> última linha do ledger; se o pedido ainda não
// fechou (última linha sem pr/ com status failed), conta até `now`.
export function summarizePedidos({ ledger, costEvents, quotaTokens = DEFAULT_QUOTA_TOKENS, now = Date.now() }) {
  const byKey = new Map();
  for (const row of ledger) {
    if (!row.key || !row.at) continue;
    (byKey.get(row.key) ?? byKey.set(row.key, []).get(row.key)).push(row);
  }
  const superseded = new Set(costEvents.filter((e) => e.replacesEventId).map((e) => e.replacesEventId));
  const tokensOf = (key) => costEvents
    .filter((e) => e.taskId === key && e.eventType === "usage" && !superseded.has(e.eventId))
    .reduce((sum, e) => sum + (e.inputTokens || 0) + (e.cachedInputTokens || 0) + (e.outputTokens || 0), 0);
  return [...byKey].map(([key, rows]) => {
    const first = Date.parse(rows[0].at), last = rows[rows.length - 1];
    const done = !last.status && "first_pr_tests_passed" in last;
    const end = done ? Date.parse(last.at) : now;
    const tokens = tokensOf(key);
    return {
      key, file: rows.find((r) => r.file)?.file ?? null,
      status: done ? "concluído" : last.status === "failed" ? "falhou" : "em andamento",
      elapsedMs: end - first, tokens, quotaPct: (tokens / quotaTokens) * 100,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

export function renderPedidos(rows) {
  if (!rows.length) return "Nenhum pedido no ledger.";
  return rows.map((r) => `${r.key}  ${r.status}  tempo ${formatElapsed(r.elapsedMs)}  quota ${r.quotaPct.toFixed(1)}% (${r.tokens} tokens)`).join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const root = resolve(fileURLToPath(import.meta.url), "..", "..");
  const ledger = readNdjson(opt("--ledger") ?? join(root, ".openclaw-factory", "inbox-ledger.ndjson"));
  const costEvents = readNdjson(opt("--costs") ?? join(root, ".openclaw-factory", "telemetry", "cost-events.ndjson"));
  const quotaTokens = Number(opt("--quota-tokens")) || DEFAULT_QUOTA_TOKENS;
  console.log(renderPedidos(summarizePedidos({ ledger, costEvents, quotaTokens })));
}
