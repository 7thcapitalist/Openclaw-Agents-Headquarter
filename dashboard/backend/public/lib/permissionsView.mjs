// What scoped permissions are doing right now.
//
// The panel is deliberately loudest in `report` mode, because that is the mode
// where the founder is deciding whether to turn enforcement on and needs to see
// what it would break. In `off` it is a single quiet line — an unused control
// should not occupy the founder's attention.

const MODE = {
  off: ["Not enforcing", "", "Scoped permissions are off. Every factory action runs as before."],
  report: ["Observing", "status-warn", "Decisions are recorded but nothing is blocked. Review what enforcement would stop before turning it on."],
  enforce: ["Enforcing", "status-good", "Ungranted capabilities are denied."],
};

export function permissionsPanel(source, { esc = escapeHtml, fmtTime = (value) => value || "—" } = {}) {
  if (!source) return shell("Unavailable", "status-warn", `<div class="quiet-state">Permission data is not available yet.</div>`);

  const [label, tone, blurb] = MODE[source.enforcement] || MODE.off;
  const summary = source.summary || {};
  const denials = Array.isArray(source.recentDenials) ? source.recentDenials : [];
  const degraded = source.available === false;

  // A registry that cannot be read is not "no permissions": task initialization
  // refuses outright in that state, so it must read as broken, not as off.
  if (degraded) {
    return shell("Broken", "status-bad", `
      <p class="operations-warning" role="status">The permission registry could not be read, so task initialization will refuse until it is fixed.</p>
      <ul class="permission-warnings">${(source.warnings || []).slice(0, 3).map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>
    `);
  }

  if (source.enforcement === "off") {
    return shell(label, tone, `<div class="quiet-state">${esc(blurb)}</div>`);
  }

  return shell(label, tone, `
    <p class="permission-blurb">${esc(blurb)}</p>
    <div class="operations-metrics"><div><strong>${number(summary.grants)}</strong><span>grants</span></div><div><strong>${number(summary.actors)}</strong><span>agents</span></div><div><strong>${number(summary.denials)}</strong><span>${source.enforcement === "report" ? "would be denied" : "denied"}</span></div><div><strong>${number(summary.wouldDeny)}</strong><span>observed only</span></div></div>
    <div class="operations-list">${denials.slice(0, 5).map((denial) => `<div class="operation-row"><span class="status-dot"></span><div><strong>${esc(denial.actorId)}</strong><span>${esc(denial.capability)} · ${esc(denial.reason)}${denial.subject?.id ? ` · ${esc(denial.subject.id)}` : ""}</span></div><em>${esc(fmtTime(denial.occurredAt))}</em></div>`).join("") || `<div class="quiet-state">No permission denials recorded.</div>`}</div>
  `);
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section permissions-panel" aria-labelledby="factory-permissions-title">
    <div class="section-heading"><div><span class="eyebrow">Authority</span><h2 id="factory-permissions-title">Agent permissions</h2></div><span class="objective-status ${statusTone}">${statusLabel}</span></div>
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
