// Money: what the factory is costing, broken down the ways that are real.
//
// Everything here is already published twice over — `operations.costs` from
// `summarizeCostLedger`, which has already dropped reversals and superseded
// events, and `budgets` with its policies and pricing provenance. Nothing is
// re-derived in this view; a second implementation of "what did we spend" is
// how two screens come to disagree about one ledger.
//
// Three things this tab must never do, each of which would put a wrong number
// in front of the founder:
//
//   1. HIDE UNPRICED EVENTS. If any recorded event has no price, the total is
//      a FLOOR, and this page says so in words beside the number rather than
//      presenting a confident figure that is quietly too low.
//
//   2. SHOW A PER-TASK-PER-STAGE FIGURE. That bucket does not exist:
//      `publisher.mjs` passes `costByStage: {}` deliberately rather than
//      attributing one task's spend to another. `byStage` is factory-wide and
//      is labelled as such.
//
//   3. IMPLY THE SEATS ARE IN HERE. This is API spend. The ChatGPT, Claude and
//      Cursor subscriptions are not in the ledger, and a total that looked
//      like a monthly bill but was not would be the wrong number on the wrong
//      screen. One line says what the ledger covers.

import { degraded, list, money, num, text, unavailable } from "./render.mjs";

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = String(textContent);
  return node;
}

// The tunnel's own words, so the same state is named the same thing on both
// surfaces. See dashboard/backend/public/lib/budgetView.mjs.
const BUDGET_STATUS = {
  ok: ["Within budget", "ok"],
  warning: ["Approaching limit", "warn"],
  exceeded: ["Over budget", "fail"],
  unavailable: ["Cannot be priced", "warn"],
};

// ─── model ───────────────────────────────────────────────────────────────────

function breakdown(bucket, { limit = 12 } = {}) {
  return Object.entries(bucket || {})
    .map(([key, value]) => ({
      key,
      costMicros: num(value?.costMicros),
      events: num(value?.events),
      inputTokens: num(value?.inputTokens),
      outputTokens: num(value?.outputTokens),
      unpricedEvents: num(value?.unpricedEvents),
    }))
    // Biggest spend first; a tie breaks on name so the list does not reshuffle
    // between publishes.
    .sort((a, b) => b.costMicros - a.costMicros || a.key.localeCompare(b.key))
    .slice(0, limit);
}

export function moneyModel(snapshot) {
  const operations = snapshot?.panels?.operations;
  const budgets = snapshot?.panels?.budgets;
  const costsReason = unavailable(operations);
  const costs = costsReason ? null : operations.costs;

  if (!costs) {
    return { available: false, reason: costsReason || "No cost ledger has been published yet.", budgets: budgetModel(budgets) };
  }

  const totals = costs.totals || {};
  const unpriced = num(totals.unpricedEvents);
  return {
    available: true,
    incomplete: degraded(operations),
    totals: {
      costMicros: num(totals.costMicros),
      events: num(totals.events),
      inputTokens: num(totals.inputTokens),
      outputTokens: num(totals.outputTokens),
      unpricedEvents: unpriced,
      // The one thing that decides whether this page may state a total or
      // must state a floor.
      isFloor: unpriced > 0,
    },
    byProject: breakdown(costs.byProject),
    byProvider: breakdown(costs.byProvider),
    byModel: breakdown(costs.byModel),
    byAgent: breakdown(costs.byAgent),
    // Factory-wide only. `byTask` exists but carries no stage split, and
    // crossing the two would invent a number.
    byStage: breakdown(costs.byStage),
    budgets: budgetModel(budgets),
  };
}

export function budgetModel(panel) {
  // Asked before `unavailable()`, which would answer the same question with a
  // bare "not configured". Here there is something more useful to say, and the
  // founder can act on it.
  if (panel && typeof panel === "object" && !panel.unavailable && panel.configured === false) {
    return {
      available: false,
      reason: "No budget policies are set. Add them to factory/budgets.json.",
      alerts: [], pricing: panel.pricing || null,
    };
  }
  const reason = unavailable(panel);
  if (reason) return { available: false, reason, alerts: [], pricing: null };
  const summary = panel.summary || {};
  return {
    available: true,
    incomplete: degraded(panel),
    // Worst state wins: one exceeded policy must not be averaged away by two
    // healthy ones.
    worst: num(summary.exceeded) ? "exceeded" : num(summary.warning) ? "warning" : num(summary.unavailable) ? "unavailable" : "ok",
    enforcement: text(panel.enforcement, "alert-only"),
    pricing: panel.pricing || null,
    alerts: list(panel.alerts).map((alert) => ({
      scopeId: text(alert?.scopeId, "unknown"),
      scopeType: text(alert?.scopeType, ""),
      window: text(alert?.window, ""),
      status: text(alert?.status, "unavailable"),
      observedMicros: num(alert?.observedMicros),
      limitMicros: num(alert?.limitMicros),
      percent: Math.max(0, Math.min(100, num(alert?.percent))),
      unpricedEvents: num(alert?.unpricedEvents),
    })),
  };
}

// ─── render ──────────────────────────────────────────────────────────────────

export function renderMoney(root, snapshot) {
  root.replaceChildren();
  const model = moneyModel(snapshot);

  root.append(el("p", "view-lede", "What the factory is spending, and against which limits."));

  if (!model.available) {
    root.append(el("p", "home-calm home-calm--small", model.reason));
    if (model.budgets.available) root.append(budgets(model.budgets));
    return model;
  }

  root.append(headline(model.totals));
  if (model.incomplete) root.append(el("p", "money-warning", model.incomplete));
  root.append(ledgerScope());
  if (model.budgets.available || model.budgets.reason) root.append(budgets(model.budgets));

  root.append(group("By project", model.byProject, model.totals));
  root.append(group("By model", model.byModel, model.totals));
  root.append(group("By provider", model.byProvider, model.totals));
  root.append(group("By agent", model.byAgent, model.totals));
  root.append(group("By stage", model.byStage, model.totals, {
    // Said on screen, because a founder looking at a task could otherwise read
    // this as that task's stage costs.
    note: "Across the whole factory, not per task — the ledger records no per-task stage split.",
  }));
  return model;
}

function headline(totals) {
  const box = el("section", `money-headline${totals.isFloor ? " money-headline--floor" : ""}`);
  box.append(el("span", "money-eyebrow", totals.isFloor ? "Spend so far — at least" : "Spend so far"));
  box.append(el("strong", "money-total", money(totals.costMicros)));
  box.append(el("p", "home-meta",
    `across ${totals.events} recorded run${totals.events === 1 ? "" : "s"}`
    + ` · ${compactTokens(totals.inputTokens)} in, ${compactTokens(totals.outputTokens)} out`));
  if (totals.isFloor) {
    // In words, beside the number — never a footnote, never an asterisk.
    box.append(el("p", "money-floor",
      `${totals.unpricedEvents} run${totals.unpricedEvents === 1 ? " has" : "s have"} no price yet, `
      + "so the real figure is higher than this. Treat it as a floor, not a total."));
  }
  return box;
}

// What this ledger is, and — just as importantly — what it is not.
function ledgerScope() {
  return el("p", "money-scope",
    "This is API spend the factory recorded, run by run. It does not include your ChatGPT, "
    + "Claude or Cursor subscriptions, so it is not your monthly bill.");
}

function budgets(model) {
  const section = el("section", "money-budgets");
  section.append(el("h2", "home-heading", "Budgets"));

  if (!model.available) {
    section.append(el("p", "home-meta home-meta--dim", model.reason));
    if (model.pricing) section.append(pricingLine(model.pricing));
    return section;
  }

  const [label] = BUDGET_STATUS[model.worst] || BUDGET_STATUS.unavailable;
  section.append(el("p", "home-meta home-meta--dim", label));
  if (model.incomplete) section.append(el("p", "money-warning", model.incomplete));

  const rows = el("ul", "money-budget-list");
  for (const alert of model.alerts) {
    const [statusLabel, tone] = BUDGET_STATUS[alert.status] || BUDGET_STATUS.unavailable;
    const row = el("li", `money-budget money-budget--${tone}`);
    // The scope leads by name; its type is the muted qualifier.
    const head = el("div", "money-budget-head");
    head.append(el("strong", null, alert.scopeId));
    head.append(el("span", "home-meta", `${alert.scopeType} · ${alert.window}`));
    row.append(head);

    const bar = el("div", "money-bar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${alert.percent}% of the ${alert.scopeId} budget used`);
    const fill = el("span", `money-bar-fill money-bar-fill--${tone}`);
    fill.style.width = `${alert.percent}%`;
    bar.append(fill);
    row.append(bar);

    row.append(el("p", "money-budget-meta",
      `${statusLabel} · ${money(alert.observedMicros)} of ${money(alert.limitMicros)}`
      + (alert.unpricedEvents ? ` · ${alert.unpricedEvents} unpriced, so this is a floor` : "")));
    rows.append(row);
  }
  section.append(rows);

  if (model.pricing) section.append(pricingLine(model.pricing));
  // Alert-only, said out loud: nothing here pauses an agent or cancels work.
  section.append(el("p", "money-enforcement",
    model.enforcement === "alert-only"
      ? "Alert-only: crossing a limit reports it and stops nothing."
      : `Enforcement: ${model.enforcement}.`));
  return section;
}

// Where the numbers came from. A derived price is HQ applying its own table,
// not something a provider billed, and those must be tellable apart.
function pricingLine(pricing) {
  const parts = [];
  if (num(pricing.providerReportedPrices)) parts.push(`${num(pricing.providerReportedPrices)} provider-reported`);
  if (num(pricing.derivedPrices)) {
    parts.push(`${num(pricing.derivedPrices)} priced from factory/pricing.json${pricing.version ? ` (${pricing.version})` : ""}`);
  }
  if (num(pricing.unpricedEvents)) parts.push(`${num(pricing.unpricedEvents)} with no price at all`);
  return el("p", "home-meta home-meta--dim", parts.length ? parts.join(" · ") : "No usage recorded yet.");
}

function group(title, rows, totals, { note = null } = {}) {
  const section = el("section", "money-group");
  section.append(el("h2", "home-heading", title));
  if (note) section.append(el("p", "home-meta home-meta--dim", note));

  if (!rows.length) {
    section.append(el("p", "home-meta home-meta--dim", "Nothing recorded yet."));
    return section;
  }

  const listEl = el("ul", "money-list");
  for (const row of rows) {
    const item = el("li", "money-row");
    const head = el("div", "money-row-head");
    head.append(el("span", "money-row-name", row.key));
    head.append(el("span", "money-row-cost", money(row.costMicros)));
    item.append(head);

    // A share bar is only honest against a total that is itself complete
    // enough to divide by. With everything unpriced there is nothing to
    // take a share OF.
    if (totals.costMicros > 0) {
      const bar = el("div", "money-bar money-bar--slim");
      const fill = el("span", "money-bar-fill money-bar-fill--share");
      fill.style.width = `${Math.min(100, (row.costMicros / totals.costMicros) * 100)}%`;
      bar.append(fill);
      item.append(bar);
    }

    item.append(el("p", "money-row-meta",
      `${row.events} run${row.events === 1 ? "" : "s"}`
      + ` · ${compactTokens(row.inputTokens)} in, ${compactTokens(row.outputTokens)} out`
      + (row.unpricedEvents ? ` · ${row.unpricedEvents} unpriced, so this is a floor` : "")));
    listEl.append(item);
  }
  section.append(listEl);
  return section;
}

function compactTokens(n) {
  const value = num(n);
  if (value < 1000) return `${value} tok`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k tok`;
  return `${(value / 1_000_000).toFixed(1)}M tok`;
}
