#!/usr/bin/env node
// Weekly cost/failure report from the holding ledger (ledger/runs.jsonl, ledger/quota.jsonl).
// Usage: node scripts/factory-weekly-cost-report.mjs [--ledger <dir>] [--cost-events <file>] [--now <iso>] [--days 7] [--json|--md]
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readCostEvents } from "../factory/lib/hq/cost-ledger.mjs";

const FAIL = /\b(fail(ed)?|falh\w*|bloquead\w*|blocked|reprov\w*|conflito|expirou|stop)\b/i;
const REWORK = /\b(redeploy|rebuild|refeit\w*|refeito|rework|refac\w*|corrigid\w*|fixed)\b/i;
const NO_REWORK = /\b0 refa/i;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const credits = (cost) => {
  const m = /([\d.,]+)\s*cr[eé]dit/i.exec(cost || "");
  return m ? Number(m[1].replace(",", ".")) || 0 : 0;
};

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function classify(row) {
  const text = String(row.result ?? "");
  if (FAIL.test(text)) return "failure";
  if (!NO_REWORK.test(text) && (REWORK.test(text) || REWORK.test(String(row.task ?? "")))) return "rework";
  return null;
}

export function costOf(row) {
  const q = row.quota_delta || {};
  return {
    quotaPct: num(q.codex) + num(q.claude),
    credits: credits(row.cost),
    minutes: num(row.minutes),
    usd: num(row.cost_usd),
  };
}

const rankKey = (c) => [c.quotaPct, c.usd, c.credits, c.minutes];
const cmp = (a, b) => { const x = rankKey(a.cost), y = rankKey(b.cost); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };

// Attempts and review comments as recorded on a ledger row (numbers, strings or arrays are accepted).
export function reviewOf(row) {
  const raw = row.review_comments;
  const comments = Array.isArray(raw) ? raw.map(String) : raw == null || raw === "" ? [] : [String(raw)];
  const attempts = Number.isFinite(row.attempts) ? row.attempts : Number.isFinite(row.tentativas) ? row.tentativas : null;
  return { attempts, comments };
}

// Cost per run from cost-events.ndjson: superseded and reversal events are dropped; unpriced events are counted, never summed as zero.
export function costByRun(events, { now = new Date(), days = 7 } = {}) {
  const since = new Date(now.getTime() - days * 864e5);
  const replaced = new Set(events.filter((e) => e.replacesEventId).map((e) => e.replacesEventId));
  const rows = new Map();
  for (const e of events) {
    const t = new Date(e.occurredAt);
    if (e.eventType === "reversal" || replaced.has(e.eventId) || t < since || t > now) continue;
    const key = e.runId || e.sourceEventId;
    const r = rows.get(key) || { run: key, task: e.taskId, stage: e.stage, model: e.model, at: e.occurredAt, tokens: 0, costMicros: 0, unpriced: 0 };
    r.tokens += e.inputTokens + e.cachedInputTokens + e.outputTokens;
    if (e.costMicros == null) r.unpriced++; else r.costMicros += e.costMicros;
    if (e.occurredAt < r.at) r.at = e.occurredAt;
    rows.set(key, r);
  }
  const runs = [...rows.values()].sort((a, b) => a.at.localeCompare(b.at) || String(a.run).localeCompare(String(b.run)));
  return { runs, total: runs.reduce((t, r) => ({ runs: t.runs + 1, tokens: t.tokens + r.tokens, costMicros: t.costMicros + r.costMicros, unpriced: t.unpriced + r.unpriced }), { runs: 0, tokens: 0, costMicros: 0, unpriced: 0 }) };
}

// Falhas agrupadas por failure_reason (SOF-89); linhas de falha sem o campo caem em "sem causa registrada".
export function failuresByCause(rows) {
  const g = new Map();
  for (const r of rows) {
    const reason = String(r.failure_reason ?? "").trim().replace(/\s+/g, " ");
    if (!reason && classify(r) !== "failure") continue;
    const key = reason || "sem causa registrada";
    const c = costOf(r);
    const e = g.get(key) || { cause: key, count: 0, cost: { quotaPct: 0, credits: 0, minutes: 0, usd: 0 } };
    e.count++;
    for (const k of Object.keys(e.cost)) e.cost[k] += c[k];
    g.set(key, e);
  }
  return [...g.values()].sort((a, b) => b.count - a.count || cmp(a, b) || a.cause.localeCompare(b.cause));
}

export function buildReport(runs, quota, { now = new Date(), days = 7, costEvents = [] } = {}) {
  const since = new Date(now.getTime() - days * 864e5);
  const inWindow = runs.map((r) => ({ ...r, at: r.at || r.ts })).filter((r) => { const t = new Date(r.at); return t >= since && t <= now; });
  const flagged = inWindow.map((r) => ({ row: r, kind: classify(r), cost: costOf(r) })).filter((x) => x.kind);
  flagged.sort(cmp);
  const latest = {};
  for (const q of quota) if (q.provider && (!latest[q.provider] || q.at > latest[q.provider].at)) latest[q.provider] = q;
  const byStudio = {};
  for (const r of inWindow) { const s = (byStudio[r.studio || "?"] ||= { runs: 0, minutes: 0, quotaPct: 0, failures: 0, reworks: 0 }); const c = costOf(r); s.runs++; s.minutes += c.minutes; s.quotaPct += c.quotaPct; const k = classify(r); if (k === "failure") s.failures++; if (k === "rework") s.reworks++; }
  const attempts = {};
  for (const r of inWindow) { const key = `${r.studio || "?"}/${r.task}`; attempts[key] = (attempts[key] || 0) + 1; }
  const retried = Object.entries(attempts).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).map(([task, attempts]) => ({ task, attempts }));
  const reviews = inWindow.map((r) => ({ studio: r.studio || "?", task: r.task, at: r.at, ...reviewOf(r) })).filter((x) => x.attempts != null || x.comments.length);
  const sum = (k) => inWindow.reduce((s, r) => s + costOf(r)[k], 0);
  return {
    failuresByCause: failuresByCause(inWindow),
    costByRun: costByRun(costEvents, { now, days }),
    since: since.toISOString(), until: now.toISOString(), rows: inWindow.length,
    failures: flagged.filter((x) => x.kind === "failure").length,
    reworks: flagged.filter((x) => x.kind === "rework").length,
    total: { quotaPct: sum("quotaPct"), credits: sum("credits"), minutes: sum("minutes"), usd: sum("usd") },
    quota: Object.fromEntries(Object.entries(latest).map(([p, q]) => [p, { usedPct: q.used_pct, sharePct: q.share_pct, resetsAt: q.resets_at, measuredAt: q.measured_at }])),
    byStudio,
    retried,
    reviews,
    top: flagged[0] ? { kind: flagged[0].kind, studio: flagged[0].row.studio, task: flagged[0].row.task, at: flagged[0].row.at, result: String(flagged[0].row.result).slice(0, 160), cost: flagged[0].cost } : null,
    ranked: flagged.slice(0, 5).map((x) => ({ kind: x.kind, studio: x.row.studio, task: x.row.task, at: x.row.at, cost: x.cost })),
  };
}

export function render(r) {
  const c = (x) => `quota ${x.quotaPct}% · ${x.credits} créditos · ${x.minutes} min · US$${x.usd}`;
  const L = [`Relatório da fábrica ${r.since.slice(0, 10)} → ${r.until.slice(0, 10)} (${r.rows} runs, ${r.failures} falhas, ${r.reworks} retrabalhos)`];
  L.push(`Custo registrado na semana: ${c(r.total)}`);
  L.push(r.top ? `Falha/retrabalho mais caro: [${r.top.kind}] ${r.top.studio}/${r.top.task} (${r.top.at}) — ${c(r.top.cost)}\n  resultado: ${r.top.result}` : "Nenhuma falha/retrabalho na janela.");
  if (r.failuresByCause?.length) L.push("Falhas por causa:", ...r.failuresByCause.map((x) => `  ${x.count}x ${x.cause} — ${c(x.cost)}`));
  if (r.ranked.length > 1) L.push("Top 5:", ...r.ranked.map((x, i) => `  ${i + 1}. [${x.kind}] ${x.studio}/${x.task} — ${c(x.cost)}`));
  const q = Object.entries(r.quota);
  L.push(q.length ? "% de quota (última medição): " + q.map(([p, v]) => `${p} ${v.usedPct}% usado (reseta ${v.resetsAt})`).join("; ") : "% de quota: sem medição");
  L.push("Nota: o ledger não tem custo por run na maioria das linhas; ranking usa quota_delta > USD > créditos > minutos, linhas sem custo valem 0.");
  return L.join("\n");
}

export function renderMarkdown(r) {
  const c = (x) => `quota ${x.quotaPct}% · ${x.credits} créditos · ${x.minutes} min · US$${x.usd}`;
  const L = [`# Relatório semanal da fábrica`, "", `${r.since.slice(0, 10)} → ${r.until.slice(0, 10)} · ${r.rows} runs`, ""];
  L.push("## Falha mais cara", "", r.top ? `> **[${r.top.kind}] ${r.top.studio}/${r.top.task}** (${r.top.at}) — ${c(r.top.cost)}` : "Nenhuma falha/retrabalho na janela.");
  if (r.top) L.push(`> resultado: ${r.top.result}`);
  L.push("");
  L.push("## Falhas por causa (failure_reason)", "");
  if (r.failuresByCause?.length) L.push("| Causa | Ocorrências | Quota (pts) | Tempo (min) |", "|---|---|---|---|", ...r.failuresByCause.map((x) => `| ${x.cause.replace(/\|/g, "\\|")} | ${x.count} | ${x.cost.quotaPct} | ${x.cost.minutes} |`), "");
  else L.push("Nenhuma falha na janela.", "");
  L.push("## Resumo", "", "| Tempo (min) | Quota (pts) | Tarefas repetidas | Falhas | Retrabalhos |", "|---|---|---|---|---|", `| ${r.total.minutes} | ${r.total.quotaPct} | ${r.retried.length} | ${r.failures} | ${r.reworks} |`, "");
  L.push("## Por estúdio", "", "| Estúdio | Runs | Tempo (min) | Quota (pts) | Falhas | Retrabalhos |", "|---|---|---|---|---|---|", ...Object.entries(r.byStudio).map(([k, v]) => `| ${k} | ${v.runs} | ${v.minutes} | ${v.quotaPct} | ${v.failures} | ${v.reworks} |`), "");
  L.push("## Tentativas (mesma tarefa rodada mais de uma vez)", "", ...(r.retried.length ? r.retried.map((x) => `- ${x.task}: ${x.attempts}x`) : ["Nenhuma."]), "");
  const usd = (m) => `US$ ${(m / 1e6).toFixed(4)}`;
  const cr = r.costByRun || { runs: [], total: { runs: 0, tokens: 0, costMicros: 0, unpriced: 0 } };
  L.push("## Custo por run (cost-events.ndjson)", "");
  if (cr.runs.length) L.push("| Run | Tarefa | Etapa | Modelo | Tokens | Custo | Sem preço |", "|---|---|---|---|---|---|---|", ...cr.runs.map((x) => `| ${x.run} | ${x.task ?? "-"} | ${x.stage ?? "-"} | ${x.model} | ${x.tokens} | ${usd(x.costMicros)} | ${x.unpriced} |`), "");
  else L.push("Sem eventos de custo na janela.", "");
  L.push(`**Total semanal:** ${usd(cr.total.costMicros)} em ${cr.total.runs} runs, ${cr.total.tokens} tokens${cr.total.unpriced ? `, ${cr.total.unpriced} eventos sem preço (não somados)` : ""}`, "");
  L.push("## Tentativas e revisão por run", "");
  if (!(r.reviews || []).length) L.push("Nenhum run com tentativas/comentários de revisão no ledger.");
  for (const x of r.reviews || []) {
    L.push(`- **${x.studio}/${x.task}** (${x.at}) — tentativas: ${x.attempts ?? "n/d"}, comentários de revisão: ${x.comments.length}`);
    for (const c of x.comments) L.push(`  - ${c.replace(/s+/g, " ").slice(0, 200)}`);
  }
  L.push("");
  const q = Object.entries(r.quota);
  L.push("## Quota (última medição)", "", ...(q.length ? q.map(([p, v]) => `- ${p}: ${v.usedPct}% usado, reseta ${v.resetsAt}`) : ["Sem medição."]), "");
  L.push("_Fonte: ledger/runs.jsonl e quota.jsonl. Linhas sem custo valem 0; ranking: quota_delta > USD > créditos > minutos._");
  return L.join("\n");
}

function opt(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = opt("ledger") || "C:/Users/joaov/dev/holding-hq/ledger";
  const events = opt("cost-events") || join(process.env.HQ_ROOT || join(dirname(fileURLToPath(import.meta.url)), ".."), ".openclaw-factory", "telemetry", "cost-events.ndjson");
  const report = buildReport(readJsonl(join(dir, "runs.jsonl")), readJsonl(join(dir, "quota.jsonl")), { now: opt("now") ? new Date(opt("now")) : new Date(), days: Number(opt("days")) || 7, costEvents: readCostEvents(events) });
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : process.argv.includes("--md") ? renderMarkdown(report) : render(report));
}
