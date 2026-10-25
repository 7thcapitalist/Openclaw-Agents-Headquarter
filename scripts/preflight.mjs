#!/usr/bin/env node
// Preflight antes de rodar um pedido: node>=20, repo limpo, remoto origin acessível, pasta de worktree livre.
// Uso: node scripts/preflight.mjs [--worktree <pasta>] [--repo <pasta>]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });

export function runPreflight({ repo = process.cwd(), worktree, nodeVersion = process.versions.node, run = git } = {}) {
  const checks = [];
  const check = (name, fn) => {
    try { const detail = fn(); checks.push({ name, ok: detail === undefined || detail === true || detail === "", detail: typeof detail === "string" ? detail : "" }); }
    catch (e) { checks.push({ name, ok: false, detail: String(e.stderr || e.message).trim().split("\n")[0] }); }
  };
  check("node>=20", () => (Number(nodeVersion.split(".")[0]) >= 20 ? "" : `node ${nodeVersion} < 20`));
  check("git limpo", () => { const out = run(repo, ["status", "--porcelain"]).trim(); return out ? `${out.split("\n").length} alteração(ões) pendente(s)` : ""; });
  check("remoto origin", () => { run(repo, ["ls-remote", "--exit-code", "origin", "HEAD"]); return ""; });
  if (worktree) check("worktree livre", () => {
    const p = resolve(worktree);
    return existsSync(p) && readdirSync(p).length ? `pasta ocupada: ${p}` : "";
  });
  return { ok: checks.every((c) => c.ok), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const r = runPreflight({ repo: opt("--repo"), worktree: opt("--worktree") });
  for (const c of r.checks) console.log(`${c.ok ? "OK  " : "FALHA"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  if (!r.ok) { console.error(`preflight falhou: ${r.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`); process.exit(1); }
}
