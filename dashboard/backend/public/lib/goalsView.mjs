// The founder-facing goal rollup for the Today view.
//
// Everything rendered here is derived from canonical objective/task state by
// factory/lib/hq/goals.mjs. There is no control in this panel: goals change by
// pull request against factory/goals.json, so the dashboard can show intent
// without becoming a second place to edit it.

// Every state factory/lib/hq/goals.mjs can produce has an entry. `partial` and
// `unknown` exist precisely so incomplete data cannot be mistaken for progress,
// so falling through to "No linked work" would defeat them.
const STATE_LABEL = {
  completed: ["Complete", "status-good"],
  active: ["In progress", "status-good"],
  blocked: ["Blocked", "status-warn"],
  pending: ["Not started", ""],
  partial: ["Partly tracked", "status-warn"],
  unknown: ["Unrecognised state", "status-warn"],
  unavailable: ["No linked work", ""],
};

export function goalsPanel(source, { esc = escapeHtml } = {}) {
  if (!source) return shell("Unavailable", "status-warn", `<div class="quiet-state">Goal rollups are not available yet.</div>`);
  if (!source.configured) {
    return shell("Not configured", "", `<div class="quiet-state">No goals are defined. Add them to <code>factory/goals.json</code> and open a pull request.</div>`);
  }

  const summary = source.summary || {};
  const [summaryLabel, summaryTone] = STATE_LABEL[summary.state] || STATE_LABEL.unavailable;
  const roots = Array.isArray(source.roots) ? source.roots : [];
  const degraded = source.available === false;

  return shell(summaryLabel, summaryTone, `
    ${degraded ? `<p class="operations-warning" role="status">Some canonical work could not be read, so these totals are incomplete.</p>` : ""}
    <div class="goal-summary">
      <div class="objective-progress" role="img" aria-label="${esc(`${number(summary.percent)} percent of tracked work complete`)}"><span style="width:${number(summary.percent)}%"></span></div>
      <p>${number(summary.complete)} of ${number(summary.total)} tracked units complete${number(summary.blocked) ? ` · <strong class="status-warn">${number(summary.blocked)} blocked</strong>` : ""}${number(summary.active) ? ` · ${number(summary.active)} in flight` : ""}${number(summary.unavailable) ? ` · <strong class="status-warn">${number(summary.unavailable)} goal${number(summary.unavailable) === 1 ? "" : "s"} with no linked work</strong>` : ""}${number(summary.unknown) ? ` · ${number(summary.unknown)} unrecognised` : ""}</p>
    </div>
    <p class="muted small">Source: goal projection (factory/lib/hq/goals.mjs)</p>
    <ul class="goal-tree">${roots.map((goal) => renderGoal(goal, esc)).join("")}</ul>
  `);
}

function renderGoal(goal, esc, depth = 0) {
  const progress = goal.progress || {};
  const [label, tone] = STATE_LABEL[progress.state] || STATE_LABEL.unavailable;
  // A goal whose scope is only partly visible shows the label, not a
  // percentage: the number would be arithmetically correct and operationally a
  // lie about how much of the goal is actually accounted for.
  const detail = progress.total && progress.state !== "partial"
    ? `${number(progress.percent)}% · ${number(progress.complete)}/${number(progress.total)}`
    : label;
  return `<li class="goal-node goal-depth-${Math.min(depth, 2)}">
    <div class="goal-row">
      <div><strong>${esc(goal.title)}</strong><span>${esc(goal.level)}${goal.projectId ? ` · ${esc(goal.projectId)}` : ""}</span></div>
      <em class="${progress.blocked ? "status-warn" : tone}">${esc(detail)}</em>
    </div>
    ${goal.children?.length ? `<ul class="goal-tree">${goal.children.map((child) => renderGoal(child, esc, depth + 1)).join("")}</ul>` : ""}
  </li>`;
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section goals-panel" aria-labelledby="factory-goals-title">
    <div class="section-heading"><div><span class="eyebrow">Direction</span><h2 id="factory-goals-title">Goals</h2></div><span class="objective-status ${statusTone}">${statusLabel}</span></div>
    ${body}
  </section>`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
