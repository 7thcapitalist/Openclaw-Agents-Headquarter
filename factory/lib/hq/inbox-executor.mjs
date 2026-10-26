// Idempotent drain of studios/software/inbox/.
//
// A request is identified by its content (repo + base + objetivo), not by its
// file name, so re-running over the same request — or a copy of it re-dropped
// into inbox/ after it was already moved to done/ — never opens a second
// branch or a second ledger line.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { blockMessage } from "./block-message.mjs";

export const MAX_FAILURES = 2;

export function parseRequest(text) {
  const out = {};
  let inTasks = false;
  for (const line of text.split(/\r?\n/)) {
    // Optional "tarefas:" block: one "- item" (or "1. item") per micro-task.
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

function ledgerKeys(ledgerPath) {
  if (!existsSync(ledgerPath)) return new Set();
  const keys = new Set();
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    try { const e = JSON.parse(line); if (e.key && !e.task && !e.failure_reason) keys.add(e.key); } catch { /* skip torn line */ }
  }
  return keys;
}

// Micro-tasks already finished for a request, read back from the ledger so an
// interrupted request resumes with only the pending ones.
function doneTasks(ledgerPath, key) {
  const done = new Set();
  if (!existsSync(ledgerPath)) return done;
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    try { const e = JSON.parse(line); if (e.key === key && e.task && !e.failure_reason) done.add(e.task); } catch { /* skip torn line */ }
  }
  return done;
}

// One-line human reason + last 20 log lines, so a failure is readable from the ledger alone.
export function describeFailure(error) {
  const msg = String(error?.message || error || "falha desconhecida");
  const reason = (msg.split(/\r?\n/).find((l) => l.trim()) || "falha desconhecida").trim().slice(0, 300);
  const log = String(error?.log ?? error?.stderr ?? error?.stack ?? msg).split(/\r?\n/);
  while (log.length && !log[log.length - 1].trim()) log.pop();
  return { failure_reason: reason, last_log_tail: log.slice(-20).join("\n") };
}

// Failure history of one task (task = null for a request without tarefas), read back from the ledger.
function taskHistory(ledgerPath, key, task) {
  const h = { failures: [], blocked: false };
  if (!existsSync(ledgerPath)) return h;
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (e.key !== key || (e.task ?? null) !== (task ?? null)) continue;
      if (e.status === "failed") h.failures.push(e);
      if (e.status === "blocked") h.blocked = true;
    } catch { /* skip torn line */ }
  }
  return h;
}

// Records the failure; on the MAX_FAILURES-th one also writes a blocked entry carrying the exact question (runbook SOF-219).
// Returns the block message when the task became blocked, else null.
function recordFailure({ ledgerPath, now, key, file, branch, task, error }) {
  const base = { at: now(), key, file, ...(task ? { task } : {}), branch };
  const fail = { ...base, status: "failed", ...describeFailure(error) };
  appendFileSync(ledgerPath, JSON.stringify(fail) + "\n");
  const { failures } = taskHistory(ledgerPath, key, task);
  if (failures.length < MAX_FAILURES) return null;
  const message = blockMessage({
    tarefa: task || file,
    tentativas: failures.map((f) => f.failure_reason),
    travouEm: fail.failure_reason,
    pergunta: `A tarefa falhou ${failures.length}x com "${fail.failure_reason}": corrijo o ambiente, troco a abordagem ou descarto a tarefa?`,
  });
  appendFileSync(ledgerPath, JSON.stringify({ ...base, status: "blocked", failure_reason: fail.failure_reason, block_message: message }) + "\n");
  return message;
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

// dispatch(request, { key, branch }) creates the branch/PR work; it is only
// called for requests never seen before. Returns [{ file, key, status }].
export async function processInbox({ inboxDir, doneDir, ledgerPath, dispatch, now = () => new Date().toISOString() }) {
  mkdirSync(doneDir, { recursive: true });
  const seen = new Set([...ledgerKeys(ledgerPath), ...doneKeys(doneDir)]);
  const results = [];
  for (const file of existsSync(inboxDir) ? readdirSync(inboxDir).filter((n) => n.endsWith(".md")).sort() : []) {
    const src = join(inboxDir, file);
    const req = parseRequest(readFileSync(src, "utf8"));
    if (!req.repo || !req.objetivo) { results.push({ file, status: "invalid" }); continue; }
    const key = requestKey(req);
    if (seen.has(key)) {
      // Already handled: drop the duplicate copy instead of reprocessing it.
      const dest = join(doneDir, file);
      if (existsSync(dest)) unlinkSync(src); else renameSync(src, dest);
      results.push({ file, key, status: "skipped-duplicate" });
      continue;
    }
    const branch = branchFor(key);
    let outcome = {};
    let firstPrTests = null; // tests_passed reported by dispatch for the first PR opened
    if (req.tarefas?.length) {
      const finished = doneTasks(ledgerPath, key);
      const pending = req.tarefas.filter((t) => !finished.has(t));
      let current = null;
      const stuck = pending.find((t) => taskHistory(ledgerPath, key, t).blocked);
      if (stuck) { results.push({ file, key, branch, status: "blocked", task: stuck }); continue; }
      try {
        for (const task of pending) {
          current = task;
          const o = (await dispatch(req, { key, branch, task })) || {};
          appendFileSync(ledgerPath, JSON.stringify({ at: now(), key, file, task, branch, pr: o.pr ?? null }) + "\n");
          if (o.pr && !outcome.pr) firstPrTests = typeof o.tests_passed === "boolean" ? o.tests_passed : null;
          if (o.pr) outcome = o;
        }
      } catch (error) {
        // Interrupted: finished tasks are in the ledger, the file stays in inbox/ to be resumed.
        const block_message = recordFailure({ ledgerPath, now, key, file, branch, task: current, error });
        results.push({ file, key, branch, status: block_message ? "blocked" : "interrupted", error: String(error?.message || error), ...(block_message ? { task: current, block_message } : {}) });
        continue;
      }
    } else {
      if (taskHistory(ledgerPath, key, null).blocked) { results.push({ file, key, branch, status: "blocked" }); continue; }
      try {
        outcome = (await dispatch(req, { key, branch })) || {};
        if (outcome.pr && typeof outcome.tests_passed === "boolean") firstPrTests = outcome.tests_passed;
      } catch (error) {
        const block_message = recordFailure({ ledgerPath, now, key, file, branch, task: null, error });
        results.push({ file, key, branch, status: block_message ? "blocked" : "failed", error: String(error?.message || error), ...(block_message ? { block_message } : {}) });
        continue;
      }
    }
    appendFileSync(ledgerPath, JSON.stringify({ at: now(), key, file, repo: req.repo, base: req.base || "main", branch, pr: outcome.pr ?? null, first_pr_tests_passed: firstPrTests }) + "\n");
    seen.add(key);
    renameSync(src, join(doneDir, file));
    results.push({ file, key, branch, status: "processed" });
  }
  return results;
}
