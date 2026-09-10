// The unified run timeline, rendered inside the task execution view.
//
// Seven layers write the operational record of a run. This shows them merged in
// order with each entry's source named, because a disagreement between layers —
// workflow says complete, liveness says blocked — is the single most useful
// thing a founder can see, and averaging it away is how a run looks fine while
// being stuck.

const SOURCE_LABEL = {
  workflow: "workflow",
  audit: "audit",
  liveness: "liveness",
  lease: "ownership",
  wakeup: "wakeup",
  cost: "cost",
  graph: "graph",
};

export function runTimelineSection(timeline, { esc = escapeHtml, fmtTime = (value) => value || "—" } = {}) {
  if (!timeline) {
    return `<section class="run-timeline"><div class="operation-section-title"><span class="eyebrow">Run record</span><h3>Timeline</h3></div><p class="quiet-state">No unified timeline is available for this run.</p></section>`;
  }

  const entries = Array.isArray(timeline.entries) ? timeline.entries : [];
  const sources = Array.isArray(timeline.sources) ? timeline.sources : [];
  const broken = sources.filter((source) => source.available === false);
  const missing = sources.filter((source) => source.available !== false && source.present === false);

  return `<section class="run-timeline">
    <div class="operation-section-title"><span class="eyebrow">Run record</span><h3>Timeline</h3></div>
    ${broken.length ? `<p class="operations-warning" role="status">${broken.length} source(s) could not be read: ${broken.map((source) => `${esc(SOURCE_LABEL[source.name] || source.name)} (${esc(source.reason || "unknown")})`).join(", ")}. This timeline is incomplete.</p>` : ""}
    <div class="timeline-sources">${sources.map((source) => `<span class="timeline-source is-${source.available === false ? "broken" : source.present ? "present" : "absent"}">${esc(SOURCE_LABEL[source.name] || source.name)}${source.present && timeline.counts?.[source.name] ? ` ${number(timeline.counts[source.name])}` : ""}</span>`).join("")}</div>
    ${missing.length ? `<p class="timeline-note">${missing.length} layer(s) recorded nothing for this run. That is normal for a run older than the telemetry that writes them — it is shown rather than hidden so the gap is not mistaken for a clean record.</p>` : ""}
    ${timeline.truncated ? `<p class="timeline-note">Older entries are not shown.</p>` : ""}
    <div class="timeline-stream">${entries.slice().reverse().map((entry) => `<div class="timeline-entry"><time>${esc(fmtTime(entry.at))}</time><span class="timeline-source is-present">${esc(SOURCE_LABEL[entry.source] || entry.source)}</span><div><strong>${esc(entry.kind)}</strong>${entry.actor ? `<span>${esc(entry.actor)}${entry.stage ? ` · ${esc(entry.stage)}` : ""}</span>` : entry.stage ? `<span>${esc(entry.stage)}</span>` : ""}${entry.detail ? `<p>${esc(entry.detail)}</p>` : ""}</div></div>`).join("") || `<p class="quiet-state">Nothing has been recorded for this run yet.</p>`}</div>
    ${renderFooter(timeline, esc)}
  </section>`;
}

function renderFooter(timeline, esc) {
  const cost = timeline.cost || null;
  const evidence = Array.isArray(timeline.evidence) ? timeline.evidence : [];
  const ownership = timeline.ownership || null;
  const parts = [];
  if (ownership) parts.push(`owned by <strong>${esc(ownership.actorId || "unknown")}</strong> until ${esc(timeline.ownership.expiresAt || "—")}`);
  if (cost && cost.events) {
    parts.push(`${number(cost.inputTokens + cost.outputTokens)} tokens over ${number(cost.events)} recorded call(s)${cost.unpricedEvents ? ` · ${number(cost.unpricedEvents)} unpriced` : ""}`);
  }
  // Evidence is listed by PATH. Rendering its content here would put agent
  // output and repository files into a view that exists to summarise them.
  if (evidence.length) parts.push(`${number(evidence.length)} evidence artifact(s): ${evidence.slice(0, 4).map((item) => `<code>${esc(item.path)}</code>`).join(", ")}`);
  return parts.length ? `<p class="timeline-note">${parts.join(" · ")}</p>` : "";
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
