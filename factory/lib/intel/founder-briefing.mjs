// Company-level view for the Founder Control Plane.
//
// Turns per-project briefs (project-brief.mjs) plus the live task list (the
// control plane already discovers these) into the things a founder actually
// operates on: project health, unanswered decisions, risks, opportunities, and a
// ranked list of recommended actions.
//
// Pure. No I/O. Deterministic over its inputs. Every signal here is derived from
// data that already exists (context files + task state) — it does not invent a
// sensor system.

const HEALTHY = 80;
const NEEDS_ATTENTION = 55;

/**
 * @param {object}  input
 * @param {Array}   input.briefs   project briefs (from listProjectBriefs / buildProjectBrief)
 * @param {Array}   input.projects founder-overview project rows (id, name, tasks[], status, ...)
 * @param {Array}  [input.taskDecisions]  task-blocker decisions already computed by the control plane
 * @param {Date}   [input.now]
 * @returns {{ projects, openDecisions, risks, opportunities, recommendedActions, summary }}
 */
export function buildCompanyBriefing({ briefs = [], projects = [], taskDecisions = [], now = new Date() }) {
  const briefByKey = new Map();
  for (const b of briefs) if (b && b.key) briefByKey.set(b.key, b);

  const decisionsByProject = groupBy(taskDecisions, (d) => d.project || d.taskId);

  const projectViews = projects.map((project) => {
    const brief = briefByKey.get(project.id) || briefByKey.get(project.intelligenceKey) || null;
    const projectTaskDecisions = decisionsByProject.get(project.id) || [];
    const health = scoreHealth({ project, brief, taskDecisions: projectTaskDecisions });
    return {
      id: project.id,
      name: project.name || project.id,
      registered: !!brief?.registered,
      mission: brief?.mission || project.mission || null,
      phase: phaseOf(project, brief),
      status: project.status || "active",
      health,
      taskCount: project.taskCount ?? (project.tasks ? project.tasks.length : 0),
      activeStage: project.stage || null,
      openDecisionCount: projectTaskDecisions.length + (brief?.ownership?.openDecisions?.length || 0),
      riskCount: (brief?.risks || []).length,
      topRisk: (brief?.risks || []).slice().sort(riskOrder)[0] || null,
      metrics: (brief?.ownership?.successMetrics || []).map((m) => ({
        name: m.name, current: m.current, target: m.target, asOf: m.asOf || null, atTarget: metricAtTarget(m),
      })),
      staleContext: (brief?.contextFindings || []).filter((f) => f.code === "stale" || f.code === "missing" || f.code === "thin")
        .map((f) => ({ file: f.file, code: f.code })),
    };
  });

  const openDecisions = [
    ...taskDecisions.map((d) => ({
      kind: "task-blocker",
      project: d.project || null,
      id: d.id,
      taskId: d.taskId || null,
      statePath: d.statePath || null,
      question: d.question,
      why: d.why,
      recommendation: d.recommendation,
      options: d.options || [],
      risk: d.risk || null,
      requestedAt: d.requestedAt || null,
      resumable: !!d.statePath,
    })),
    ...briefs.flatMap((b) => (b?.ownership?.openDecisions || []).map((id) => ({
      kind: "strategic",
      project: b.key,
      id,
      question: `Unresolved decision ${id} tracked in ${b.name}'s ownership.json`,
      why: "The project is carrying this as an open decision; it is not yet blocking a task but is unresolved.",
      recommendation: "Record a direction (Decision Card) and clear it from ownership.json.openDecisions.",
      options: [],
      resumable: false,
    }))),
  ];

  const risks = briefs.flatMap((b) => (b?.risks || []).map((r) => ({
    project: b.key,
    projectName: b.name,
    id: r.id,
    title: r.title,
    severity: r.severity,
    likelihood: r.likelihood,
    mitigation: r.mitigation || null,
    owner: r.owner || null,
    unmitigated: r.unmitigated,
  }))).sort(riskOrder);

  const opportunities = briefs.flatMap((b) => opportunitiesFor(b, projects.find((p) => p.id === b.key)));

  const recommendedActions = rankActions({ projectViews, openDecisions, risks, opportunities });

  const summary = {
    projectCount: projectViews.length,
    healthy: projectViews.filter((p) => p.health.level === "healthy").length,
    needsAttention: projectViews.filter((p) => p.health.level === "needs-attention").length,
    atRisk: projectViews.filter((p) => p.health.level === "at-risk").length,
    openDecisions: openDecisions.length,
    unmitigatedRisks: risks.filter((r) => r.unmitigated).length,
    opportunities: opportunities.length,
  };

  return { projects: projectViews, openDecisions, risks, opportunities, recommendedActions, summary };
}

function scoreHealth({ project, brief, taskDecisions }) {
  const tasks = project.tasks || [];
  let score = 100;
  const reasons = [];
  const hit = (points, reason) => { score -= points; reasons.push({ points, reason }); };

  const blocked = tasks.filter((t) => t.status === "blocked");
  if (blocked.length) hit(Math.min(40, 20 * blocked.length), `${blocked.length} blocked task(s)`);
  const failing = tasks.filter((t) => t.blocker?.outcome === "fail");
  if (failing.length) hit(12 * failing.length, `${failing.length} failing task(s)`);

  if (taskDecisions.length) hit(Math.min(24, 10 * taskDecisions.length), `${taskDecisions.length} decision(s) awaiting the founder`);

  if (!brief || !brief.registered) {
    hit(10, "no project intelligence registered");
  } else {
    const highUnmitigated = (brief.risks || []).filter((r) => r.severity === "high" && r.unmitigated);
    if (highUnmitigated.length) hit(15 * highUnmitigated.length, `${highUnmitigated.length} unmitigated high risk(s)`);
    const strategicOpen = brief.ownership?.openDecisions?.length || 0;
    if (strategicOpen) hit(Math.min(20, 8 * strategicOpen), `${strategicOpen} unresolved strategic decision(s)`);
    const criticalGaps = (brief.contextFindings || []).filter((f) => f.severity === "error" && (f.code === "missing" || f.code === "context-dir-missing" || f.code === "ownership-invalid"));
    if (criticalGaps.length) hit(8 * criticalGaps.length, `${criticalGaps.length} critical context gap(s) — agents run with less than full context`);
    const stale = (brief.contextFindings || []).filter((f) => f.code === "stale");
    if (stale.length) hit(Math.min(9, 3 * stale.length), `${stale.length} stale context file(s)`);
    if (!(brief.ownership?.successMetrics || []).length) hit(5, "no success metrics defined");
  }

  score = Math.max(0, Math.min(100, score));
  const level = score >= HEALTHY ? "healthy" : score >= NEEDS_ATTENTION ? "needs-attention" : "at-risk";
  return { score, level, reasons };
}

function opportunitiesFor(brief, projectRow) {
  if (!brief || !brief.registered) return [];
  const out = [];
  const activeObjectives = (projectRow?.tasks || [])
    .filter((t) => t.status === "active" || t.status === "blocked")
    .map((t) => String(t.objective || "").toLowerCase());
  const mentioned = (text) => activeObjectives.some((o) => o.includes(String(text || "").toLowerCase().slice(0, 24)));

  for (const p of brief.ownership?.currentPriorities || []) {
    if (!mentioned(p.title)) {
      out.push({ project: brief.key, kind: "idle-priority", detail: `Priority "${p.title}" has no task in flight.`, ref: p.id });
    }
  }
  for (const m of brief.ownership?.successMetrics || []) {
    if (metricAtTarget(m)) {
      out.push({ project: brief.key, kind: "metric-at-target", detail: `Metric "${m.name}" is at or past target (${m.current} / ${m.target}) — raise the bar or reallocate.`, ref: m.id });
    }
  }
  const rm = brief.roadmap;
  if (rm && /blocker:\s*none/i.test(rm.current || "") && (rm.next || []).length && activeObjectives.length === 0) {
    out.push({ project: brief.key, kind: "milestone-ready", detail: `Current milestone is unblocked with nothing in flight — next up: ${rm.next[0]}`, ref: null });
  }
  return out;
}

function rankActions({ projectViews, openDecisions, risks, opportunities }) {
  const actions = [];

  for (const d of openDecisions.filter((x) => x.kind === "task-blocker")) {
    actions.push({
      priority: 1,
      project: d.project,
      action: `Answer: ${truncate(d.question || "founder decision", 120)}`,
      rationale: d.why || "A task is blocked pending your direction.",
      ref: d.statePath ? { statePath: d.statePath, taskId: d.taskId } : null,
      kind: "decision",
    });
  }
  for (const d of openDecisions.filter((x) => x.kind === "strategic")) {
    actions.push({
      priority: 2,
      project: d.project,
      action: `Resolve strategic decision ${d.id}`,
      rationale: d.why,
      ref: null,
      kind: "decision",
    });
  }
  for (const p of projectViews.filter((x) => x.health.level === "at-risk")) {
    actions.push({
      priority: 2,
      project: p.id,
      action: `Review ${p.name} — health ${p.health.score}/100 (at risk)`,
      rationale: p.health.reasons.map((r) => r.reason).join("; ") || "Multiple health signals are down.",
      ref: null,
      kind: "health",
    });
  }
  for (const r of risks.filter((x) => x.unmitigated && (x.severity === "high" || x.severity === "medium"))) {
    actions.push({
      priority: r.severity === "high" ? 2 : 3,
      project: r.project,
      action: `Assign a mitigation and owner to risk "${truncate(r.title, 90)}"`,
      rationale: `Severity ${r.severity}, ${r.owner ? "no mitigation" : "no owner"}.`,
      ref: r.id ? { riskId: r.id } : null,
      kind: "risk",
    });
  }
  for (const p of projectViews) {
    for (const gap of p.staleContext.filter((g) => g.code === "missing")) {
      actions.push({
        priority: 3,
        project: p.id,
        action: `Fill ${gap.file} for ${p.name}`,
        rationale: "Agents are assembling context without it.",
        ref: { file: gap.file },
        kind: "context",
      });
    }
  }
  for (const o of opportunities) {
    actions.push({
      priority: 4,
      project: o.project,
      action: `Consider: ${truncate(o.detail, 120)}`,
      rationale: `Opportunity (${o.kind}).`,
      ref: o.ref ? { ref: o.ref } : null,
      kind: "opportunity",
    });
  }

  return actions
    .map((a, i) => ({ ...a, _i: i }))
    .sort((a, b) => a.priority - b.priority || a._i - b._i)
    .map(({ _i, ...a }) => a)
    .slice(0, 25);
}

// ---- small helpers ----

function metricAtTarget(m) {
  const cur = parseNumber(m.current);
  const tgt = parseNumber(m.target);
  if (cur == null || tgt == null) return false;
  return cur >= tgt;
}

function parseNumber(value) {
  if (value == null) return null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2, unspecified: 3 };
function riskOrder(a, b) {
  const s = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
  if (s !== 0) return s;
  return (b.unmitigated ? 1 : 0) - (a.unmitigated ? 1 : 0);
}

function phaseOf(project, brief) {
  if (brief?.roadmap?.current) return truncate(brief.roadmap.current, 140);
  if (project?.currentPhase) return project.currentPhase;
  return project?.stage ? `pipeline: ${project.stage}` : null;
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function truncate(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")} …`;
}
