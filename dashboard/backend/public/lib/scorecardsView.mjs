// Agent reliability, by outcome.
//
// The panel is built to be hard to misread. Every rate carries its sample size,
// a low-confidence card says so instead of showing a number that invites a
// decision, and cost appears only per accepted outcome — never as a total to
// minimise, because the cheapest agent is the one that gives up first.

const CONFIDENCE = { high: ["", "high confidence"], medium: ["", "medium confidence"], low: ["status-warn", "low confidence"] };

export function scorecardsPanel(source, { esc = escapeHtml } = {}) {
  if (!source) return shell("Unavailable", "status-warn", `<div class="quiet-state">Agent reliability data is not available yet.</div>`);

  const scorecards = Array.isArray(source.scorecards) ? source.scorecards : [];
  const summary = source.summary || {};
  if (!scorecards.length) {
    return shell("No outcomes yet", "", `<div class="quiet-state">No agent has produced a decided outcome yet.</div>`);
  }

  const degraded = source.available === false;
  return shell(`${number(summary.agents)} agents`, "", `
    ${degraded ? `<p class="operations-warning" role="status">Some task state could not be read, so these figures are incomplete.</p>` : ""}
    ${number(summary.missingCostData) ? `<p class="permission-blurb">${number(summary.missingCostData)} agent(s) have incomplete cost data — their cost per outcome is not comparable.</p>` : ""}
    <div class="scorecard-list">${scorecards.slice(0, 8).map((card) => renderCard(card, esc)).join("")}</div>
    <p class="decision-authority">Advisory only. Routing is set in <code>factory/factory.config.json</code>; nothing here changes it.</p>
  `);
}

function renderCard(card, esc) {
  const [tone, label] = CONFIDENCE[card.confidence] || CONFIDENCE.low;
  const outcomes = card.outcomes || {};
  const quality = card.quality || {};
  const cost = card.cost || {};
  // A rate from too few outcomes is not shown as a rate. Printing "100%" over
  // n=1 is the single easiest way to make this panel lie.
  const headline = card.confidence === "low" || outcomes.acceptanceRate === null
    ? `${number(outcomes.accepted)} accepted of ${number(card.sampleSize)}`
    : `${percent(outcomes.acceptanceRate)} accepted`;

  return `<div class="scorecard-row">
    <div>
      <strong>${esc(card.agentId)}</strong>
      <span>${esc(headline)} · n=${number(card.sampleSize)} · <em class="${tone}">${esc(label)}</em></span>
    </div>
    <dl class="scorecard-facts">
      ${fact("findings against", number(quality.findingsAgainst), quality.findingsAgainst ? "status-warn" : "")}
      ${quality.gateRuns ? fact("caught as gate", number(quality.gateFailuresRaised)) : ""}
      ${fact("retry rate", quality.retryRate === null ? "—" : percent(quality.retryRate), quality.retryRate > 0.5 ? "status-warn" : "")}
      ${fact("recoveries", number(quality.recoveries), quality.recoveries ? "status-warn" : "")}
      ${fact("median stage", card.latency?.medianMs == null ? "—" : duration(card.latency.medianMs))}
      ${fact("cost / accepted", cost.microsPerAcceptedOutcome == null ? (cost.complete === false ? "incomplete" : "—") : usd(cost.microsPerAcceptedOutcome), cost.complete === false ? "status-warn" : "")}
    </dl>
  </div>`;
}

function fact(label, value, tone = "") {
  return `<div><dt>${label}</dt><dd class="${tone}">${value}</dd></div>`;
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section scorecards-panel" aria-labelledby="factory-scorecards-title">
    <div class="section-heading"><div><span class="eyebrow">Reliability</span><h2 id="factory-scorecards-title">Agent scorecards</h2></div><span class="objective-status ${statusTone}">${statusLabel}</span></div>
    ${body}
  </section>`;
}

function percent(rate) {
  return `${Math.round((Number(rate) || 0) * 100)}%`;
}

function usd(micros) {
  const value = (Number(micros) || 0) / 1_000_000;
  if (value >= 1) return `$${value.toFixed(2)}`;
  // A real cost that rounds to $0.0000 must not read as free.
  // Worded, not "<$0.0001": this string is interpolated into markup, and a
  // formatter that emits a raw "<" is one refactor away from an injection.
  if (value > 0 && value < 0.0001) return "under $0.0001";
  return `$${value.toFixed(4)}`;
}

function duration(ms) {
  const value = Number(ms) || 0;
  if (value >= 3_600_000) return `${(value / 3_600_000).toFixed(1)}h`;
  if (value >= 60_000) return `${Math.round(value / 60_000)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}s`;
  return `${Math.round(value)}ms`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
