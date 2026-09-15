// Deployment status across the estate.
//
// Read-only. Deploying is a gated factory action — `production-deploy` is in
// prohibitedAutonomousActions and a real deploy needs allowRealDeploy — so this
// panel reports and offers no control that could start one.

const STATE = {
  deployed: ["Live", "status-good"],
  failed: ["Failed", "status-bad"],
  not_deployed: ["Never deployed", ""],
  unknown: ["Unrecognised state", "status-warn"],
};

export function deploymentsPanel(source, { esc = escapeHtml, fmtTime = String } = {}) {
  if (!source) {
    return shell("Unavailable", "status-warn", `<div class="quiet-state">Deployment status is not available yet.</div>`);
  }
  if (source.available === false) {
    return shell("Unavailable", "status-warn",
      `<div class="quiet-state">${esc(source.error || "Deployment records could not be read.")}</div>`);
  }

  const summary = source.summary || {};
  const rows = Array.isArray(source.deployments) ? source.deployments : [];
  const warnings = Array.isArray(source.warnings) ? source.warnings : [];

  if (!rows.length) {
    return shell("No projects", "", `
      ${renderWarnings(warnings, esc)}
      <div class="quiet-state">No projects are registered, so there is nothing to deploy.</div>`);
  }

  const [label, tone] = number(summary.awaitingFounder) ? [`${number(summary.awaitingFounder)} awaiting you`, "status-warn"]
    : number(summary.failed) ? [`${number(summary.failed)} failed`, "status-bad"]
    : number(summary.deployed) ? [`${number(summary.deployed)} live`, "status-good"]
    : ["None deployed", ""];

  return shell(label, tone, `
    ${renderWarnings(warnings, esc)}
    <ul class="deploy-list">${rows.map((row) => renderRow(row, esc, fmtTime)).join("")}</ul>
  `);
}

function renderRow(row, esc, fmtTime) {
  const [stateLabel, stateTone] = STATE[row.state] || STATE.unknown;
  // The production URL is the one piece an operator actually wants to click, so
  // it is a link when there is one — and rel-hardened, because the value comes
  // from a provider response rather than from this codebase.
  const url = row.productionUrl && /^https?:\/\//i.test(row.productionUrl)
    ? `<a href="${esc(row.productionUrl)}" target="_blank" rel="noopener noreferrer">${esc(row.productionUrl)}</a>`
    : row.productionUrl ? esc(row.productionUrl) : "";
  return `<li class="deploy-row">
    <div class="deploy-head">
      <div><strong>${esc(row.name)}</strong><span>${esc(row.projectKey)}${row.kind ? ` · ${esc(row.kind)}` : ""}</span></div>
      <em class="objective-status ${row.founderActionRequired ? "status-warn" : stateTone}">${
        row.founderActionRequired ? "Needs you" : stateLabel}</em>
    </div>
    ${url ? `<p class="deploy-url">${url}</p>` : ""}
    <p class="deploy-meta">${[
      row.founderActionRequired ? `<strong class="status-warn">${stateLabel}, waiting on a founder action</strong>` : null,
      // A URL the registry declares is the founder's own note of where a
      // project lives; it is not evidence that anything was deployed. Saying
      // so is the difference between a useful link and a false claim.
      row.productionUrlSource === "registry" ? "URL declared in the registry, not observed from a deploy" : null,
      row.health ? `health ${esc(String(row.health))}` : null,
      row.lastDeploymentAt ? `last deployed ${esc(fmtTime(row.lastDeploymentAt))}` : null,
    ].filter(Boolean).join(" · ") || "No deployment recorded yet."}</p>
  </li>`;
}

function renderWarnings(warnings, esc) {
  if (!warnings.length) return "";
  return `<p class="operations-warning" role="status">${esc(warnings[0])}${
    warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ""}</p>`;
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section deploy-panel" aria-labelledby="factory-deploy-title">
    <div class="section-heading">
      <div><span class="eyebrow">Shipping</span><h2 id="factory-deploy-title">Deployments</h2></div>
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
