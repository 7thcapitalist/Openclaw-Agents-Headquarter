#!/usr/bin/env node
// Weekly cost/failure report from the holding ledger (ledger/runs.jsonl, ledger/quota.jsonl).
// Usage: node scripts/factory-weekly-cost-report.mjs [--ledger <dir>] [--now <iso>] [--days 7] [--json|--md]
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

// PR first-submission metric. Source rows: ledger/runs.jsonl with kind:"pr" and boolean green_first
// (tests/lint green on the first push of the PR). Rows without that boolean are not counted.
export function greenFirst(rows) {
  const prs = rows.filter((r) => r.kind === "pr" && typeof r.green_first === "boolean");
  const green = prs.filter((r) => r.green_first).length;
  return { prs: prs.length, green, ratePct: prs.length ? Math.round((green / prs.length) * 1000) / 10 : null, source: "ledger/runs.jsonl (kind=pr, green_first)" };
}

export function buildReport(runs, quota, { now = new Date(), days = 7 } = {}) {
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
  const sum = (k) => inWindow.reduce((s, r) => s + costOf(r)[k], 0);
  return {
    since: since.toISOString(), until: now.toISOString(), rows: inWindow.length,
    failures: flagged.filter((x) => x.kind === "failure").length,
    reworks: flagged.filter((x) => x.kind === "rework").length,
    total: { quotaPct: sum("quotaPct"), credits: sum("credits"), minutes: sum("minutes"), usd: sum("usd") },
    quota: Object.fromEntries(Object.entries(latest).map(([p, q]) => [p, { usedPct: q.used_pct, sharePct: q.share_pct, resetsAt: q.resets_at, measuredAt: q.measured_at }])),
    byStudio,
    greenFirst: greenFirst(inWindow),
    retried,
    top: flagged[0] ? { kind: flagged[0].kind, studio: flagged[0].row.studio, task: flagged[0].row.task, at: flagged[0].row.at, result: String(flagged[0].row.result).slice(0, 160), cost: flagged[0].cost } : null,
    ranked: flagged.slice(0, 5).map((x) => ({ kind: x.kind, studio: x.row.studio, task: x.row.task, at: x.row.at, cost: x.cost })),
  };
}

export function render(r) {
  const c = (x) => `quota ${x.quotaPct}% · ${x.credits} créditos · ${x.minutes} min · US$${x.usd}`;
  const L = [`Relatório da fábrica ${r.since.slice(0, 10)} → ${r.until.slice(0, 10)} (${r.rows} runs, ${r.failures} falhas, ${r.reworks} retrabalhos)`];
  L.push(`Custo registrado na semana: ${c(r.total)}`);
  L.push(r.greenFirst.prs ? `PRs com testes verdes no 1º envio: ${r.greenFirst.ratePct}% (${r.greenFirst.green}/${r.greenFirst.prs}) — fonte: ${r.greenFirst.source}` : "PRs com testes verdes no 1º envio: sem dados (nenhuma linha kind=pr com green_first na janela)");
  L.push(r.top ? `Falha/retrabalho mais caro: [${r.top.kind}] ${r.top.studio}/${r.top.task} (${r.top.at}) — ${c(r.top.cost)}\n  resultado: ${r.top.result}` : "Nenhuma falha/retrabalho na janela.");
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
  L.push("## PRs com testes verdes no 1º envio", "", r.greenFirst.prs ? `**${r.greenFirst.ratePct}%** (${r.greenFirst.green} de ${r.greenFirst.prs} PRs) — fonte: ${r.greenFirst.source}` : "Sem dados: nenhuma linha `kind=pr` com `green_first` na janela.", "");
  L.push("## Resumo", "", "| Tempo (min) | Quota (pts) | Tarefas repetidas | Falhas | Retrabalhos |", "|---|---|---|---|---|", `| ${r.total.minutes} | ${r.total.quotaPct} | ${r.retried.length} | ${r.failures} | ${r.reworks} |`, "");
  L.push("## Por estúdio", "", "| Estúdio | Runs | Tempo (min) | Quota (pts) | Falhas | Retrabalhos |", "|---|---|---|---|---|---|", ...Object.entries(r.byStudio).map(([k, v]) => `| ${k} | ${v.runs} | ${v.minutes} | ${v.quotaPct} | ${v.failures} | ${v.reworks} |`), "");
  L.push("## Tentativas (mesma tarefa rodada mais de uma vez)", "", ...(r.retried.length ? r.retried.map((x) => `- ${x.task}: ${x.attempts}x`) : ["Nenhuma."]), "");
  const q = Object.entries(r.quota);
  L.push("## Quota (última medição)", "", ...(q.length ? q.map(([p, v]) => `- ${p}: ${v.usedPct}% usado, reseta ${v.resetsAt}`) : ["Sem medição."]), "");
  L.push("_Fonte: ledger/runs.jsonl e quota.jsonl. Linhas sem custo valem 0; ranking: quota_delta > USD > créditos > minutos._");
  return L.join("\n");
}

function opt(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = opt("ledger") || "C:/Users/joaov/dev/holding-hq/ledger";
  const report = buildReport(readJsonl(join(dir, "runs.jsonl")), readJsonl(join(dir, "quota.jsonl")), { now: opt("now") ? new Date(opt("now")) : new Date(), days: Number(opt("days")) || 7 });
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : process.argv.includes("--md") ? renderMarkdown(report) : render(report));
}
