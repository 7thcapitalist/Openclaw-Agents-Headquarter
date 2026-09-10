// The founder's own record: what has the factory asked me, and what did I say.
//
// Read-only by construction. The authority is the Ed25519 assertion verified in
// task-workflow.mjs; this panel reports what already happened and offers no
// control, because a second place to approve things is a second thing to
// compromise.

const STATE = {
  requested: ["Waiting on you", "status-warn"],
  approved: ["Approved", "status-good"],
  consumed: ["Approved and used", "status-good"],
  rejected: ["Rejected", ""],
  revoked: ["Revoked by re-key", "status-warn"],
  expired: ["Expired", ""],
};

export function decisionsPanel(source, { esc = escapeHtml, fmtTime = (value) => value || "—" } = {}) {
  if (!source) return shell("Unavailable", "status-warn", `<div class="quiet-state">Decision history is not available yet.</div>`);

  const summary = source.summary || {};
  const decisions = Array.isArray(source.decisions) ? source.decisions : [];
  const waiting = number(summary.awaitingFounder);
  const degraded = source.available === false;

  if (!decisions.length) {
    return shell("Nothing recorded", "", `<div class="quiet-state">The factory has not asked you to decide anything yet.</div>`);
  }

  return shell(waiting ? `${waiting} waiting on you` : "All answered", waiting ? "status-warn" : "status-good", `
    ${degraded ? `<p class="operations-warning" role="status">Some task state could not be read, so this history is incomplete.</p>` : ""}
    ${number(summary.unsigned) ? `<p class="operations-warning" role="status">${number(summary.unsigned)} approval(s) recorded without a verified signature. Investigate before trusting them.</p>` : ""}
    <div class="decision-list">${decisions.slice(0, 6).map((decision) => renderDecision(decision, esc, fmtTime)).join("")}</div>
    <p class="decision-authority">Authority is the founder's signed assertion. This is a record of it, never a way to grant it.</p>
  `);
}

function renderDecision(decision, esc, fmtTime) {
  const [label, tone] = STATE[decision.state] || ["Unknown", ""];
  return `<div class="decision-row">
    <span class="status-dot ${decision.state === "requested" ? "is-waiting" : ""}"></span>
    <div>
      <strong>${esc(decision.summary)}</strong>
      <span>${esc(decision.taskId || "—")}${decision.projectId ? ` · ${esc(decision.projectId)}` : ""}${decision.evidence?.signatureVerified ? " · signed" : ""}</span>
    </div>
    <em class="${tone}">${esc(label)}<br><time>${esc(fmtTime(decision.updatedAt))}</time></em>
  </div>`;
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section decisions-panel" aria-labelledby="factory-decisions-title">
    <div class="section-heading"><div><span class="eyebrow">Decisions</span><h2 id="factory-decisions-title">Approval history</h2></div><span class="objective-status ${statusTone}">${statusLabel}</span></div>
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
