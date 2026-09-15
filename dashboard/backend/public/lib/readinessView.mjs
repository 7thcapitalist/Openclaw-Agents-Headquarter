// Is the machine healthy?
//
// `/api/system/readiness` has existed and worked for months with no surface on
// any screen. On 2026-09-14 a task's state store reached 399 GiB with about an
// hour of disk left, and nothing anywhere said so — the founder found out by
// asking. A check nobody can see is not a check.
//
// Read-only, like every other panel here. Nothing on it restarts a service or
// repairs a config; it reports, and names what to look at.

// Human names. `stateStores` is the thing that reached 399 GiB; "State stores"
// is what a person calls it.
const NAMES = {
  disk: "Disk",
  stateStores: "State stores",
  services: "Services",
  gateway: "Gateway",
  database: "Dashboard database",
};

// Worst first. A founder scanning this should hit the problem before the
// four things that are fine.
const ORDER = { fail: 0, warn: 1, degraded: 2, unknown: 3, ok: 4 };

const TONE = {
  ok: "status-good",
  warn: "status-warn",
  fail: "status-bad",
  degraded: "status-warn",
  unknown: "",
};

export function readinessPanel(source, { esc = escapeHtml } = {}) {
  if (!source) {
    return shell("Unavailable", "status-warn", `<div class="quiet-state">Machine health has not been checked yet.</div>`);
  }
  if (source.available === false) {
    return shell("Unavailable", "status-warn",
      `<div class="quiet-state">${esc(source.error || "The readiness report could not be built.")}</div>`);
  }

  const status = String(source.status || "unknown");
  const checks = Object.entries(source.checks || {})
    .map(([key, check]) => ({
      key,
      name: NAMES[key] || key,
      status: String(check?.status || "unknown"),
      detail: String(check?.detail || ""),
      largest: Array.isArray(check?.largest) ? check.largest : [],
      services: Array.isArray(check?.services) ? check.services : [],
    }))
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));

  const bad = checks.filter((c) => c.status === "fail" || c.status === "warn").length;
  const unknown = checks.filter((c) => c.status === "unknown").length;
  const [label, tone] = status === "ok" ? ["Healthy", "status-good"]
    : status === "fail" ? [`${bad} failing`, "status-bad"]
      : status === "warn" ? [`${bad} warning`, "status-warn"]
        // "Degraded" here means only that a check could not be run. Saying
        // "unhealthy" would be a wrong answer, and this panel is worth having
        // only if every answer on it is one the founder can trust.
        : [`${unknown} not checked`, ""];

  return shell(label, tone, `
    ${renderWarnings(Array.isArray(source.warnings) ? source.warnings : [], esc)}
    <ul class="readiness-list">${checks.map((check) => renderCheck(check, esc)).join("")}</ul>`);
}

function renderCheck(check, esc) {
  return `<li class="readiness-row readiness-row--${esc(check.status)}">
    <div class="readiness-head">
      <strong>${esc(check.name)}</strong>
      <em class="objective-status ${TONE[check.status] || ""}">${esc(check.status)}</em>
    </div>
    ${check.detail ? `<p class="readiness-detail">${esc(check.detail)}</p>` : ""}
    ${renderStores(check, esc)}
    ${renderServices(check, esc)}
  </li>`;
}

// The biggest stores, because "the disk is filling" and "this one task is why"
// are different facts, and only the second one can be acted on.
function renderStores(check, esc) {
  if (check.key !== "stateStores" || !check.largest.length) return "";
  return `<ul class="readiness-sublist">${check.largest.map((entry) => `<li>
    <span class="readiness-sub-name">${esc(taskName(entry.task))}</span>
    <span class="readiness-sub-value">${esc(entry.size || "")}</span>
    <span class="mono-id">${esc(entry.task || "")}</span>
  </li>`).join("")}</ul>`;
}

function renderServices(check, esc) {
  if (check.key !== "services" || !check.services.length) return "";
  return `<ul class="readiness-sublist">${check.services.map((service) => `<li>
    <span class="readiness-sub-name">${esc(service.name || "")}</span>
    <span class="readiness-sub-value${service.state === "online" ? "" : " status-bad"}">${esc(service.state || "unknown")}</span>
    ${Number.isFinite(service.restarts) ? `<span class="mono-id">${esc(String(service.restarts))} restart${service.restarts === 1 ? "" : "s"}</span>` : ""}
  </li>`).join("")}</ul>`;
}

// The store path is `<project>/tasks/<taskId>`. Lead with the task, which is
// the part a founder recognises; the full path stays beside it for copying.
function taskName(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || String(path || "");
}

function renderWarnings(warnings, esc) {
  if (!warnings.length) return "";
  return `<p class="operations-warning" role="status">${esc(warnings[0])}${
    warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ""}</p>`;
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section readiness-panel" aria-labelledby="factory-readiness-title">
    <div class="section-heading">
      <div><span class="eyebrow">Machine</span><h2 id="factory-readiness-title">System readiness</h2></div>
      <span class="objective-status ${statusTone}">${statusLabel}</span>
    </div>
    ${body}
  </section>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
