// Founder-facing budget visibility.
//
// Alert-only, and the panel says so out loud. Nothing here can pause an agent,
// cancel work, or override an approval — crossing a limit is information, and
// a hard stop is a separate founder decision (PAPERCLIP_BUDGET_ALERTS.md).

const STATUS = {
  ok: ["Within budget", "status-good"],
  warning: ["Approaching limit", "status-warn"],
  exceeded: ["Over budget", "status-bad"],
  unavailable: ["Cannot be priced", "status-warn"],
};

export function budgetPanel(source, { esc = escapeHtml } = {}) {
  if (!source) return shell("Unavailable", "status-warn", `<div class="quiet-state">Budget data is not available yet.</div>`);
  if (!source.configured) {
    return shell("Not configured", "", `<div class="quiet-state">No budget policies are set. Add them to <code>factory/budgets.json</code> and open a pull request.</div>`);
  }

  const summary = source.summary || {};
  const alerts = Array.isArray(source.alerts) ? source.alerts : [];
  const pricing = source.pricing || {};
  // Worst state wins the header: a single exceeded policy must not be averaged
  // away by two healthy ones.
  const worst = summary.exceeded ? "exceeded" : summary.warning ? "warning" : summary.unavailable ? "unavailable" : "ok";
  const [label, tone] = STATUS[worst];

  return shell(label, tone, `
    ${source.available === false ? `<p class="operations-warning" role="status">Some cost data could not be read, so these totals are incomplete.</p>` : ""}
    <div class="budget-list">${alerts.map((alert) => renderAlert(alert, esc)).join("") || `<div class="quiet-state">No policies evaluated.</div>`}</div>
    <p class="operations-cost">${describePricing(pricing, esc)}</p>
    <p class="budget-enforcement">Alert-only: crossing a limit reports it and stops nothing.</p>
  `);
}

function renderAlert(alert, esc) {
  const [label, tone] = STATUS[alert.status] || STATUS.unavailable;
  const percent = Math.max(0, Math.min(100, Number(alert.percent) || 0));
  return `<div class="budget-row">
    <div><strong>${esc(alert.scopeId)}</strong><span>${esc(alert.scopeType)} · ${esc(alert.window)}</span></div>
    <div class="objective-progress" role="img" aria-label="${esc(`${percent} percent of the ${alert.scopeId} budget used`)}"><span class="budget-fill-${esc(alert.status)}" style="width:${percent}%"></span></div>
    <em class="${tone}">${esc(label)} · ${formatUsd(alert.observedMicros)} of ${formatUsd(alert.limitMicros)}</em>
  </div>`;
}

// Say where the number came from. A derived price is HQ applying its own
// pricing table, not something a provider billed, and the founder should be
// able to tell those apart at a glance.
function describePricing(pricing, esc) {
  const parts = [];
  if (pricing.providerReportedPrices) parts.push(`${number(pricing.providerReportedPrices)} provider-reported`);
  if (pricing.derivedPrices) parts.push(`${number(pricing.derivedPrices)} priced from factory/pricing.json${pricing.version ? ` (${esc(pricing.version)})` : ""}`);
  if (pricing.unpricedEvents) parts.push(`<strong class="status-warn">${number(pricing.unpricedEvents)} with no price at all</strong>`);
  return parts.length ? parts.join(" · ") : "No usage recorded yet.";
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section budget-panel" aria-labelledby="factory-budgets-title">
    <div class="section-heading"><div><span class="eyebrow">Spend</span><h2 id="factory-budgets-title">Budgets</h2></div><span class="objective-status ${statusTone}">${statusLabel}</span></div>
    ${body}
  </section>`;
}

function formatUsd(micros) {
  const usd = (Number(micros) || 0) / 1_000_000;
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
