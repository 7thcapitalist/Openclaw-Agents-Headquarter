// Deterministic analysis for the Company Learning System.
//
// Pure functions over TaskRecord[] (see evidence.mjs). No fs, no network, no
// model. Every output is an evidence-backed Finding or a cross-task Pattern.
// `id` and `status` are assigned later by the findings queue.
//
// The model-assisted narrative pass (Phase 4) consumes these same Findings; it
// never replaces this layer.

import { fingerprint, slugify } from "../common/fingerprint.mjs";
import { classifyObjectiveNodeBlocker } from "../hq/blocker-class.mjs";
import { isNoVerdictContent } from "../hq/report/no-verdict.mjs";

const REVIEW_STAGES = new Set(["reviewer", "qa", "security"]);
const FINDING_ROLES = new Set(["product", "architect", "builder", "reviewer", "qa", "security", "release"]);
const findingRole = (stage) => FINDING_ROLES.has(stage) ? stage : null;

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

function dispatchEvidence(record, dispatches, fallback) {
  return dispatches.map((dispatch) => ({
    path: dispatch.resultPath || `${record.id}:dispatch:${dispatch.stage}#${dispatch.attempt || 1}`,
    excerpt: dispatch.summary || dispatch.error || fallback,
  }));
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

export function classifyRecoverySuccesses(records, now) {
  return records.filter((record) => (record.recovery?.attempts || []).some((attempt) => attempt.status === "verified"))
    .map((record) => {
      const attempts = record.recovery.attempts.filter((attempt) => attempt.status === "verified");
      const first = attempts[0];
      return makeFinding({
        kind: "success", scope: "global", project: record.project, targetRole: first.failedStage,
        fingerprint: fingerprint(["recovery-success", first.classification, slugify(first.failedStage || "unknown")]),
        title: `Recovery pattern verified at ${first.failedStage || "unknown"}`,
        observation: `Task ${record.id} recovered a ${first.classification} through diagnosis, repair, and independent verification.`,
        evidence: [
          ...(first.diagnosis?.evidence || []).map((e) => ({ path: `${record.id}:recovery:diagnosis:${e.path || e}`, excerpt: first.diagnosis.summary })),
          ...(first.verification?.evidence || []).map((e) => ({ path: `${record.id}:recovery:verification:${e.path || e}`, excerpt: first.verification.summary })),
        ].slice(0, 4),
        recommendation: "Review this recovery finding before promoting it into a durable factory rule; learning must not change behavior automatically.",
        confidence: "high", taskIds: [record.id], raisedAt: now,
      });
    });
}

export function classifyNoVerdictDispatches(records, now) {
  const findings = [];
  for (const record of records) {
    for (const dispatch of record.dispatches.filter((item) => isNoVerdictContent(`${item.summary || ""} ${item.error || ""}`))) {
      findings.push(makeFinding({
        project: record.project,
        objectiveId: record.objectiveId,
        targetRole: findingRole(dispatch.stage),
        fingerprint: fingerprint(["no-verdict-dispatch", dispatch.stage || "unknown"]),
        title: `${dispatch.stage || "Agent"} dispatch produced no verdict`,
        observation: `Objective ${record.objectiveId || "unknown"}, task ${record.id}: the ${dispatch.stage || "unknown"} dispatch ended without a usable result verdict.`,
        evidence: dispatchEvidence(record, [dispatch], "dispatch produced no verdict"),
        recommendation: `Inspect the ${dispatch.stage || "agent"} route and result-file handoff; a dispatch must either write its contracted result or fail with an actionable infrastructure classification.`,
        confidence: "high",
        taskIds: [record.id],
        raisedAt: now,
      }));
    }
  }
  return findings;
}

export function classifyRepeatedStageRuns(records, now) {
  const findings = [];
  for (const record of records) {
    for (const [stage, retries] of Object.entries(record.retryByStage || {})) {
      if (retries < 1) continue;
      const dispatches = record.dispatches.filter((dispatch) => dispatch.stage === stage);
      findings.push(makeFinding({
        scope: "agent",
        project: record.project,
        objectiveId: record.objectiveId,
        targetRole: findingRole(stage),
        fingerprint: fingerprint(["repeated-stage-run", stage, slugify(record.workType || "any")]),
        title: `${stage} stage ran more than once`,
        observation: `Objective ${record.objectiveId || "unknown"}, task ${record.id}: ${stage} ran ${retries + 1} times.`,
        evidence: dispatchEvidence(record, dispatches, "repeated stage run").slice(0, 4),
        recommendation: `Review the first ${stage} result and the following handoff to remove the reason this stage needed another run.`,
        confidence: "high",
        taskIds: [record.id],
        raisedAt: now,
      }));
    }
  }
  return findings;
}

export function classifyUnchangedGateReruns(records, now) {
  const findings = [];
  for (const record of records) {
    const approvedAt = record.events?.find((event) => event.type === "founder-approval-recorded")?.at;
    if (!approvedAt) continue;
    for (const stage of REVIEW_STAGES) {
      if ((record.retryByStage?.[stage] || 0) < 1) continue;
      const dispatches = record.dispatches.filter((dispatch) => dispatch.stage === stage);
      const reranAfterApproval = dispatches.slice(1).some((dispatch) => {
        const at = dispatch.createdAt || dispatch.startedAt || dispatch.completedAt;
        return at && Date.parse(at) >= Date.parse(approvedAt);
      });
      if (!reranAfterApproval) continue;
      const invalidated = record.events.some((event) => event.type === "evidence-invalidated" && event.stages?.includes(stage));
      if (invalidated) continue;
      findings.push(makeFinding({
        project: record.project,
        objectiveId: record.objectiveId,
        targetRole: stage,
        fingerprint: fingerprint(["unchanged-gate-rerun", stage, slugify(record.workType || "any")]),
        title: `${stage} gate re-ran after approval without a file change`,
        observation: `Objective ${record.objectiveId || "unknown"}, task ${record.id}: ${stage} ran again after founder approval, with no evidence-invalidated event naming that gate.`,
        evidence: dispatchEvidence(record, dispatches, "gate re-run against unchanged source").slice(0, 4),
        recommendation: `Preserve the approved ${stage} verdict when the verified commit is unchanged; only re-open it after evidence invalidation.`,
        confidence: "high",
        taskIds: [record.id],
        raisedAt: now,
      }));
    }
  }
  return findings;
}

const UPSTREAM_EVIDENCE_GAP_RE = /missing context|insufficient acceptance criteria|no vision|lack(?:ing|ed)? (?:background|context)|missing (?:handoff|evidence)|acceptance criteria (?:missing|insufficient)/i;

export function classifyBuilderReworkFromUpstreamGaps(records, now) {
  const findings = [];
  for (const record of records) {
    for (let index = 0; index < record.dispatches.length; index += 1) {
      const builder = record.dispatches[index];
      if (builder.stage !== "builder" || (builder.attempt || 1) <= 1) continue;
      const prior = record.dispatches.slice(0, index).reverse().find((dispatch) => dispatch.stage !== "builder");
      if (!prior || !UPSTREAM_EVIDENCE_GAP_RE.test(`${prior.summary || ""} ${prior.error || ""}`)) continue;
      findings.push(makeFinding({
        project: record.project,
        objectiveId: record.objectiveId,
        targetRole: findingRole(prior.stage),
        fingerprint: fingerprint(["builder-rework-upstream-gap", prior.stage || "unknown", slugify(record.workType || "any")]),
        title: `Builder rework followed missing ${prior.stage || "upstream"} evidence`,
        observation: `Objective ${record.objectiveId || "unknown"}, task ${record.id}: builder attempt ${builder.attempt} followed a ${prior.stage || "prior-stage"} result that reported missing context or evidence.`,
        evidence: dispatchEvidence(record, [prior, builder], "builder rework from upstream evidence gap"),
        recommendation: `Require the ${prior.stage || "upstream"} handoff to include the missing context and acceptance evidence before routing to builder.`,
        confidence: "high",
        taskIds: [record.id],
        raisedAt: now,
      }));
    }
  }
  return findings;
}

export function classifyInfrastructureFounderInterruptions(records, now) {
  const findings = [];
  for (const record of records) {
    const joined = record.objectiveNodeBlocker;
    if (!joined || classifyObjectiveNodeBlocker(joined.blocker) !== "infra") continue;
    const dispatches = record.dispatches.filter((dispatch) => dispatch.outcome === "fail" || dispatch.status === "failed");
    findings.push(makeFinding({
      project: record.project,
      objectiveId: joined.objectiveId || record.objectiveId,
      targetRole: findingRole(joined.blocker.stage),
      fingerprint: fingerprint(["founder-interruption-infrastructure", joined.blocker.stage || "unknown"]),
      title: "Founder interruption was caused by infrastructure",
      observation: `Objective ${joined.objectiveId || record.objectiveId || "unknown"}, task ${record.id}: infrastructure was surfaced as a decision-required interruption rather than a product decision.`,
      evidence: [
        { path: joined.objectivePath, excerpt: joined.blocker.summary || joined.blocker.why || "infrastructure blocker" },
        ...dispatchEvidence(record, dispatches, "infrastructure dispatch failure"),
      ].slice(0, 4),
      recommendation: "Route this blocker through infrastructure recovery and keep it out of the founder decision queue unless a genuine product or authority choice remains.",
      confidence: "high",
      taskIds: [record.id],
      raisedAt: now,
    }));
  }
  return findings;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function classifySlowCycles(records, now) {
  const findings = [];
  const groups = new Map();
  for (const record of records) {
    if (typeof record.cycleMs !== "number" || record.cycleMs <= 0 || !record.workType) continue;
    if (!groups.has(record.workType)) groups.set(record.workType, []);
    groups.get(record.workType).push(record);
  }
  for (const [workType, group] of groups) {
    if (group.length < 4) continue;
    for (const record of group) {
      const baseline = median(group.filter((other) => other !== record).map((other) => other.cycleMs));
      if (!baseline || record.cycleMs <= baseline * 2) continue;
      findings.push(makeFinding({
        project: record.project,
        objectiveId: record.objectiveId,
        targetRole: null,
        fingerprint: fingerprint(["slow-cycle-outlier", slugify(workType)]),
        title: `Wall time far above median for ${workType} work`,
        observation: `Objective ${record.objectiveId || "unknown"}, task ${record.id}: ${Math.round(record.cycleMs / 6e4)} min wall time was more than 2x the ${Math.round(baseline / 6e4)} min median of similar terminal tasks.`,
        evidence: dispatchEvidence(record, record.dispatches, "slow task result").slice(0, 4),
        recommendation: "Inspect the longest stage transitions and remove avoidable waits or repeated handoffs for this work type.",
        confidence: "medium",
        taskIds: [record.id],
        raisedAt: now,
      }));
    }
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
      objectiveId: group.every((f) => f.objectiveId === lead.objectiveId) ? (lead.objectiveId ?? null) : null,
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
    ...classifyNoVerdictDispatches(list, now),
    ...classifyRepeatedStageRuns(list, now),
    ...classifyUnchangedGateReruns(list, now),
    ...classifyBuilderReworkFromUpstreamGaps(list, now),
    ...classifyInfrastructureFounderInterruptions(list, now),
    ...classifySlowCycles(list, now),
    ...classifyBuilderFailures(list, now),
    ...classifyReviewRejections(list, now),
    ...classifyRetryExhaustion(list, now, { maxAttemptsPerStage }),
    ...classifyDecisionFriction(list, now),
    ...classifyRecoverySuccesses(list, now),
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
