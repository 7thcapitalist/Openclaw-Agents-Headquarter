// Deterministic analysis for the Company Learning System.
//
// Pure functions over TaskRecord[] (see evidence.mjs). No fs, no network, no
// model. Every output is an evidence-backed Finding or a cross-task Pattern.
// `id` and `status` are assigned later by the findings queue.
//
// The model-assisted narrative pass (Phase 4) consumes these same Findings; it
// never replaces this layer.

import { fingerprint, slugify } from "../common/fingerprint.mjs";

const REVIEW_STAGES = new Set(["reviewer", "qa", "security"]);

// Ordered cause buckets. First match wins. Keep the vocabulary aligned with the
// role prompts so a founder can trace a finding back to a stage instruction.
const CAUSE_BUCKETS = [
  { cause: "ambiguous-acceptance-criteria", re: /ambigu|not testable|unclear requirement|acceptance criteri\w*\s+(?:are|is|were|not|unclear|vague)|non-observable|underspecif|contradictor/i },
  { cause: "missing-or-failing-tests", re: /failing test|test(?:s)? fail|no tests|missing test|assertion (?:error|failed)|coverage/i },
  { cause: "build-or-compile-error", re: /build fail|compil\w+|syntax error|cannot find module|import error|module not found|type error/i },
  { cause: "scope-expansion", re: /scope (?:creep|expansion|expanded)|unrelated (?:change|file)|out of scope/i },
  { cause: "regression", re: /regress|broke (?:existing|another)|behaviou?r change/i },
  { cause: "security-or-privacy", re: /secret|credential|token exposed|injection|privacy|pii|unsafe permission|data loss/i },
  { cause: "environment-or-dependency", re: /timeout|network|econnrefused|dependency install|npm (?:err|install)|flaky|infrastructure/i },
  { cause: "insufficient-context", re: /missing context|no vision|unclear goal|lack(?:ing|ed)? (?:background|context)|did not know/i },
];

function classifyCause(text) {
  const s = String(text || "");
  for (const { cause, re } of CAUSE_BUCKETS) {
    if (re.test(s)) return cause;
  }
  return "unclassified";
}

function makeFinding(partial) {
  return {
    kind: "failure",
    scope: "global",
    project: null,
    targetRole: null,
    confidence: "medium",
    occurrences: 1,
    taskIds: [],
    evidence: [],
    recommendation: "",
    ...partial,
  };
}

function stageEvidenceFor(record, stage) {
  const items = record.evidenceByStage?.[stage] || [];
  return items.map((e) => ({ path: `${record.id}:${e.path}`, excerpt: e.excerpt, verdicts: e.verdicts }));
}

// ---- Failure classifiers -------------------------------------------------------

export function classifyBuilderFailures(records, now) {
  const findings = [];
  for (const record of records) {
    const builderFails = record.failedDispatches.filter((d) => d.stage === "builder");
    const builderStageFail = record.stageOutcomes.find((s) => s.stage === "builder" && s.status === "fail");
    if (!builderFails.length && !builderStageFail) continue;
    const text = [
      ...builderFails.map((d) => `${d.summary || ""} ${d.error || ""}`),
      builderStageFail?.summary || "",
    ].join(" ");
    const cause = classifyCause(text);
    findings.push(makeFinding({
      kind: "failure",
      scope: "global",
      project: record.project,
      targetRole: "builder",
      fingerprint: fingerprint(["builder-fail", slugify(record.workType || "any"), cause]),
      title: `Builder failed on ${record.workType || "a"} task (${cause.replace(/-/g, " ")})`,
      observation: `Task ${record.id} recorded ${builderFails.length || 1} builder failure(s); classified cause: ${cause}.`,
      evidence: [
        ...builderFails.map((d) => ({ path: `${record.id}:dispatch:${d.stage}#${d.attempt}`, excerpt: d.summary || d.error || "failed" })),
        ...stageEvidenceFor(record, "builder"),
      ].slice(0, 4),
      recommendation: recommendationForCause(cause, "builder"),
      confidence: cause === "unclassified" ? "low" : "medium",
      taskIds: [record.id],
      raisedAt: now,
    }));
  }
  return findings;
}

export function classifyReviewRejections(records, now) {
  const findings = [];
  for (const record of records) {
    for (const stage of REVIEW_STAGES) {
      const stageOutcome = record.stageOutcomes.find((s) => s.stage === stage);
      const stageFails = record.failedDispatches.filter((d) => d.stage === stage);
      const routedBack = record.decisionEvents.length === 0 &&
        (record.dispatches.some((d) => d.stage === "builder" && (d.attempt || 1) > 1));
      const failed = stageOutcome?.status === "fail" || stageFails.length > 0;
      if (!failed) continue;
      const ev = stageEvidenceFor(record, stage);
      const verdicts = [...new Set(ev.flatMap((e) => e.verdicts || []))];
      const text = [stageOutcome?.summary || "", ...stageFails.map((d) => `${d.summary || ""} ${d.error || ""}`), verdicts.join(" ")].join(" ");
      const cause = classifyCause(text);
      findings.push(makeFinding({
        kind: "failure",
        scope: "global",
        project: record.project,
        targetRole: stage,
        fingerprint: fingerprint([`${stage}-reject`, slugify(record.workType || "any"), cause]),
        title: `${stage[0].toUpperCase()}${stage.slice(1)} rejected the change (${cause.replace(/-/g, " ")})`,
        observation: `Task ${record.id}: ${stage} stage failed${verdicts.length ? ` with verdict(s) ${verdicts.join(", ")}` : ""}; classified cause: ${cause}. Builder rework ${routedBack ? "was" : "may have been"} required.`,
        evidence: [
          ...(stageOutcome?.summary ? [{ path: `${record.id}:stage:${stage}`, excerpt: stageOutcome.summary }] : []),
          ...stageFails.map((d) => ({ path: `${record.id}:dispatch:${stage}#${d.attempt}`, excerpt: d.summary || d.error || "failed" })),
          ...ev,
        ].slice(0, 4),
        recommendation: recommendationForCause(cause, stage),
        confidence: cause === "unclassified" ? "low" : "medium",
        taskIds: [record.id],
        raisedAt: now,
      }));
    }
  }
  return findings;
}

export function classifyRetryExhaustion(records, now, { maxAttemptsPerStage = 3 } = {}) {
  const findings = [];
  for (const record of records) {
    for (const [stage, retries] of Object.entries(record.retryByStage)) {
      if (retries + 1 < maxAttemptsPerStage) continue;
      findings.push(makeFinding({
        kind: "failure",
        scope: "agent",
        project: record.project,
        targetRole: stage,
        fingerprint: fingerprint(["retry-exhaustion", stage, slugify(record.workType || "any")]),
        title: `${stage} stage burned its full retry budget`,
        observation: `Task ${record.id} spent ${retries + 1} attempts at the ${stage} stage (limit ${maxAttemptsPerStage}). Repeated same-stage retries usually mean the handoff is missing information the agent needs, not that the agent is incapable.`,
        evidence: stageEvidenceFor(record, stage).slice(0, 3),
        recommendation: `Review the ${stage} handoff for this work type. Add the missing precondition (tests, context, or interface contract) upstream so the stage can pass on attempt 1.`,
        confidence: "high",
        taskIds: [record.id],
        raisedAt: now,
      }));
    }
  }
  return findings;
}

export function classifyDecisionFriction(records, now) {
  const findings = [];
  for (const record of records) {
    const isBlockedOnDecision = record.blocker?.outcome === "decision-required";
    const decisionEvts = record.decisionEvents.filter((e) => e.type !== "founder-approval-recorded");
    if (!isBlockedOnDecision && decisionEvts.length === 0) continue;
    const raisedAt = decisionEvts.find((e) => e.type === "stage-decision-required")?.at || record.blocker?.at || null;
    const resolvedAt = decisionEvts.find((e) => e.type === "founder-decision-recorded")?.at || null;
    let waitedHours = null;
    if (raisedAt && resolvedAt) {
      const delta = Date.parse(resolvedAt) - Date.parse(raisedAt);
      if (!Number.isNaN(delta)) waitedHours = Math.round((delta / 3.6e6) * 10) / 10;
    }
    const stage = record.blocker?.stage || decisionEvts[0]?.stage || "unknown";
    findings.push(makeFinding({
      kind: "failure",
      scope: "global",
      project: record.project,
      targetRole: stage === "unknown" ? null : stage,
      fingerprint: fingerprint(["decision-friction", slugify(stage), slugify(record.workType || "any")]),
      title: `Work paused for a founder decision at the ${stage} stage`,
      observation: `Task ${record.id} hit a decision-required block at ${stage}${waitedHours != null ? ` and waited ~${waitedHours}h for a founder answer` : (isBlockedOnDecision ? " and is still waiting" : "")}. Decisions that recur in shape are candidates for a standing policy so future tasks never stop.`,
      evidence: stageEvidenceFor(record, stage).slice(0, 3),
      recommendation: `If this decision shape repeats, encode the answer as a rule in OPERATING_RULES.md or the decision protocol so the ${stage} stage continues autonomously next time.`,
      confidence: "medium",
      taskIds: [record.id],
      raisedAt: now,
    }));
  }
  return findings;
}

// ---- Success classifiers ----------------------------------------------------

export function classifyCleanDeliveries(records, now, { stageCount = 7 } = {}) {
  const findings = [];
  for (const record of records) {
    if (record.terminalStatus !== "merge-ready") continue;
    if (record.failedDispatches.length > 0) continue;
    if (record.dispatches.length > stageCount) continue;
    const builder = record.assignments?.builder || "unknown";
    findings.push(makeFinding({
      kind: "success",
      scope: "global",
      project: record.project,
      targetRole: null,
      fingerprint: fingerprint(["clean-delivery", slugify(record.workType || "any"), slugify(builder), slugify(record.risk || "any")]),
      title: `Clean first-pass delivery: ${record.workType || "task"} / ${builder} / ${record.risk || "?"} risk`,
      observation: `Task ${record.id} reached merge-ready with no failed dispatches and ${record.dispatches.length} total dispatches. This work-type + builder + risk shape is producing reviewable PRs without rework.`,
      evidence: record.stageOutcomes.filter((s) => s.status === "pass" && s.summary).slice(0, 3).map((s) => ({ path: `${record.id}:stage:${s.stage}`, excerpt: s.summary })),
      recommendation: `Keep routing ${record.workType || "this"} / ${record.risk || "this-risk"} work to ${builder}. Capture the architecture and task-sizing pattern in ENGINEERING_IMPROVEMENTS.md as a known-good shape.`,
      confidence: "medium",
      taskIds: [record.id],
      raisedAt: now,
    }));
  }
  return findings;
}

export function classifyFastCycles(records, now) {
  const timed = records.filter((r) => r.terminalStatus === "merge-ready" && typeof r.cycleMs === "number" && r.cycleMs > 0);
  if (timed.length < 4) return [];
  const sorted = [...timed].sort((a, b) => a.cycleMs - b.cycleMs);
  const cutoff = sorted[Math.floor(sorted.length / 4)].cycleMs;
  const findings = [];
  for (const record of sorted) {
    if (record.cycleMs > cutoff) continue;
    findings.push(makeFinding({
      kind: "success",
      scope: "global",
      project: record.project,
      targetRole: null,
      fingerprint: fingerprint(["fast-cycle", slugify(record.workType || "any"), slugify(record.assignments?.builder || "any")]),
      title: `Fastest-quartile cycle time: ${record.workType || "task"}`,
      observation: `Task ${record.id} completed in ${Math.round(record.cycleMs / 6e4)} min, in the fastest quartile of timed deliveries. Shape: ${record.workType || "?"} work, builder ${record.assignments?.builder || "?"}, ${record.dispatches.length} dispatches.`,
      evidence: [],
      recommendation: `Document what made this fast (task size, clear acceptance criteria, tight scope) in PROCESS_IMPROVEMENTS.md so intake aims for the same shape.`,
      confidence: "low",
      taskIds: [record.id],
      raisedAt: now,
    }));
  }
  return findings;
}

// ---- Recommendation vocabulary -------------------------------------------

function recommendationForCause(cause, role) {
  const map = {
    "ambiguous-acceptance-criteria": "Require the product stage to emit explicit, executable acceptance tests before the architect stage. Add an acceptance-tests-present check to requiredGates.",
    "missing-or-failing-tests": `Have the ${role} handoff state the exact test command and require a green run in the evidence. Reviewer should reject on unverified test claims.`,
    "build-or-compile-error": "Add a build/typecheck smoke step to the builder's required completion checklist before it may report PASS.",
    "scope-expansion": "Strengthen the task contract's explicit out-of-scope list and have the reviewer flag any diff hunk outside it as BLOCKING.",
    "regression": "Require the builder to run the existing test suite (not just new tests) and record the result. Add a regression check to QA.",
    "security-or-privacy": "Route this work type through the security stage earlier, and add the specific check that failed to security.md.",
    "environment-or-dependency": "Treat this as an infrastructure failure, not an agent failure: stabilize the environment (pin deps, add retries) before re-running.",
    "insufficient-context": "This is the Intelligence Layer's job: ensure the project Context Pack (vision, tech constraints, users) is attached to the handoff.",
    unclassified: `Manually review the ${role} evidence for this task and classify the root cause; consider a new cause bucket in analyze.mjs.`,
  };
  return map[cause] || map.unclassified;
}

// ---- Clustering -----------------------------------------------------------

// Group findings by fingerprint into cross-task Patterns. A fingerprint seen on
// >= threshold distinct tasks becomes a Pattern; findings that also carry a
// targetRole yield an agent-improvement recommendation.
export function clusterFindings(findings, { patternThreshold = 2, now } = {}) {
  const groups = new Map();
  for (const f of findings) {
    if (!groups.has(f.fingerprint)) groups.set(f.fingerprint, []);
    groups.get(f.fingerprint).push(f);
  }
  const patterns = [];
  const agentImprovements = [];
  for (const [fp, group] of groups) {
    const taskIds = [...new Set(group.flatMap((f) => f.taskIds))];
    if (taskIds.length < patternThreshold) continue;
    const lead = group[0];
    const pattern = {
      kind: "pattern",
      scope: lead.scope,
      project: group.every((f) => f.project === lead.project) ? lead.project : null,
      targetRole: lead.targetRole,
      fingerprint: fp,
      title: `Recurring: ${lead.title}`,
      observation: `${taskIds.length} tasks share this signal (${taskIds.join(", ")}). ${lead.observation}`,
      evidence: group.flatMap((f) => f.evidence).slice(0, 6),
      recommendation: lead.recommendation,
      confidence: taskIds.length >= patternThreshold + 2 ? "high" : "medium",
      occurrences: taskIds.length,
      taskIds,
      raisedAt: now || lead.raisedAt,
    };
    patterns.push(pattern);
    if (lead.kind === "failure" && lead.targetRole) {
      agentImprovements.push({
        ...pattern,
        kind: "agent-improvement",
        title: `Improve ${lead.targetRole}: ${lead.title}`,
        observation: `${taskIds.length} tasks failed the same way at the ${lead.targetRole} stage. ${pattern.observation}`,
      });
    }
  }
  patterns.sort((a, b) => b.occurrences - a.occurrences || a.fingerprint.localeCompare(b.fingerprint));
  agentImprovements.sort((a, b) => b.occurrences - a.occurrences || a.fingerprint.localeCompare(b.fingerprint));
  return { patterns, agentImprovements };
}

// ---- Entry point --------------------------------------------------------

export function analyzeTasks(records, { now = new Date().toISOString(), patternThreshold = 2, maxAttemptsPerStage = 3 } = {}) {
  const list = Array.isArray(records) ? records : [];
  const failures = [
    ...classifyBuilderFailures(list, now),
    ...classifyReviewRejections(list, now),
    ...classifyRetryExhaustion(list, now, { maxAttemptsPerStage }),
    ...classifyDecisionFriction(list, now),
  ];
  const successes = [
    ...classifyCleanDeliveries(list, now),
    ...classifyFastCycles(list, now),
  ];
  const { patterns, agentImprovements } = clusterFindings([...failures, ...successes], { patternThreshold, now });
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((f) => {
      const key = `${f.kind}::${f.fingerprint}::${[...f.taskIds].sort().join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return {
    analyzedTasks: list.length,
    failures: dedupe(failures),
    successes: dedupe(successes),
    patterns,
    agentImprovements,
    generatedAt: now,
  };
}
