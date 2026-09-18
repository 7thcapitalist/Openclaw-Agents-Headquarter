const REASONS = Object.freeze({
  "seat-unknown": "Anthropic headroom unknown",
  "founder-active": "founder objective active",
  "founder-queued": "founder work queued",
  "open-pr-cap": "PRs awaiting founder",
  "short-window-low": "short-window headroom below reserve",
  "weekly-low": "weekly headroom below reserve",
  "no-expiring-surplus": "no credit is close to expiring",
  "self-improvement-running": "self-improvement objective already running",
  "daily-cap": "daily self-improvement limit reached",
  "no-eligible-finding": "no eligible finding",
  "open-prs-unknown": "open PR status unknown",
  "launch-recheck-failed": "launch conditions changed before start",
  "not-evaluated": "not evaluated yet",
  "state-unavailable": "learning state unavailable",
});

export function idleReasonLabel(code, state = {}) {
  if (code == null || code === "") return null;
  if (code === "open-pr-cap") {
    const count = Number(state.openPrCount ?? state.openPrsAwaitingFounder);
    if (Number.isFinite(count)) return `${count} PR${count === 1 ? "" : "s"} awaiting founder`;
  }
  return REASONS[code] || String(code);
}

function defaultEsc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function list(value) { return Array.isArray(value) ? value : []; }

function findingCard(finding, esc) {
  const evidence = list(finding?.evidence);
  const status = finding?.eligible ? "eligible" : `ineligible${finding?.ineligibleReason ? ` · ${finding.ineligibleReason}` : ""}`;
  return `<li class="learning-item">
    <div class="learning-item-head"><strong>${esc(finding?.title || finding?.id || "Untitled finding")}</strong><span class="badge ${finding?.eligible ? "badge-ok" : "badge-warn"}">${esc(status)}</span></div>
    ${finding?.id ? `<div class="mono-id">${esc(finding.id)}</div>` : ""}
    ${evidence.length ? `<ul class="learning-evidence">${evidence.map((entry) => `<li><a href="#/tasks" title="Open the factory evidence surface">${esc(entry)}</a></li>`).join("")}</ul>` : `<p class="muted small">No evidence references.</p>`}
  </li>`;
}

function activityCard(item, kind, esc, fmtTime) {
  const labels = { launch: "launched", shadow: "would have launched", proposal: "awaiting founder" };
  const objective = item?.objective || item?.objectiveId || "Objective not recorded";
  return `<li class="learning-item learning-item--${kind}">
    <div class="learning-item-head"><strong>${esc(objective)}</strong><span class="badge">${esc(labels[kind])}</span></div>
    <div class="learning-meta">${esc(fmtTime(item?.at))} · from finding ${esc(item?.findingId || "unknown")}</div>
  </li>`;
}

export function learningPanel(source, { esc = defaultEsc, fmtTime = (value) => value || "-" } = {}) {
  if (!source || source.available === false) {
    return `<section class="learning-panel"><h1 class="page-title">Learning</h1><div class="quiet-state">Learning state is unavailable${source?.error ? `: ${esc(source.error)}` : "."}</div></section>`;
  }
  const mode = ["off", "shadow", "on"].includes(source.mode) ? source.mode : "off";
  const findings = list(source.findings);
  const launches = list(source.launches);
  const shadows = list(source.wouldHaveLaunched);
  const proposals = list(source.proposals);
  const allActivity = [
    ...launches.map((item) => [item, "launch"]),
    ...shadows.map((item) => [item, "shadow"]),
    ...proposals.map((item) => [item, "proposal"]),
  ].sort((a, b) => String(b[0]?.at || "").localeCompare(String(a[0]?.at || "")));
  const idle = idleReasonLabel(source.idleReason, source);
  const credit = source.credit || {};
  const empty = findings.length === 0 && allActivity.length === 0;
  return `<section class="learning-panel" aria-labelledby="learning-title">
    <div class="learning-header"><div><span class="eyebrow">Factory intelligence</span><h1 class="page-title" id="learning-title">Learning</h1></div>
      <label class="learning-mode">Mode<select id="learning-mode" aria-label="Learning mode">
        ${["off", "shadow", "on"].map((value) => `<option value="${value}"${value === mode ? " selected" : ""}>${value}</option>`).join("")}
      </select></label>
    </div>
    ${idle ? `<p class="learning-idle"><strong>Idle:</strong> ${esc(idle)}</p>` : ""}
    <div class="learning-credit" aria-label="Learning credit estimate">
      <div><strong>${esc(credit.usedBySelfImprovement ?? 0)}</strong><span>used by self-improvement</span></div>
      <div><strong>${esc(credit.wouldHaveExpired ?? 0)}</strong><span>would otherwise have expired</span></div>
      <small>${esc(credit.basis || "estimate")}</small>
    </div>
    ${empty ? `<div class="quiet-state">No findings or launches yet.</div>` : `
      <div class="learning-grid">
        <section><h2 class="section-title">Recent findings</h2>${findings.length ? `<ul class="learning-list">${findings.map((item) => findingCard(item, esc)).join("")}</ul>` : `<div class="quiet-state">No findings yet.</div>`}</section>
        <section><h2 class="section-title">Learning activity</h2>${allActivity.length ? `<ul class="learning-list">${allActivity.map(([item, kind]) => activityCard(item, kind, esc, fmtTime)).join("")}</ul>` : `<div class="quiet-state">Nothing launched yet.</div>`}</section>
      </div>`}
  </section>`;
}

export { REASONS as IDLE_REASON_LABELS };
