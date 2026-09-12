// How far a single run reached.
//
// Permissions (#141) bound *which* work an agent may touch. Nothing bounded
// *how much*: an agent granted `company:*` may act on an unlimited number of
// tasks inside that scope. Scope and blast radius are different properties, and
// this is the second one.
//
// Alert-only, like the counter behind it (#160/#172): nothing here refuses
// anything, and crossing the threshold reports rather than stopping work.

export function blastRadiusPanel(source, { esc = escapeHtml } = {}) {
  if (!source) {
    return shell("Unavailable", "status-warn",
      `<div class="quiet-state">Blast radius is not available yet.</div>`);
  }
  if (source.available === false) {
    return shell("Unavailable", "status-warn",
      `<div class="quiet-state">${esc(source.error || "Run records could not be read, so reach cannot be measured.")}</div>`);
  }

  const summary = source.summary || {};
  const runs = Array.isArray(source.runs) ? source.runs : [];
  const over = number(summary.overThreshold);
  const threshold = number(source.threshold);
  const warnings = Array.isArray(source.warnings) ? source.warnings : [];

  // No runs and no runs-over-threshold are different facts. The first means
  // nothing has been measured yet; the second is a clean bill of health.
  if (!number(summary.runs)) {
    return shell("No runs measured", "", `
      ${renderWarnings(warnings, esc)}
      <div class="quiet-state">${esc(`No run has recorded the subjects it touched yet. Reach is counted per run, against a threshold of ${threshold}.`)}</div>
    `);
  }

  const [label, tone] = over ? [`${over} over threshold`, "status-warn"] : ["Within threshold", "status-good"];

  return shell(label, tone, `
    ${renderWarnings(warnings, esc)}
    <div class="blast-summary">
      <div><b>${number(summary.runs)}</b><span>runs measured</span></div>
      <div><b class="${over ? "status-warn" : ""}">${over}</b><span>over ${threshold}</span></div>
      <div><b>${number(summary.widestRun)}</b><span>widest reach</span></div>
    </div>
    <p class="blast-note">Counts distinct subjects one run was allowed to act on — reaching the same task twice is one subject. Alert-only: nothing is refused.</p>
    ${runs.length ? `<ul class="blast-list">${runs.slice(0, 5).map((run) => renderRun(run, threshold, esc)).join("")}</ul>` : ""}
  `);
}

function renderRun(run, threshold, esc) {
  const subjects = number(run.subjects);
  const over = Boolean(run.atOrOverThreshold);
  // One scale across every row, so the bars are comparable to each other and to
  // the threshold rather than each being drawn to its own maximum.
  const scale = Math.max(threshold, subjects, 1);
  return `<li class="blast-run">
    <div class="blast-run-head">
      <strong>${esc(run.runId || run.taskId || "unidentified run")}</strong>
      <em class="${over ? "status-warn" : ""}">${subjects} subject${subjects === 1 ? "" : "s"}</em>
    </div>
    <div class="blast-bar" role="img" aria-label="${esc(`${subjects} of a ${threshold} subject threshold`)}">
      <span class="${over ? "is-over" : ""}" style="width:${Math.round((subjects / scale) * 100)}%"></span>
    </div>
    ${run.actor ? `<p class="blast-actor">${esc(run.actor)}</p>` : ""}
  </li>`;
}

function renderWarnings(warnings, esc) {
  if (!warnings.length) return "";
  return `<p class="operations-warning" role="status">${esc(warnings[0])}${
    warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ""}</p>`;
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section blast-panel" aria-labelledby="factory-blast-title">
    <div class="section-heading">
      <div><span class="eyebrow">Reach</span><h2 id="factory-blast-title">Blast radius</h2></div>
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
