// Drain of studios/software/inbox/: validated up front, idempotent, with a per-task
// attempts counter in the ledger.
//
// A request is identified by its content (repo + base + objetivo), not by its file
// name. A finished request (closing ledger line, or a copy in done/) is never
// dispatched again, so re-dropping it opens no second branch. Finished micro-tasks
// and failed dispatches are read back from the ledger, so an interrupted request
// resumes with only the pending tasks and `attempts` accumulates across runs.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// A request may carry at most this many micro-tasks (the team runs 4 in parallel).
export const MAX_TAREFAS = 4;

export function parseRequest(text) {
  const out = {};
  let inTasks = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^tarefas:\s*$/i.test(line.trim())) { inTasks = true; out.tarefas = []; continue; }
    const t = inTasks && /^(?:[-*]|\d+[.)])\s+(.+)$/.exec(line.trim());
    if (t) { out.tarefas.push(t[1].trim()); continue; }
    if (line.trim()) inTasks = false;
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

function ledgerEntries(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  const entries = [];
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    try { const e = JSON.parse(line); if (e?.key) entries.push(e); } catch { /* skip torn line */ }
  }
  return entries;
}

// Keys of requests already closed: the closing line has no task and no failure.
function closedKeys(ledgerPath) {
  return new Set(ledgerEntries(ledgerPath).filter((e) => !e.task && !e.failure_reason).map((e) => e.key));
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
  if (req.tarefas?.length > MAX_TAREFAS) return `${req.tarefas.length} tarefas, máximo é ${MAX_TAREFAS}`;
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

// One-line human reason + last 20 log lines, so a failure is readable from the ledger alone.
export function describeFailure(error) {
  const msg = String(error?.message || error || "falha desconhecida");
  const reason = (msg.split(/\r?\n/).find((l) => l.trim()) || "falha desconhecida").trim().slice(0, 300);
  const log = String(error?.log ?? error?.stderr ?? error?.stack ?? msg).split(/\r?\n/);
  while (log.length && !log[log.length - 1].trim()) log.pop();
  return { failure_reason: reason, last_log_tail: log.slice(-20).join("\n") };
}

// dispatch(request, { key, branch, task }) does the work for one micro-task (task is
// undefined for a request without tarefas). Returns [{ file, key, branch, status }].
export async function processInbox({ inboxDir, doneDir, ledgerPath, dispatch, check, now = () => new Date().toISOString() }) {
  mkdirSync(doneDir, { recursive: true });
  const seen = new Set([...closedKeys(ledgerPath), ...doneKeys(doneDir)]);
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
    const entries = ledgerEntries(ledgerPath).filter((e) => e.key === key);
    const finished = new Set(entries.filter((e) => e.task && !e.failure_reason).map((e) => e.task));
    const failures = new Map(); // task ("" = request without tarefas) -> failed dispatches so far
    for (const e of entries) if (e.failure_reason) failures.set(e.task ?? "", (failures.get(e.task ?? "") || 0) + 1);
    const attemptsFor = (task) => (failures.get(task ?? "") || 0) + 1;
    const units = req.tarefas?.length ? req.tarefas.filter((t) => !finished.has(t)) : [undefined];
    let pr = null;
    // tests_passed of the first PR this request ever opened (undefined: none yet), kept across resumes.
    let firstPrTests;
    for (const e of entries) if (e.task && !e.failure_reason && e.pr && firstPrTests === undefined) firstPrTests = typeof e.tests_passed === "boolean" ? e.tests_passed : null;
    let current;
    try {
      for (const task of units) {
        current = task;
        const o = (await dispatch(req, { key, branch, ...(task === undefined ? {} : { task }) })) || {};
        if (o.pr && !pr) pr = o.pr;
        if (o.pr && firstPrTests === undefined) firstPrTests = typeof o.tests_passed === "boolean" ? o.tests_passed : null;
        if (task !== undefined) appendFileSync(ledgerPath, JSON.stringify({ at: now(), key, file, task, branch, pr: o.pr ?? null, ...(o.pr && typeof o.tests_passed === "boolean" ? { tests_passed: o.tests_passed } : {}), attempts: attemptsFor(task) }) + "\n");
      }
    } catch (error) {
      // Interrupted: finished tasks are in the ledger, the file stays in inbox/ to be resumed.
      appendFileSync(ledgerPath, JSON.stringify({ at: now(), key, file, ...(current === undefined ? {} : { task: current }), branch, status: "failed", attempts: attemptsFor(current), ...describeFailure(error) }) + "\n");
      results.push({ file, key, branch, status: "interrupted", error: String(error?.message || error) });
      continue;
    }
    const closing = { at: now(), key, file, repo: req.repo, base: req.base || "main", branch, pr, first_pr_tests_passed: firstPrTests ?? null };
    if (!req.tarefas?.length) closing.attempts = attemptsFor(undefined);
    appendFileSync(ledgerPath, JSON.stringify(closing) + "\n");
    renameSync(src, join(doneDir, file));
    seen.add(key);
    results.push({ file, key, branch, status: "processed" });
  }
  return results;
}

// Per-key summary of the ledger for --status: attempts (max over the request's lines) and last state.
export function ledgerStatus(ledgerPath) {
  const rows = new Map();
  for (const e of ledgerEntries(ledgerPath)) {
    const r = rows.get(e.key) || { key: e.key, branch: e.branch ?? "", attempts: 0, state: "" };
    r.attempts = Math.max(r.attempts, Number.isInteger(e.attempts) ? e.attempts : 0);
    r.state = e.failure_reason ? "failed" : e.task ? "running" : "done";
    rows.set(e.key, r);
  }
  return [...rows.values()];
}

export function formatStatus(rows) {
  return ["key\tstate\tattempts\tbranch", ...rows.map((r) => `${r.key}\t${r.state}\t${r.attempts}\t${r.branch}`)].join("\n");
}

// Per-request state read back from the ledger: ok (final line written), failed
// (last line is a failure) or pending (only partial task lines). attempts counts
// failed runs plus the one that succeeded.
export function summarizeLedger(ledgerPath) {
  const byKey = new Map();
  for (const e of ledgerEntries(ledgerPath)) {
    const s = byKey.get(e.key) || { key: e.key, state: "pending", attempts: 0, failure_reason: null, pr: null };
    if (e.failure_reason || e.status === "failed") {
      s.state = "failed"; s.attempts += 1; s.failure_reason = e.failure_reason ?? "unknown";
    } else if (!e.task) {
      s.state = "ok"; s.attempts += 1; s.failure_reason = null;
    }
    if (e.pr) s.pr = e.pr;
    byKey.set(e.key, s);
  }
  return [...byKey.values()];
}

export function formatSummary(rows) {
  if (!rows.length) return "ledger vazio: nenhum pedido registrado";
  const count = (st) => rows.filter((r) => r.state === st).length;
  const head = `pedidos: ${count("ok")} ok, ${count("failed")} falha, ${count("pending")} pendente`;
  return [head, ...rows.map((r) => `${r.key}  ${r.state}  tentativas=${r.attempts}  motivo=${r.failure_reason ?? "-"}  pr=${r.pr ?? "-"}`)].join("\n");
}
