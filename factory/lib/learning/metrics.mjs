// Performance metrics for the Company Learning System retrospective pass.
//
// "How well did the factory perform, and how fast?" — computed from the same
// terminal task records the analyzer uses, plus per-stage wall time recovered
// from each task's own event log. Pure and read-only; no model call.
//
// Per-stage duration is the span from a stage's last `dispatch-running` event
// to its terminal `stage-pass` / `stage-fail` event, so a stage that was
// retried is measured from its final attempt.

import { readFileSync } from "fs";

export const PIPELINE = ["product", "architect", "builder", "reviewer", "qa", "security", "release"];

function toMs(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? t : null;
}

export function stageTimingsFromEvents(events = []) {
  const out = {};
  const startedAt = {};
  for (const e of events) {
    if (!e || !e.stage) continue;
    if (e.type === "dispatch-running") {
      startedAt[e.stage] = toMs(e.at);
    } else if (e.type === "stage-pass" || e.type === "stage-fail") {
      const start = startedAt[e.stage];
      const end = toMs(e.at);
      if (start != null && end != null) out[e.stage] = Math.max(0, end - start);
    }
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export function summarize(nums) {
  const xs = (nums || []).filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0, meanMs: null, p50Ms: null, p90Ms: null, maxMs: null };
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    meanMs: Math.round(sum / xs.length),
    p50Ms: percentile(xs, 50),
    p90Ms: percentile(xs, 90),
    maxMs: xs[xs.length - 1],
  };
}

const rate = (num, den) => (den ? Number((num / den).toFixed(3)) : 0);

// records: output of collectTaskRecords().records (each has statePath, cycleMs,
// stageOutcomes, retryByStage, assignments, failedDispatches, decisionEvents).
// readState is injectable for tests.
export function computeFactoryMetrics(records, {
  now = new Date().toISOString(),
  readState = (p) => JSON.parse(readFileSync(p, "utf8")),
} = {}) {
  const list = Array.isArray(records) ? records : [];

  const stageDur = Object.fromEntries(PIPELINE.map((s) => [s, []]));
  const stageFail = Object.fromEntries(PIPELINE.map((s) => [s, { fail: 0, total: 0 }]));
  const stageRetry = Object.fromEntries(PIPELINE.map((s) => [s, 0]));
  const cycleMsAll = [];
  const byWorkType = {};
  const byRole = {};
  let firstPass = 0;
  let blocked = 0;
  let decisionFriction = 0;

  for (const r of list) {
    if (r.cycleMs != null) cycleMsAll.push(r.cycleMs);
    if (r.terminalStatus === "blocked") blocked += 1;
    const clean = (r.failedDispatches || []).length === 0 && r.terminalStatus === "merge-ready";
    if (clean) firstPass += 1;
    if ((r.decisionEvents || []).length) decisionFriction += 1;

    let events = [];
    try {
      if (r.statePath) events = readState(r.statePath).events || [];
    } catch {
      events = [];
    }
    const timings = stageTimingsFromEvents(events);

    for (const s of PIPELINE) {
      const outcome = (r.stageOutcomes || []).find((x) => x.stage === s);
      if (outcome) {
        stageFail[s].total += 1;
        if (outcome.status === "fail") stageFail[s].fail += 1;
      }
      stageRetry[s] += (r.retryByStage || {})[s] || 0;
      if (timings[s] != null) stageDur[s].push(timings[s]);
    }

    const wt = r.workType || "unknown";
    (byWorkType[wt] ||= { tasks: 0, firstPass: 0, cycleMs: [] });
    byWorkType[wt].tasks += 1;
    if (clean) byWorkType[wt].firstPass += 1;
    if (r.cycleMs != null) byWorkType[wt].cycleMs.push(r.cycleMs);

    for (const [stage, role] of Object.entries(r.assignments || {})) {
      (byRole[role] ||= { role, tasks: 0, firstPass: 0, stageDurMs: [], reworks: 0 });
      byRole[role].tasks += 1;
      if (clean) byRole[role].firstPass += 1;
      if (timings[stage] != null) byRole[role].stageDurMs.push(timings[stage]);
      byRole[role].reworks += (r.retryByStage || {})[stage] || 0;
    }
  }

  const perStage = {};
  for (const s of PIPELINE) {
    perStage[s] = {
      duration: summarize(stageDur[s]),
      failRate: rate(stageFail[s].fail, stageFail[s].total),
      retries: stageRetry[s],
    };
  }

  const perRole = {};
  for (const [role, v] of Object.entries(byRole)) {
    perRole[role] = {
      tasks: v.tasks,
      firstPassRate: rate(v.firstPass, v.tasks),
      stageDuration: summarize(v.stageDurMs),
      reworks: v.reworks,
    };
  }

  return {
    generatedAt: now,
    taskCount: list.length,
    cycle: summarize(cycleMsAll),
    firstPassRate: rate(firstPass, list.length),
    blockedRate: rate(blocked, list.length),
    decisionFrictionRate: rate(decisionFriction, list.length),
    perStage,
    perRole,
    byWorkType: Object.fromEntries(Object.entries(byWorkType).map(([k, v]) => [k, {
      tasks: v.tasks,
      firstPassRate: rate(v.firstPass, v.tasks),
      cycle: summarize(v.cycleMs),
    }])),
  };
}

// Run-over-run comparison for the digest ("faster / slower / cleaner since last
// cycle"). Returns null when either snapshot is missing.
export function diffMetrics(prev, curr) {
  if (!prev || !curr) return null;
  const d = (a, b) => (a == null || b == null ? null : Number((b - a).toFixed(3)));
  return {
    taskCountDelta: d(prev.taskCount, curr.taskCount),
    cycleP50MsDelta: d(prev.cycle?.p50Ms, curr.cycle?.p50Ms),
    firstPassRateDelta: d(prev.firstPassRate, curr.firstPassRate),
    blockedRateDelta: d(prev.blockedRate, curr.blockedRate),
    decisionFrictionRateDelta: d(prev.decisionFrictionRate, curr.decisionFrictionRate),
  };
}

// Compact one-line-per-metric block for the founder digest.
export function renderMetricsDigest(metrics, delta = null) {
  if (!metrics) return "";
  const ms = (v) => (v == null ? "n/a" : `${Math.round(v / 1000)}s`);
  const pct = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
  const arrow = (v, goodIsUp) => {
    if (v == null || v === 0) return "";
    const better = goodIsUp ? v > 0 : v < 0;
    return ` ${better ? "▲ better" : "▼ worse"}`;
  };
  const lines = [
    "## Factory performance",
    "",
    `- Tasks analyzed: ${metrics.taskCount}`,
    `- Cycle time p50 / p90: ${ms(metrics.cycle.p50Ms)} / ${ms(metrics.cycle.p90Ms)}${delta ? arrow(delta.cycleP50MsDelta, false) : ""}`,
    `- First-pass rate: ${pct(metrics.firstPassRate)}${delta ? arrow(delta.firstPassRateDelta, true) : ""}`,
    `- Blocked rate: ${pct(metrics.blockedRate)}${delta ? arrow(delta.blockedRateDelta, false) : ""}`,
    `- Decision-friction rate: ${pct(metrics.decisionFrictionRate)}`,
    "",
    "### Per stage (final-attempt wall time)",
    ...PIPELINE.map((s) => {
      const st = metrics.perStage[s] || {};
      return `- ${s}: p50 ${ms(st.duration?.p50Ms)}, fail ${pct(st.failRate)}, retries ${st.retries || 0}`;
    }),
    "",
  ];
  return lines.join("\n");
}
