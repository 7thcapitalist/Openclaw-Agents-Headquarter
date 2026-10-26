// Idempotent drain of studios/software/inbox/.
//
// A request is identified by its content (repo + base + objetivo), not by its
// file name, so re-running over the same request — or a copy of it re-dropped
// into inbox/ after it was already moved to done/ — never opens a second
// branch or a second ledger line.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function parseRequest(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^(repo|base|objetivo|pronto quando):\s*(.*)$/i.exec(line.trim());
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

export function requestKey(req) {
  const norm = [req.repo, req.base || "main", req.objetivo].map((s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ")).join("|");
  return createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

export const branchFor = (key) => `hq/inbox-${key}`;

function ledgerKeys(ledgerPath) {
  if (!existsSync(ledgerPath)) return new Set();
  const keys = new Set();
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    try { const e = JSON.parse(line); if (e.key) keys.add(e.key); } catch { /* skip torn line */ }
  }
  return keys;
}

function doneKeys(doneDir) {
  const keys = new Set();
  if (!existsSync(doneDir)) return keys;
  for (const f of readdirSync(doneDir).filter((n) => n.endsWith(".md"))) {
    const req = parseRequest(readFileSync(join(doneDir, f), "utf8"));
    if (req.repo && req.objetivo) keys.add(requestKey(req));
  }
  return keys;
}

// Why a request cannot run, naming the offending field (null when it is fine).
// check(req) is optional and may be async: it returns a reason when the repo or
// base does not exist, so a bad request is refused up front, not mid-run.
export async function requestProblem(req, check) {
  for (const f of ["repo", "objetivo"]) {
    if (!(f in req)) return `campo "${f}" ausente`;
    if (!req[f]) return `campo "${f}" vazio`;
  }
  if ("base" in req && !req.base) return 'campo "base" vazio';
  if (req.tarefas && !req.tarefas.length) return 'bloco "tarefas:" sem nenhum item';
  return (check && (await check(req))) || null;
}

// Real existence check for repo and base on GitHub, injectable for tests.
// run(args) resolves to { ok, notFound } for a `gh api` call; any failure other
// than a 404 (network, auth) throws so the request stays in inbox/ for a retry
// instead of being wrongly rejected.
export function githubCheck(run) {
  return async (req) => {
    const base = req.base || "main";
    const repo = await run(["api", `repos/${req.repo}`]);
    if (repo.notFound) return `repo "${req.repo}" inexistente`;
    const br = await run(["api", `repos/${req.repo}/branches/${encodeURIComponent(base)}`]);
    if (br.notFound) return `base "${base}" inexistente em ${req.repo}`;
    return null;
  };
}

// dispatch(request, { key, branch }) creates the branch/PR work; it is only
// called for requests never seen before. Returns [{ file, key, status }].
export async function processInbox({ inboxDir, doneDir, ledgerPath, dispatch, check, now = () => new Date().toISOString() }) {
  mkdirSync(doneDir, { recursive: true });
  const seen = new Set([...ledgerKeys(ledgerPath), ...doneKeys(doneDir)]);
  const results = [];
  for (const file of existsSync(inboxDir) ? readdirSync(inboxDir).filter((n) => n.endsWith(".md")).sort() : []) {
    const src = join(inboxDir, file);
    const req = parseRequest(readFileSync(src, "utf8"));
    const motivo = await requestProblem(req, check);
    if (motivo) {
      // Refused up front: never leave it stuck in inbox/ and never open a branch.
      const reason = `pedido rejeitado: ${motivo}`;
      appendFileSync(src, `\n\nstatus: rejeitado\nmotivo: ${reason}\n`);
      appendFileSync(ledgerPath, JSON.stringify({ at: now(), file, status: "rejeitado", motivo: reason }) + "\n");
      const dest = join(doneDir, file);
      if (existsSync(dest)) unlinkSync(src); else renameSync(src, dest);
      results.push({ file, status: "rejeitado", motivo: reason });
      continue;
    }
    const key = requestKey(req);
    if (!dispatch && !seen.has(key)) { results.push({ file, key, status: "valid-pending" }); continue; }
    if (seen.has(key)) {
      // Already handled: drop the duplicate copy instead of reprocessing it.
      const dest = join(doneDir, file);
      if (existsSync(dest)) unlinkSync(src); else renameSync(src, dest);
      results.push({ file, key, status: "skipped-duplicate" });
      continue;
    }
    const branch = branchFor(key);
    const outcome = (await dispatch(req, { key, branch })) || {};
    appendFileSync(ledgerPath, JSON.stringify({ at: now(), key, file, repo: req.repo, base: req.base || "main", branch, pr: outcome.pr ?? null }) + "\n");
    seen.add(key);
    renameSync(src, join(doneDir, file));
    results.push({ file, key, branch, status: "processed" });
  }
  return results;
}
