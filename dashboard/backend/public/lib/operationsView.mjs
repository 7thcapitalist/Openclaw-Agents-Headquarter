export function operationsPanel(source, { esc = escapeHtml, fmtTime = (value) => value || "—" } = {}) {
  if (!source) return `<section class="founder-section operations-panel"><div class="section-heading"><div><span class="eyebrow">Operations</span><h2>Factory control</h2></div><span class="objective-status status-warn">Unavailable</span></div><div class="quiet-state">Operational telemetry is not available yet.</div></section>`;
  const s = source.summary || {};
  const degraded = source.available === false;
  const tasks = Array.isArray(source.tasks) ? source.tasks : [];
  const audit = Array.isArray(source.audit) ? source.audit : [];
  return `<section class="founder-section operations-panel" aria-labelledby="factory-operations-title">
    <div class="section-heading"><div><span class="eyebrow">Operations</span><h2 id="factory-operations-title">Factory control</h2></div><span class="objective-status ${degraded ? "status-warn" : "status-good"}">${degraded ? "Degraded" : "Live"}</span></div>
    <div class="operations-metrics"><div><strong>${number(s.activeRuns)}</strong><span>active runs</span></div><div><strong>${number(s.leasedTasks)}</strong><span>leased tasks</span></div><div><strong>${number(s.queuedWakeups)}</strong><span>queued</span></div><div><strong>${number(s.deadLetters)}</strong><span>dead letters</span></div></div>
    ${degraded ? `<p class="operations-warning" role="status">Some telemetry is unavailable. Canonical factory work continues.</p>` : ""}
    <div class="operations-list">${tasks.slice(0, 5).map((task) => `<div class="operation-row"><span class="status-dot ${["needs-followup", "advanced"].includes(task.liveness?.state) ? "is-working" : ""}"></span><div><strong>${esc(task.taskId)}</strong><span>${esc(task.actor || "unassigned")} · ${esc(task.stage || task.status || "unknown")}${task.liveness?.state ? ` · ${esc(task.liveness.state)}` : ""}</span></div><em>${task.lease ? `owned until ${esc(fmtTime(task.lease.expiresAt))}` : "not leased"}</em></div>`).join("") || `<div class="quiet-state">No task telemetry recorded.</div>`}</div>
    <details class="operations-detail"><summary>Recent attributed events</summary>${audit.slice(0, 8).map((event) => `<div class="operation-event"><time>${esc(fmtTime(event.occurredAt))}</time><span>${esc(event.actor?.id || "system")} · ${esc(event.action || "event")}</span></div>`).join("") || `<div class="quiet-state">No audit events recorded.</div>`}</details>
    <p class="operations-cost"><strong>${formatTokens(number(s.inputTokens) + number(s.outputTokens))}</strong> recorded tokens${number(s.unpricedEvents) ? ` · ${number(s.unpricedEvents)} unpriced event${number(s.unpricedEvents) === 1 ? "" : "s"}` : ""}</p>
  </section>`;
}
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0; }
function formatTokens(value) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value); }
function escapeHtml(value) { return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
