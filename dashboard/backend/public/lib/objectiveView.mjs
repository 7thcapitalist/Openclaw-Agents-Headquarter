// Pure rendering + grouping for the founder-facing objective cards on Today.
// No DOM deps — imported by app.js and by factory tests (mirrors the shape of
// objectiveRecovery.mjs). Every field read here is produced by the backend
// presenter (factory/lib/hq/presenter.mjs) via buildObjectivesView: `title`,
// `headline`, `status6`, `statusLabel`, `statusTone`, `progress`, `nextAction`,
// `builders`, `nodeBriefs`, `lifecycle`, `archived`.

import { renderObjectiveRecovery } from "./objectiveRecovery.mjs";

const STATUS_TONE_CLASS = {
  good: "health-healthy",
  info: "badge-type",
  warn: "badge-warn",
  bad: "health-failed",
  neutral: "badge-type",
};

export function objectiveStatusBadgeClass(o) {
  return STATUS_TONE_CLASS[o?.statusTone] || "badge-type";
}

// title · project · status · progress · current stage/agent · next action.
// The point of the whole change: a founder reads this line in a second; the
// full prompt, parts, retries, and event history are one click away.
export function objectiveSummaryLine(o, { esc }) {
  const bits = [];
  if (o.project) bits.push(esc(o.project));
  if (o.statusLabel) bits.push(esc(o.statusLabel));
  if (o.progress?.label) bits.push(esc(o.progress.label));
  const runningNode = (o.nodeBriefs || []).find((n) => n.status === "RUNNING");
  const stage = runningNode?.stage || null;
  const agent = runningNode?.role || (o.builders || [])[0] || null;
  if (stage) bits.push(esc(stage));
  else if (agent) bits.push(esc(agent));
  if (o.nextAction?.label) bits.push(`next: ${esc(o.nextAction.label)}`);
  return bits.join(" · ");
}

// Split the real (non-seed) objective list into the four ACTIVE buckets plus
// HISTORY and ARCHIVED. `lifecycle` comes from the backend; the ACTIVE split is
// just the presenter status.
export function groupObjectives(objectives = []) {
  const g = { running: [], waiting: [], blocked: [], recentlyCompleted: [], history: [], archived: [] };
  for (const o of objectives) {
    if (o.lifecycle === "archived") { g.archived.push(o); continue; }
    if (o.lifecycle === "history") { g.history.push(o); continue; }
    switch (o.status6) {
      case "WAITING_FOR_FOUNDER": g.waiting.push(o); break;
      case "BLOCKED":
      case "FAILED": g.blocked.push(o); break;
      case "COMPLETE": g.recentlyCompleted.push(o); break;
      default: g.running.push(o); // RUNNING / PENDING / anything else still active
    }
  }
  return g;
}

function archiveButton(o, { esc }) {
  return o.lifecycle === "archived"
    ? `<button class="btn secondary tiny" data-unarchive-objective="${esc(o.objectiveId)}">Unarchive</button>`
    : `<button class="btn secondary tiny" data-archive-objective="${esc(o.objectiveId)}">Archive</button>`;
}

// Compact ACTIVE card: human title, one summary line, the headline, the recovery
// affordance if any, and drill-down / report / archive controls. No raw prompt,
// no node dump.
export function renderObjectiveCard(o, { esc }) {
  if (o.status === "invalid") {
    return `<article class="obj-card"><strong>${esc(o.objectiveId)}</strong><p class="danger-text small">${esc(o.error || "invalid objective state")}</p></article>`;
  }
  const recovery = renderObjectiveRecovery(o, { esc }) || "";
  return `<article class="obj-card obj-card-compact">
    <div class="obj-card-head">
      <div>
        <strong>${esc(o.title || o.objectiveId)}</strong>
        <span class="muted small">${objectiveSummaryLine(o, { esc })}</span>
      </div>
      <span class="badge ${STATUS_TONE_CLASS[o.statusTone] || "badge-type"}">${esc(o.statusLabel || o.status6 || "—")}</span>
    </div>
    ${o.headline ? `<p class="obj-headline">${esc(o.headline)}</p>` : ""}
    ${recovery}
    <div class="obj-card-foot">
      <button class="btn secondary tiny" data-objective-details="${esc(o.objectiveId)}">Details</button>
      <button class="btn secondary tiny" data-report-objective="${esc(o.objectiveId)}">Report</button>
      ${o.prUrl ? `<a class="btn secondary tiny" href="${esc(o.prUrl)}" target="_blank" rel="noreferrer">PR ↗</a>` : ""}
      ${archiveButton(o, { esc })}
    </div>
  </article>`;
}

// One-line HISTORY / ARCHIVED row — present and reachable, never dominating.
export function renderObjectiveHistoryRow(o, { esc }) {
  const title = o.status === "invalid" ? o.objectiveId : (o.title || o.objectiveId);
  return `<div class="obj-history-row">
    <div class="obj-history-main">
      <strong>${esc(title)}</strong>
      <span class="muted small">${objectiveSummaryLine(o, { esc })}</span>
    </div>
    <div class="obj-history-meta">
      <span class="badge ${STATUS_TONE_CLASS[o.statusTone] || "badge-type"}">${esc(o.statusLabel || o.status6 || o.status || "—")}</span>
      <button class="btn secondary tiny" data-objective-details="${esc(o.objectiveId)}">Details</button>
      <button class="btn secondary tiny" data-report-objective="${esc(o.objectiveId)}">Report</button>
      ${archiveButton(o, { esc })}
    </div>
  </div>`;
}
