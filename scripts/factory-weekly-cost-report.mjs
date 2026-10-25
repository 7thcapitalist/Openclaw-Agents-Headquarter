#!/usr/bin/env node
// Weekly cost/failure report from the holding ledger (ledger/runs.jsonl, ledger/quota.jsonl).
// Usage: node scripts/factory-weekly-cost-report.mjs [--ledger <dir>] [--now <iso>] [--days 7] [--json]
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

export function buildReport(runs, quota, { now = new Date(), days = 7 } = {}) {
  const since = new Date(now.getTime() - days * 864e5);
  const inWindow = runs.map((r) => ({ ...r, at: r.at || r.ts })).filter((r) => { const t = new Date(r.at); return t >= since && t <= now; });
  const flagged = inWindow.map((r) => ({ row: r, kind: classify(r), cost: costOf(r) })).filter((x) => x.kind);
  flagged.sort(cmp);
  const latest = {};
  for (const q of quota) if (q.provider && (!latest[q.provider] || q.at > latest[q.provider].at)) latest[q.provider] = q;
  const sum = (k) => inWindow.reduce((s, r) => s + costOf(r)[k], 0);
  return {
    since: since.toISOString(), until: now.toISOString(), rows: inWindow.length,
    failures: flagged.filter((x) => x.kind === "failure").length,
    reworks: flagged.filter((x) => x.kind === "rework").length,
    total: { quotaPct: sum("quotaPct"), credits: sum("credits"), minutes: sum("minutes"), usd: sum("usd") },
    quota: Object.fromEntries(Object.entries(latest).map(([p, q]) => [p, { usedPct: q.used_pct, sharePct: q.share_pct, resetsAt: q.resets_at, measuredAt: q.measured_at }])),
    top: flagged[0] ? { kind: flagged[0].kind, studio: flagged[0].row.studio, task: flagged[0].row.task, at: flagged[0].row.at, result: String(flagged[0].row.result).slice(0, 160), cost: flagged[0].cost } : null,
    ranked: flagged.slice(0, 5).map((x) => ({ kind: x.kind, studio: x.row.studio, task: x.row.task, at: x.row.at, cost: x.cost })),
  };
}

export function render(r) {
  const c = (x) => `quota ${x.quotaPct}% · ${x.credits} créditos · ${x.minutes} min · US$${x.usd}`;
  const L = [`Relatório da fábrica ${r.since.slice(0, 10)} → ${r.until.slice(0, 10)} (${r.rows} runs, ${r.failures} falhas, ${r.reworks} retrabalhos)`];
  L.push(`Custo registrado na semana: ${c(r.total)}`);
  L.push(r.top ? `Falha/retrabalho mais caro: [${r.top.kind}] ${r.top.studio}/${r.top.task} (${r.top.at}) — ${c(r.top.cost)}\n  resultado: ${r.top.result}` : "Nenhuma falha/retrabalho na janela.");
  if (r.ranked.length > 1) L.push("Top 5:", ...r.ranked.map((x, i) => `  ${i + 1}. [${x.kind}] ${x.studio}/${x.task} — ${c(x.cost)}`));
  const q = Object.entries(r.quota);
  L.push(q.length ? "% de quota (última medição): " + q.map(([p, v]) => `${p} ${v.usedPct}% usado (reseta ${v.resetsAt})`).join("; ") : "% de quota: sem medição");
  L.push("Nota: o ledger não tem custo por run na maioria das linhas; ranking usa quota_delta > USD > créditos > minutos, linhas sem custo valem 0.");
  return L.join("\n");
}

function opt(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = opt("ledger") || "C:/Users/joaov/dev/holding-hq/ledger";
  const report = buildReport(readJsonl(join(dir, "runs.jsonl")), readJsonl(join(dir, "quota.jsonl")), { now: opt("now") ? new Date(opt("now")) : new Date(), days: Number(opt("days")) || 7 });
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : render(report));
}
