// Founder-facing rendering for the report engine's daily JSON snapshots.
// Values, directions, targets, and series are rendered as supplied; metric
// calculation remains exclusively on the server-side report engine.

const GROUPS = [
  ["objectives-complete", "Objectives complete"],
  ["dispatches-per-merged-task", "Dispatches per merged task"],
  ["no-verdict", "No-verdict counts"],
  ["founder-interruptions", "Founder interruptions"],
  ["cycle-time", "Cycle time by stage"],
  ["wall-time-per-objective", "Wall time per objective"],
];

export function factoryHealthPanel(source, { esc = escapeHtml } = {}) {
  if (!source || source.available === false) {
    const reason = typeof source?.reason === "string" && source.reason.trim() ? `<p>${esc(source.reason)}</p>` : "";
    return shell("Awaiting history", "", `<div class="quiet-state"><strong>Factory health data is not available yet.</strong>${reason}</div>`);
  }

  const metrics = Array.isArray(source.metrics) ? source.metrics : [];
  if (!metrics.length) {
    return shell("No metrics", "", `<div class="quiet-state">Factory health data is not available yet.</div>`);
  }

  const buckets = new Map();
  for (const metric of metrics) {
    const group = typeof metric?.group === "string" && metric.group.trim() ? metric.group : "other";
    if (!buckets.has(group)) buckets.set(group, []);
    buckets.get(group).push(metric);
  }

  const known = new Map(GROUPS);
  const order = [
    ...GROUPS.map(([id]) => id).filter((id) => buckets.has(id)),
    ...[...buckets.keys()].filter((id) => !known.has(id)),
  ];
  return shell("14-day trend", "status-good", `
    <p class="factory-health-lede">Current values and campaign targets with the latest 14 days of report snapshots.</p>
    <div class="factory-health-groups">
      ${order.map((group) => renderGroup(group, known.get(group) || labelCase(group), buckets.get(group), esc)).join("")}
    </div>
  `);
}

function renderGroup(id, title, metrics, esc) {
  return `<section class="factory-health-group" aria-labelledby="factory-health-${safeToken(id)}">
    <h3 id="factory-health-${safeToken(id)}">${esc(title)}</h3>
    <div class="factory-health-metrics">${metrics.map((metric) => renderMetric(metric, esc)).join("")}</div>
  </section>`;
}

function renderMetric(metric, esc) {
  const unavailable = typeof metric?.value !== "number" || !Number.isFinite(metric.value);
  const reason = typeof metric?.reason === "string" && metric.reason.trim() ? metric.reason.trim() : "no reason given";
  const label = typeof metric?.label === "string" && metric.label.trim() ? metric.label : metric?.id || "Metric";
  const sourcePaths = Array.isArray(metric?.sourcePath) ? metric.sourcePath.filter((path) => typeof path === "string" && path) : [];
  const direction = typeof metric?.direction === "string" && metric.direction.trim() ? metric.direction.trim() : "—";

  return `<article class="factory-health-metric${unavailable ? " is-unavailable" : ""}">
    <div class="factory-health-metric-head">
      <div><strong>${esc(label)}</strong><span>${esc(metric?.id || "")}</span></div>
      <span class="factory-health-direction direction-${safeToken(direction)}" aria-label="Direction: ${esc(direction)}">${directionMark(direction)} ${esc(direction)}</span>
    </div>
    ${unavailable
      ? `<div class="factory-health-null"><b>—</b><span>${esc(reason)}</span></div>`
      : `<div class="factory-health-reading"><b>${esc(formatValue(metric.value, metric.unit))}</b>${sparkline(metric.series, label, esc)}</div>`}
    <dl class="factory-health-facts">
      <div><dt>Campaign target</dt><dd>${typeof metric?.target !== "number" || !Number.isFinite(metric.target) ? "—" : esc(formatValue(metric.target, metric.unit))}</dd></div>
      <div><dt>Direction</dt><dd>${esc(direction)}</dd></div>
    </dl>
    <p class="factory-health-source">Source: ${sourcePaths.length ? sourcePaths.map((path) => `<code>${esc(path)}</code>`).join(", ") : "not provided"}</p>
  </article>`;
}

function sparkline(series, label, esc) {
  const points = Array.isArray(series) ? series.slice(-14) : [];
  const usable = points
    .map((point, index) => ({ index, value: point?.value }))
    .filter((point) => typeof point.value === "number" && Number.isFinite(point.value));
  if (!usable.length) return `<span class="factory-health-no-trend">No trend data</span>`;

  const width = 180;
  const height = 44;
  const inset = 3;
  const min = Math.min(...usable.map((point) => point.value));
  const max = Math.max(...usable.map((point) => point.value));
  const range = max - min;
  const x = (index) => points.length === 1 ? width / 2 : inset + index * (width - inset * 2) / (points.length - 1);
  const y = (value) => range === 0 ? height / 2 : inset + (max - value) * (height - inset * 2) / range;
  const runs = [];
  let run = [];
  for (let index = 0; index < points.length; index += 1) {
    const value = points[index]?.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    run.push(`${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  }
  if (run.length) runs.push(run);
  const marks = runs.map((coords) => coords.length === 1
    ? `<circle cx="${coords[0].split(",")[0]}" cy="${coords[0].split(",")[1]}" r="2.5"></circle>`
    : `<polyline points="${coords.join(" ")}"></polyline>`).join("");
  const gaps = points.length - usable.length;
  const description = `${label}: ${usable.length} reported day${usable.length === 1 ? "" : "s"}${gaps ? `, ${gaps} gap${gaps === 1 ? "" : "s"}` : ""}`;
  return `<svg class="factory-health-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(description)}">${marks}</svg>`;
}

function formatValue(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (unit === "fraction") return `${Math.round(number * 100)}%`;
  if (unit === "count" || unit === "ratio") return String(Math.round(number));
  if (unit === "ms") return duration(number);
  return String(value);
}

function duration(ms) {
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.round(ms)}ms`;
}

function directionMark(direction) {
  if (direction === "up") return "↑";
  if (direction === "down") return "↓";
  if (direction === "flat") return "→";
  return "";
}

function labelCase(value) {
  return String(value || "other").replace(/[-_.]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeToken(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section factory-health-panel" aria-labelledby="factory-health-title">
    <div class="section-heading"><div><span class="eyebrow">Factory health</span><h2 id="factory-health-title">Is the factory getting better?</h2></div><span class="objective-status ${statusTone}">${statusLabel}</span></div>
    ${body}
  </section>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
