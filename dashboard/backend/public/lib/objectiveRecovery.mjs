// Pure helpers for the objective-card "Retry recoverable work" affordance.
// No DOM deps — imported by app.js (via window) and by factory DOM tests.

export function isObjectiveRecoverable(o) {
  return (o?.recovery?.count || 0) > 0;
}

export function renderObjectiveRecovery(o, { esc }) {
  if (!isObjectiveRecoverable(o)) return "";
  const n = o.recovery.count;
  const who = (o.recovery.nodes || []).map((x) => esc(x.title || x.role)).join(", ");
  const attempts = o.recovery.attempts > 0
    ? ` <span class="muted small">(retried ${o.recovery.attempts}×)</span>`
    : "";
  return `<div class="obj-recovery">
    <span class="obj-recovery-note">Infrastructure hiccup on ${n} step${n === 1 ? "" : "s"} (${who}) — not a decision for you.${attempts}</span>
    <button class="btn secondary tiny" data-retry-objective="${esc(o.objectiveId)}">Retry recoverable work</button>
  </div>`;
}
