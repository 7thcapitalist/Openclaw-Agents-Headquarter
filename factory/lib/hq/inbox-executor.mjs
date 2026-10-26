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
    try { const e = JSON.parse(line); if (e.key && !e.task) keys.add(e.key); } catch { /* skip torn line */ }
  }
  return keys;
}

// Micro-tasks already finished for a request, read back from the ledger so an
// interrupted request resumes with only the pending ones.
function doneTasks(ledgerPath, key) {
  const done = new Set();
  if (!existsSync(ledgerPath)) return done;
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    try { const e = JSON.parse(line); if (e.key === key && e.task) done.add(e.task); } catch { /* skip torn line */ }
  }
  return done;
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
    if (req.tarefas?.length) {
      const finished = doneTasks(ledgerPath, key);
      const pending = req.tarefas.filter((t) => !finished.has(t));
      try {
        for (const task of pending) {
          const o = (await dispatch(req, { key, branch, task })) || {};
          appendFileSync(ledgerPath, JSON.stringify({ at: now(), key, file, task, branch, pr: o.pr ?? null }) + "\n");
          if (o.pr) outcome = o;
        }
      } catch (error) {
        // Interrupted: finished tasks are in the ledger, the file stays in inbox/ to be resumed.
        results.push({ file, key, branch, status: "interrupted", error: String(error?.message || error) });
        continue;
      }
    } else {
      outcome = (await dispatch(req, { key, branch })) || {};
    }
    appendFileSync(ledgerPath, JSON.stringify({ at: now(), key, file, repo: req.repo, base: req.base || "main", branch, pr: outcome.pr ?? null }) + "\n");
    seen.add(key);
    renameSync(src, join(doneDir, file));
    results.push({ file, key, branch, status: "processed" });
  }
  return results;
}
