// Ranked work proposals for the Today view.
//
// Report-only, and the panel says so out loud. Every proposal points at
// something already in canonical state and shows the numbers it was ranked on,
// so the founder can check the reasoning rather than trust it. There is no
// control here that starts work: promoting a proposal is done by queueing it,
// which stays a deliberate act.

const KIND_LABEL = {
  unblock: ["Blocked", "status-warn"],
  systemic: ["Recurring", "status-warn"],
  neglected: ["Untouched", ""],
};

export function proposerPanel(source, { esc = escapeHtml } = {}) {
  if (!source) {
    return shell("Unavailable", "status-warn",
      `<div class="quiet-state">Proposals are not available yet.</div>`);
  }

  // "Nothing to propose" and "nothing to propose from" are different facts and
  // must not render the same way. The first is good news; the second means the
  // inputs are missing and the panel is blind.
  if (source.available === false) {
    return shell("Not configured", "",
      `<div class="quiet-state">No goals are defined, so there is nothing to rank work against. Add them to <code>factory/goals.json</code> and open a pull request.</div>`);
  }

  const proposals = Array.isArray(source.proposals) ? source.proposals : [];
  const warnings = Array.isArray(source.warnings) ? source.warnings : [];

  if (!proposals.length) {
    return shell("Clear", "status-good", `
      ${renderWarnings(warnings, esc)}
      <div class="quiet-state">${esc(`Nothing is blocked, recurring or untouched across ${number(source.considered?.goals)} goal${number(source.considered?.goals) === 1 ? "" : "s"}.`)}</div>
    `);
  }

  const [label, tone] = proposals[0].kind === "neglected" ? ["Suggestions", ""] : ["Needs attention", "status-warn"];

  return shell(label, tone, `
    ${renderWarnings(warnings, esc)}
    <p class="proposer-lede">Ranked from canonical state — nothing here is started automatically.</p>
    <ol class="proposer-list">${proposals.map((p) => renderProposal(p, esc)).join("")}</ol>
  `);
}

function renderProposal(proposal, esc) {
  const [kindLabel, kindTone] = KIND_LABEL[proposal.kind] || ["Proposal", ""];
  const evidence = proposal.evidence || {};
  const goalProjected = /goal projection/i.test(String(evidence.source || ""));
  const context = [
    proposal.goalLevel ? esc(proposal.goalLevel) : null,
    proposal.projectId ? esc(proposal.projectId) : null,
  ].filter(Boolean).join(" · ");

  return `<li class="proposer-item">
    <div class="proposer-head">
      <span class="proposer-rank">${number(proposal.rank)}</span>
      <div class="proposer-title">
        <strong>${esc(proposal.title || "Untitled")}</strong>
        ${context ? `<span>${context}</span>` : ""}
      </div>
      <em class="objective-status ${kindTone}">${kindLabel}</em>
    </div>
    ${goalProjected ? "" : `<p class="proposer-why">${esc(proposal.why || "")}</p>`}
    ${goalProjected ? "" : renderBar(evidence)}
  </li>`;
}

// The same numbers the ranking used, drawn to one scale so the reader can see
// the shape of the problem without reading the counts.
function renderBar(evidence) {
  const total = number(evidence.total);
  if (!total) return "";
  const blocked = number(evidence.blocked);
  const active = number(evidence.active);
  const complete = number(evidence.complete);
  const pct = (n) => `${Math.round((n / total) * 100)}%`;
  return `<div class="proposer-bar" role="img"
      aria-label="${complete} complete, ${blocked} blocked, ${active} active, of ${total}">
      <span class="seg-complete" style="width:${pct(complete)}"></span>
      <span class="seg-blocked" style="width:${pct(blocked)}"></span>
      <span class="seg-active" style="width:${pct(active)}"></span>
    </div>
    <p class="proposer-counts">${complete} complete · <strong>${blocked} blocked</strong> · ${active} active · ${total} total</p>`;
}

function renderWarnings(warnings, esc) {
  if (!warnings.length) return "";
  return `<p class="operations-warning" role="status">${esc(warnings[0])}${
    warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ""}</p>`;
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section proposer-panel" aria-labelledby="factory-proposer-title">
    <div class="section-heading">
      <div><span class="eyebrow">What next</span><h2 id="factory-proposer-title">Proposed work</h2></div>
      <span class="objective-status ${statusTone}">${statusLabel}</span>
    </div>
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
