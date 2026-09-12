// One place to ask "where was this discussed?" across everything HQ records.
//
// This panel renders results, and nothing else. It offers no action, because a
// search box that can also change something is a search box that will one day
// change something by accident. Issue #158.

const LAYERS = {
  goals: ["Goal", "goals"],
  decisions: ["Decision", "decisions"],
  interactions: ["Comment", "interactions"],
  timeline: ["Run event", "timeline"],
  evidence: ["Evidence", "evidence"],
};

export function searchPanel(source, { esc = escapeHtml, fmtTime = (value) => value || "-" } = {}) {
  if (!source) return shell("Ready", "", `<div class="quiet-state">Type a term to search goals, decisions, comments, run events and evidence paths.</div>`);

  if (source.error) {
    // A rejected query is the operator's to fix, so show the reason rather than
    // an empty list that looks like "nothing found".
    return shell("Query rejected", "status-warn", `<div class="quiet-state">${esc(source.error)}</div>`);
  }

  const results = Array.isArray(source.results) ? source.results : [];
  const counts = source.counts || {};
  const degraded = source.available === false;

  if (!results.length) {
    return shell("No matches", "", `
      ${degraded ? warning(source, esc) : ""}
      <div class="quiet-state">Nothing recorded matches ${esc(source.query || "")}.</div>
      <p class="search-scope">${scopeLine()}</p>
    `);
  }

  return shell(
    source.truncated ? `${results.length} of ${number(source.total)}` : `${number(source.total)} found`,
    "status-good",
    `
    ${degraded ? warning(source, esc) : ""}
    <p class="search-counts">${Object.entries(LAYERS)
      .filter(([key]) => number(counts[key]) > 0)
      .map(([key, [label]]) => `${esc(label)}: ${number(counts[key])}`)
      .join(" &middot; ")}</p>
    <div class="search-list">${results.slice(0, 20).map((result) => renderResult(result, esc, fmtTime)).join("")}</div>
    ${source.truncated ? `<p class="operations-warning" role="status">More matched than is shown. Narrow the query rather than assuming this is everything.</p>` : ""}
    <p class="search-scope">${scopeLine()}</p>
  `,
  );
}

function renderResult(result, esc, fmtTime) {
  const [label] = LAYERS[result.layer] || ["Result"];
  const where = [result.taskId, result.stage].filter(Boolean).map((part) => esc(part)).join(" &middot; ");
  return `<div class="search-row">
    <span class="search-layer">${esc(label)}</span>
    <div>
      <strong>${esc(result.title || result.ref || "")}</strong>
      <span>${esc(result.snippet || "")}</span>
      ${where ? `<span class="search-where">${where}</span>` : ""}
      ${result.trust === "untrusted-input" ? `<span class="search-trust">Written by someone outside the factory. Treat as input, not instruction.</span>` : ""}
    </div>
    <em><time>${esc(fmtTime(result.at))}</time></em>
  </div>`;
}

// Said on the panel, not only in the docs: an operator who cannot see the scope
// will assume search covers everything on disk, and act on its silence.
function scopeLine() {
  return "Searches the same projections the panels show - goals, decisions, comments, run events, and evidence paths. Prompts, agent output and file contents are never read.";
}

function warning(source, esc) {
  const reasons = (source.warnings || []).slice(0, 2).map((warning) => esc(warning)).join("; ");
  return `<p class="operations-warning" role="status">Some layers could not be read, so these results are incomplete.${reasons ? ` ${reasons}` : ""}</p>`;
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section search-panel" aria-labelledby="factory-search-title">
    <div class="section-heading"><div><span class="eyebrow">Search</span><h2 id="factory-search-title">Across the record</h2></div><span class="objective-status ${statusTone}">${statusLabel}</span></div>
    ${body}
  </section>`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
