// Work proposer.
//
// Every objective this factory has ever run started with the founder typing it.
// Goals, scorecards, the cost ledger and learning findings all exist, and all
// four only ever *informed* — nothing read them together and had an opinion
// about what to do next.
//
// This does, under one hard rule: a proposal must point at something already in
// canonical state. It ranks real blocked work, real untouched goals and real
// recurring findings. It never invents an objective, because a proposer that
// invents is a proposer that adds noise to the one surface the founder reads
// daily, and noise there is worse than silence.
//
// Report-only by design. This produces a ranked list and nothing else; promoting
// a proposal into the overnight queue stays a deliberate human action. Same
// enablement shape as budgets (#139), permissions (#141) and the re-wake
// throttle (#157) — see docs/software-factory/WORK_PROPOSER.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildGoalsSnapshot } from "./goals.mjs";
import { readLearningFindings } from "./chief-of-staff.mjs";

export const PROPOSER_CONTRACT = "hq.work-proposer/1";

// Three proposals, not ten. The list is read at a glance beside everything else
// on Today; a longer one is a backlog, and a backlog is the thing the founder
// already has too much of.
export const DEFAULT_LIMIT = 3;

const KINDS = Object.freeze(["unblock", "neglected", "systemic"]);

// ── candidate extraction ──────────────────────────────────────────────────

// Depth-first, parents before children, so a caller can prefer the specific.
function flattenGoals(roots) {
  const out = [];
  const walk = (goal, depth, ancestry) => {
    if (!goal || typeof goal !== "object") return;
    out.push({ goal, depth, ancestry });
    for (const child of goal.children || []) walk(child, depth + 1, [...ancestry, goal]);
  };
  for (const root of roots || []) walk(root, 0, []);
  return out;
}

// Blocked work, attributed to the most specific goal that owns it.
//
// Proposing "unblock the company goal" is not actionable — the company goal is
// blocked precisely because something under it is. So a goal with children
// yields nothing here; its blockage is already represented by whichever leaf
// actually carries it, and reporting both would double-count the same tasks.
function unblockCandidates(goals) {
  const out = [];
  for (const { goal, depth, ancestry } of goals) {
    if ((goal.children || []).length > 0) continue;
    const progress = goal.progress || {};
    const blocked = Number(progress.blocked) || 0;
    if (blocked < 1) continue;
    out.push({
      kind: "unblock",
      goalId: goal.id,
      goalTitle: goal.title,
      goalLevel: goal.level,
      projectId: goal.projectId || null,
      objectiveId: goal.objectiveId || null,
      // Blocked work is the whole signal. A goal with 12 blocked items is a
      // bigger problem than one with 1, whatever share of the goal that is.
      score: blocked,
      depth,
      ancestry: ancestry.map((a) => a.title),
      evidence: {
        blocked,
        total: Number(progress.total) || 0,
        active: Number(progress.active) || 0,
        complete: Number(progress.complete) || 0,
        percent: Number(progress.percent) || 0,
        source: "goal projection (factory/lib/hq/goals.mjs)",
      },
    });
  }
  return out;
}

// Goals nothing is moving and nothing is stuck on: no active work, no blockage,
// and not finished. Distinct from "blocked" — there is no obstacle to clear,
// the work simply was never picked up. That is the case a founder most often
// cannot see, because nothing about it generates an event.
function neglectedCandidates(goals) {
  const out = [];
  for (const { goal, depth, ancestry } of goals) {
    if ((goal.children || []).length > 0) continue;
    const progress = goal.progress || {};
    const total = Number(progress.total) || 0;
    const active = Number(progress.active) || 0;
    const blocked = Number(progress.blocked) || 0;
    const complete = Number(progress.complete) || 0;
    if (total === 0) continue;               // nothing recorded: silence, not neglect
    if (active > 0 || blocked > 0) continue; // being worked, or stuck — other kinds own it
    if (complete >= total) continue;         // done
    out.push({
      kind: "neglected",
      goalId: goal.id,
      goalTitle: goal.title,
      goalLevel: goal.level,
      projectId: goal.projectId || null,
      objectiveId: goal.objectiveId || null,
      score: total - complete,
      depth,
      ancestry: ancestry.map((a) => a.title),
      evidence: {
        remaining: total - complete, total, active, blocked, complete,
        percent: Number(progress.percent) || 0,
        source: "goal projection (factory/lib/hq/goals.mjs)",
      },
    });
  }
  return out;
}

// A failure the learning system has now seen enough times to call a pattern.
// The threshold is the founder's (`learning.patternThreshold`, default 2) — this
// reads it rather than inventing a second one.
function systemicCandidates(findings, threshold) {
  const out = [];
  for (const finding of findings || []) {
    const occurrences = Number(finding?.occurrences ?? finding?.count ?? 0) || 0;
    if (occurrences < threshold) continue;
    const title = String(finding?.title || finding?.summary || "").trim();
    if (!title) continue;
    out.push({
      kind: "systemic",
      goalId: null,
      goalTitle: null,
      goalLevel: null,
      projectId: finding?.projectId || null,
      objectiveId: null,
      score: occurrences,
      depth: 0,
      ancestry: [],
      title,
      evidence: {
        occurrences, threshold,
        category: finding?.category || finding?.kind || null,
        source: "learning findings (_learning/findings.json)",
      },
    });
  }
  return out;
}

// ── ranking ───────────────────────────────────────────────────────────────

// Blocked work first: it is already paid for and stopped, so clearing it
// converts spend the factory has *already made* into delivered work. Neglect
// costs nothing until it is picked up, so it ranks below. Systemic findings sit
// between — they are cheap to act on and compound.
const KIND_WEIGHT = Object.freeze({ unblock: 3, systemic: 2, neglected: 1 });

function sentence(candidate) {
  const e = candidate.evidence;
  if (candidate.kind === "unblock") {
    const share = e.total ? ` of ${e.total}` : "";
    return `${e.blocked} item${e.blocked === 1 ? "" : "s"}${share} under this goal ${e.blocked === 1 ? "is" : "are"} blocked`
      + `${e.active ? `, and ${e.active} still active` : " with nothing active"}.`;
  }
  if (candidate.kind === "neglected") {
    return `${e.remaining} of ${e.total} items remain and nothing is active or blocked — no one has picked this up.`;
  }
  return `Seen ${e.occurrences} times, at or above the pattern threshold of ${e.threshold}.`;
}

/**
 * Pure ranking. Separated from all I/O so the ordering can be tested directly
 * against fixtures rather than against whatever the live factory happens to
 * contain today.
 */
export function rankProposals({ goals = [], findings = [], threshold = 2, limit = DEFAULT_LIMIT } = {}) {
  const flat = flattenGoals(goals);
  const candidates = [
    ...unblockCandidates(flat),
    ...neglectedCandidates(flat),
    ...systemicCandidates(findings, threshold),
  ];

  candidates.sort((a, b) => {
    const weight = KIND_WEIGHT[b.kind] - KIND_WEIGHT[a.kind];
    if (weight) return weight;
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tail: same kind and same score must order the same way on
    // every run, or the panel reshuffles for no reason the reader can see.
    return String(a.goalId || a.title || "").localeCompare(String(b.goalId || b.title || ""));
  });

  return candidates.slice(0, Math.max(0, limit)).map((candidate, index) => ({
    rank: index + 1,
    kind: candidate.kind,
    title: candidate.title || candidate.goalTitle,
    why: sentence(candidate),
    goalId: candidate.goalId,
    goalTitle: candidate.goalTitle,
    goalLevel: candidate.goalLevel,
    projectId: candidate.projectId,
    objectiveId: candidate.objectiveId,
    ancestry: candidate.ancestry,
    evidence: candidate.evidence,
  }));
}

// ── snapshot ──────────────────────────────────────────────────────────────

/**
 * Reads what exists, ranks it, and says plainly when it cannot.
 *
 * Never throws: every input is optional and every failure degrades to a warning
 * plus fewer proposals. A proposer that breaks the Today view is a proposer that
 * gets switched off, and then none of this matters.
 */
export function buildWorkProposals({ hqRoot, stateRoot = null, limit = DEFAULT_LIMIT, threshold = null, now = new Date().toISOString() } = {}) {
  const warnings = [];

  let goalsSnapshot = { available: false, roots: [] };
  try {
    goalsSnapshot = buildGoalsSnapshot({ hqRoot, stateRoot, now });
    for (const warning of goalsSnapshot.warnings || []) warnings.push(warning);
  } catch (error) {
    warnings.push(`goals unavailable: ${error.message}`);
  }

  let findings = [];
  try {
    findings = readLearningFindings(hqRoot).findings || [];
  } catch (error) {
    warnings.push(`learning findings unavailable: ${error.message}`);
  }

  let effectiveThreshold = Number(threshold) || 0;
  if (!effectiveThreshold) {
    try {
      effectiveThreshold = Number(readPatternThreshold(hqRoot)) || 2;
    } catch { effectiveThreshold = 2; }
  }

  const proposals = rankProposals({
    goals: goalsSnapshot.roots || [],
    findings,
    threshold: effectiveThreshold,
    limit,
  });

  // "No proposals" has two very different meanings and the panel must not
  // conflate them: nothing to propose, versus nothing to propose *from*.
  const configured = Boolean(goalsSnapshot.available ?? goalsSnapshot.configured);

  return {
    version: 1,
    contract: PROPOSER_CONTRACT,
    asOf: now,
    available: configured,
    reportOnly: true,
    limit,
    threshold: effectiveThreshold,
    proposals,
    considered: {
      goals: flattenGoals(goalsSnapshot.roots || []).length,
      findings: findings.length,
    },
    warnings,
  };
}

// The founder's own pattern threshold, not a second one invented here. Read
// defensively: a malformed config costs the proposer its threshold, never the
// whole Today view.
function readPatternThreshold(hqRoot) {
  const raw = JSON.parse(readFileSync(join(hqRoot, "factory", "factory.config.json"), "utf8"));
  return raw?.learning?.patternThreshold;
}

export { KINDS, flattenGoals };
