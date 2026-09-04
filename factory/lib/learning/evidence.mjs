// Evidence collection for the Company Learning System.
//
// Read-only observer of what the workflow engine already persists. Walks
// `dashboard/backend/data/factory/<repo>/tasks/<id>/state.json`, normalizes each
// terminal task into a `TaskRecord`, and (best-effort) attaches short, redacted
// excerpts from stage evidence files. Never writes. Never runs a task.
//
// The workflow engine is not imported here beyond `readState` for parity with
// the on-disk shape.

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { sanitizeExcerpt, isSecretFilename } from "../common/redact.mjs";

const STATE_FILE = "state.json";
export const TERMINAL_STATUSES = new Set(["merge-ready", "blocked"]);

// Verdict lines role prompts tell agents to emit. Matched case-insensitively at
// the start of a trimmed line so we do not pick up prose that merely mentions
// them.
const VERDICT_PATTERNS = [
  { re: /^(changes required)\b/i, verdict: "CHANGES REQUIRED" },
  { re: /^(founder decision required)\b/i, verdict: "FOUNDER DECISION REQUIRED" },
  { re: /^(qa fail)\b/i, verdict: "QA FAIL" },
  { re: /^(qa pass)\b/i, verdict: "QA PASS" },
  { re: /^(approve)\b/i, verdict: "APPROVE" },
  { re: /^(fail)\b\s*$/i, verdict: "FAIL" },
  { re: /^(pass)\b\s*$/i, verdict: "PASS" },
  { re: /^(blocking)\b/i, verdict: "BLOCKING" },
];

export function walkStateFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkStateFiles(path, out);
    else if (entry.isFile() && entry.name === STATE_FILE) out.push(path);
  }
  return out;
}

function toMs(value) {
  const t = Date.parse(value || "");
  return Number.isNaN(t) ? null : t;
}

function readStageEvidenceExcerpts(state, { maxFiles = 4, maxExcerpt = 400 } = {}) {
  const worktree = state.worktree ? resolve(state.worktree) : null;
  const byStage = {};
  if (!worktree || !existsSync(worktree)) return byStage;
  for (const [stage, result] of Object.entries(state.stages || {})) {
    const items = Array.isArray(result?.evidence) ? result.evidence.slice(0, maxFiles) : [];
    const excerpts = [];
    for (const item of items) {
      const rel = typeof item === "string" ? item : item?.path;
      if (!rel || isSecretFilename(rel)) continue;
      const abs = resolve(worktree, rel);
      if (abs !== worktree && !abs.startsWith(`${worktree}/`)) continue;
      if (!existsSync(abs)) continue;
      let raw = "";
      try {
        raw = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const verdicts = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.replace(/^[#>\-*\s]+/, "").trim();
        for (const { re, verdict } of VERDICT_PATTERNS) {
          if (re.test(trimmed)) verdicts.push(verdict);
        }
      }
      const clean = sanitizeExcerpt(raw, { maxLength: maxExcerpt });
      excerpts.push({
        path: rel,
        verdicts: [...new Set(verdicts)],
        excerpt: clean.text,
        redactionHits: clean.hits,
      });
    }
    if (excerpts.length) byStage[stage] = excerpts;
  }
  return byStage;
}

// Normalize one raw state object into a TaskRecord. `statePath` is informational.
export function toTaskRecord(state, statePath = null, { attachEvidence = true } = {}) {
  const stages = state.stages || {};
  const dispatches = (state.dispatches || []).map((d) => ({
    stage: d.stage,
    actor: d.actor,
    attempt: d.attempt ?? null,
    outcome: d.outcome ?? null,
    status: d.status ?? null,
    summary: sanitizeExcerpt(d.summary || "", { maxLength: 300 }).text || null,
    error: d.error ? sanitizeExcerpt(d.error, { maxLength: 300 }).text : null,
  }));
  const retryByStage = {};
  for (const d of dispatches) {
    retryByStage[d.stage] = (retryByStage[d.stage] || 0) + 1;
  }
  for (const stage of Object.keys(retryByStage)) {
    retryByStage[stage] = Math.max(0, retryByStage[stage] - 1);
  }
  const events = (state.events || []).map((e) => ({ at: e.at, type: e.type, stage: e.stage || null, actor: e.actor || null }));
  const decisionEvents = events.filter((e) =>
    e.type === "stage-decision-required" ||
    e.type === "founder-decision-recorded" ||
    e.type === "founder-approval-recorded");
  const createdAtMs = toMs(state.createdAt);
  const endedAtMs = toMs(state.updatedAt) ?? (events.length ? toMs(events[events.length - 1].at) : null);
  const stageOutcomes = Object.entries(stages).map(([stage, r]) => ({
    stage,
    status: r?.status || "pending",
    actor: r?.actor || (state.assignments || {})[stage] || null,
    attempts: (retryByStage[stage] || 0) + 1,
    summary: r?.summary ? sanitizeExcerpt(r.summary, { maxLength: 300 }).text : null,
  }));

  return {
    id: state.task?.id || (statePath ? basename(dirname(statePath)) : "unknown"),
    project: state.task?.project || (state.repo ? basename(state.repo) : "unknown"),
    repo: state.repo || null,
    statePath: statePath ? resolve(statePath) : null,
    risk: state.task?.risk || null,
    workType: state.task?.workType || null,
    assignments: state.assignments || {},
    terminalStatus: state.status,
    blocker: state.blocker || null,
    createdAt: state.createdAt || null,
    endedAt: state.updatedAt || (events.length ? events[events.length - 1].at : null),
    cycleMs: createdAtMs != null && endedAtMs != null ? Math.max(0, endedAtMs - createdAtMs) : null,
    stageOutcomes,
    dispatches,
    failedDispatches: dispatches.filter((d) => d.outcome === "fail" || d.status === "failed"),
    retryByStage,
    decisionEvents,
    founderDecisions: (state.founderDecisions || []).map((f) => ({
      at: f.at,
      direction: sanitizeExcerpt(f.direction || "", { maxLength: 300 }).text,
      stage: f.blocker?.stage || null,
    })),
    evidenceByStage: attachEvidence ? readStageEvidenceExcerpts(state) : {},
  };
}

// Walk a factory state root and return normalized records for terminal tasks.
//   factoryStateRoot  absolute path to `dashboard/backend/data/factory`
//   project           optional key filter (matches record.project)
//   since             optional ISO date; keep tasks whose endedAt >= since
//   includeActive     include non-terminal tasks too (default false)
export function collectTaskRecords({ factoryStateRoot, project = null, since = null, includeActive = false, attachEvidence = true } = {}) {
  if (!factoryStateRoot) throw new Error("collectTaskRecords requires factoryStateRoot");
  const root = resolve(factoryStateRoot);
  const sinceMs = since ? toMs(since) : null;
  const records = [];
  const skipped = [];
  for (const statePath of walkStateFiles(root)) {
    let state;
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch (error) {
      skipped.push({ statePath, reason: `unreadable: ${error.message}` });
      continue;
    }
    if (!includeActive && !TERMINAL_STATUSES.has(state.status)) continue;
    let record;
    try {
      record = toTaskRecord(state, statePath, { attachEvidence });
    } catch (error) {
      skipped.push({ statePath, reason: `malformed: ${error.message}` });
      continue;
    }
    if (project && record.project !== project) continue;
    if (sinceMs != null) {
      const endedMs = toMs(record.endedAt);
      if (endedMs != null && endedMs < sinceMs) continue;
    }
    records.push(record);
  }
  records.sort((a, b) => String(b.endedAt || "").localeCompare(String(a.endedAt || "")));
  return { records, skipped };
}

export function defaultFactoryStateRoot(hqRoot) {
  return join(resolve(hqRoot), "dashboard", "backend", "data", "factory");
}
