// Turning an hq.mirror/1 snapshot into a page.
//
// Two rules shape everything here, and both come from what this view IS: a
// mirror of a machine it cannot reach.
//
//   1. NEVER THROW ON DATA. The snapshot is produced by a publisher that walks
//      the whole projection stripping secrets and truncating long fields, so a
//      panel can legitimately arrive half-shaped. A renderer that throws on one
//      missing key blanks the entire page and tells the founder nothing, which
//      is worse than a panel saying it has nothing to show.
//
//   2. NEVER INVENT FRESHNESS. Everything here is as old as `publishedAt`. A
//      number rendered without that context reads as live, and a founder acting
//      on a stale cost total or an already-answered decision is the specific
//      harm this whole design has to avoid.
//
// Panels the renderer does not know are not dropped. An unknown panel means the
// machine is publishing something newer than this deployment understands, and
// silently omitting it would hide exactly the thing someone just added.

export const KNOWN_PANELS = ["company", "goals", "decisions", "operations", "deployments", "scorecards", "budgets"];

// --- small helpers, all total ------------------------------------------------

export function num(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function text(value, fallback = "—") {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s === "" ? fallback : s;
}

export function list(value) {
  return Array.isArray(value) ? value : [];
}

// Costs arrive in micros because integers do not drift. Presenting them needs
// the unit stated: "$0.01" and "0.01" are read very differently on a cost line.
export function money(micros) {
  const value = num(micros) / 1_000_000;
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

export function compact(n) {
  const value = num(n);
  if (Math.abs(value) < 1000) return String(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/**
 * How old the snapshot is, and whether that is worth warning about.
 *
 * The thresholds are deliberately generous relative to a 30s publish interval:
 * one missed publish is not news, several in a row is.
 */
export function freshness(publishedAt, now = Date.now()) {
  const unknownAge = { label: "age unknown", stale: true, unknown: true, seconds: null };

  // Only a string, and only one shaped like a timestamp. `Date.parse(12345)`
  // succeeds — it reads as the year 12345 — so a garbage value would land in
  // the future, clamp to zero seconds, and render as "0s ago". That is the
  // "looks live" failure this function exists to prevent, produced by the
  // function meant to prevent it.
  if (typeof publishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(publishedAt)) return unknownAge;

  const then = Date.parse(publishedAt);
  if (Number.isNaN(then)) return unknownAge;

  // A snapshot from the future is not fresh, it is wrong — a skewed clock on
  // the machine, or a value nobody should trust. Saying so beats showing
  // "0s ago" forever. One minute of tolerance absorbs ordinary clock drift.
  if (then > now + 60_000) return unknownAge;

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  const label =
    seconds < 90 ? `${seconds}s ago`
      : seconds < 5400 ? `${Math.round(seconds / 60)}m ago`
        : seconds < 172_800 ? `${Math.round(seconds / 3600)}h ago`
          : `${Math.round(seconds / 86_400)}d ago`;

  return { label, stale: seconds > 300, unknown: false, seconds };
}

// A panel that failed to build on the machine arrives as a marker rather than
// as absence, so the page can say which part is missing and why.
export function unavailable(panel) {
  if (!panel || typeof panel !== "object") return "no data published";
  if (panel.unavailable) return text(panel.reason, "unavailable on the machine");
  if (panel.available === false) return text(panel.reason || panel.state, "not configured");
  return null;
}

// --- the headline numbers ----------------------------------------------------

export function statsFrom(panels) {
  const company = panels?.company || {};
  const summary = company.summary || {};
  const agents = company.agents?.summary || {};
  const ops = panels?.operations?.summary || {};
  const budgets = panels?.budgets?.totals || {};

  const attention = num(summary.projectsNeedingAttention) + num(summary.openDecisions);

  return [
    { label: "Projects", value: compact(summary.projects), sub: `${compact(summary.activeProjects)} active` },
    { label: "Agents", value: compact(agents.total ?? summary.agents), sub: `${compact(agents.working)} working` },
    { label: "Needs you", value: compact(attention), sub: "decisions + at-risk", attention: attention > 0 },
    { label: "Spend", value: money(budgets.costMicros ?? ops.costMicros), sub: `${compact(budgets.events)} events` },
  ];
}

// --- panels ------------------------------------------------------------------
//
// Each returns { title, note, rows } where a row is { primary, secondary, meta,
// tone }. Keeping panels as data rather than as HTML is what makes them
// testable without a browser — these functions are the part that can be wrong.

export function projectsPanel(panels) {
  const company = panels?.company;
  const reason = unavailable(company);
  if (reason) return { title: "Projects", note: reason, rows: [] };

  const rows = list(company.projects).map((project) => ({
    primary: text(project.name, text(project.key, "untitled")),
    secondary: text(project.mission, "no mission recorded"),
    meta: text(project.status, "unknown"),
    tone: project.status === "active" ? "good" : project.status === "blocked" ? "bad" : "muted",
  }));

  return { title: "Projects", note: rows.length ? null : "no projects registered", rows };
}

export function attentionPanel(panels) {
  const company = panels?.company;
  const reason = unavailable(company);
  if (reason) return { title: "Needs your attention", note: reason, rows: [] };

  // Open decisions first: a question waiting on the founder outranks advice.
  const decisions = list(company.decisions).map((decision) => ({
    primary: text(decision.question || decision.summary || decision.title, "decision"),
    secondary: text(decision.why || decision.rationale, ""),
    meta: "decision",
    tone: "warn",
  }));

  const actions = list(company.recommendedActions)
    .slice()
    .sort((a, b) => num(a.priority, 99) - num(b.priority, 99))
    .slice(0, 6)
    .map((action) => ({
      primary: text(action.action, "action"),
      secondary: text(action.rationale, ""),
      meta: text(action.project, ""),
      tone: num(action.priority, 99) <= 2 ? "warn" : "muted",
    }));

  const rows = [...decisions, ...actions];
  return {
    title: "Needs your attention",
    note: rows.length ? null : "nothing waiting on you",
    rows,
  };
}

export function agentsPanel(panels) {
  const agents = panels?.company?.agents;
  const reason = unavailable(panels?.company);
  if (reason) return { title: "Agents", note: reason, rows: [] };

  const rows = list(agents?.agents).map((agent) => ({
    primary: text(agent.name, text(agent.id, "agent")),
    secondary: text(agent.role, ""),
    meta: text(agent.status || agent.registryStatus, "idle"),
    tone: agent.status === "working" ? "good" : agent.status === "blocked" ? "bad" : "muted",
  }));

  return { title: "Agents", note: rows.length ? null : "no agents registered", rows };
}

export function operationsPanel(panels) {
  const ops = panels?.operations;
  const reason = unavailable(ops);
  if (reason) return { title: "Operations", note: reason, rows: [] };

  const s = ops.summary || {};
  const entries = [
    ["Tasks", compact(s.tasks)],
    ["Active runs", compact(s.activeRuns)],
    ["Blocked runs", compact(s.blockedRuns)],
    ["Queued wakeups", compact(s.queuedWakeups)],
    ["Dead letters", compact(s.deadLetters)],
    ["Stalling tasks", compact(s.stallingTasks)],
  ];

  return {
    title: "Operations",
    note: null,
    rows: entries.map(([label, value]) => ({
      primary: label,
      secondary: "",
      meta: value,
      tone: value !== "0" && /blocked|dead|stalling/i.test(label) ? "bad" : "muted",
    })),
  };
}

export function deploymentsPanel(panels) {
  const deployments = panels?.deployments;
  const reason = unavailable(deployments);
  if (reason) return { title: "Deployments", note: reason, rows: [] };

  const rows = list(deployments.deployments).map((d) => ({
    primary: text(d.project || d.name, "project"),
    secondary: text(d.url || d.environment, ""),
    meta: text(d.status || d.state, "never deployed"),
    tone: /ready|success|deployed/i.test(String(d.status || d.state)) ? "good"
      : /fail|error/i.test(String(d.status || d.state)) ? "bad" : "muted",
  }));

  const s = deployments.summary || {};
  return {
    title: "Deployments",
    note: rows.length ? null : `${compact(s.neverDeployed)} project(s) never deployed`,
    rows,
  };
}

export function budgetsPanel(panels) {
  const budgets = panels?.budgets;
  const reason = unavailable(budgets);
  if (reason) return { title: "Spend", note: reason, rows: [] };

  const t = budgets.totals || {};
  const rows = [
    { primary: "Total cost", secondary: "", meta: money(t.costMicros), tone: "muted" },
    { primary: "Input tokens", secondary: "", meta: compact(t.inputTokens), tone: "muted" },
    { primary: "Output tokens", secondary: "", meta: compact(t.outputTokens), tone: "muted" },
    { primary: "Priced events", secondary: "", meta: compact(t.events), tone: "muted" },
  ];

  // An unpriced event is spend the totals do NOT include. Saying "$0.00" while
  // events went unpriced would understate the bill, so it is called out.
  const unpriced = num(t.unpricedEvents);
  if (unpriced > 0) {
    rows.push({
      primary: "Unpriced events",
      secondary: "not included in the total above",
      meta: compact(unpriced),
      tone: "warn",
    });
  }

  return { title: "Spend", note: budgets.enforcement ? `enforcement: ${text(budgets.enforcement)}` : null, rows };
}

export function goalsPanel(panels) {
  const goals = panels?.goals;
  const reason = unavailable(goals);
  if (reason) return { title: "Goals", note: reason, rows: [] };

  const rows = list(goals.goals).map((goal) => ({
    primary: text(goal.title || goal.name, "goal"),
    secondary: text(goal.project || goal.parent, ""),
    meta: `${num(goal.percent)}%`,
    tone: goal.blocked ? "bad" : num(goal.percent) >= 100 ? "good" : "muted",
  }));

  return { title: "Goals", note: rows.length ? null : "no goals configured", rows };
}

const RENDERERS = {
  company: [projectsPanel, attentionPanel, agentsPanel],
  operations: [operationsPanel],
  deployments: [deploymentsPanel],
  budgets: [budgetsPanel],
  goals: [goalsPanel],
};

/**
 * Every panel this page will draw, in order.
 *
 * A panel the machine published that this deployment has no renderer for is
 * reported rather than dropped — the founder should learn that the mirror
 * carries something this view is too old to show, not silently see less.
 */
export function panelsFor(snapshot) {
  const panels = snapshot?.panels || {};
  const out = [];

  for (const [name, renderers] of Object.entries(RENDERERS)) {
    if (!(name in panels)) continue;
    for (const render of renderers) {
      try {
        out.push(render(panels));
      } catch (error) {
        // Rule 1. One panel's bug costs that panel only.
        out.push({ title: name, note: `could not be rendered: ${String(error?.message || error).slice(0, 120)}`, rows: [] });
      }
    }
  }

  for (const name of Object.keys(panels)) {
    if (name in RENDERERS) continue;
    if (name === "decisions" || name === "scorecards") continue; // folded into the panels above
    out.push({
      title: name,
      note: "published by the factory, but this view does not know how to show it yet",
      rows: [],
      unknown: true,
    });
  }

  return out;
}

// --- founder intents ---------------------------------------------------------

function describeArgs(args) {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 80)}`)
    .join("  ");
}

/**
 * What the founder has asked for, and what became of it.
 *
 * Queued is shown separately from finished because that distinction is the
 * honest part of this design: an intent is ACCEPTED here and EXECUTED on the
 * machine, up to one poll interval later. A page that showed a queued action as
 * done would invent exactly the certainty an outbound-only topology gives up.
 */
export function intentsPanel(queue) {
  const pending = list(queue?.pending);
  const results = list(queue?.results);

  const rows = [
    ...pending.map((intent) => ({
      primary: text(intent?.kind, "intent"),
      secondary: describeArgs(intent?.args),
      meta: "queued",
      tone: "warn",
    })),
    ...results.slice(0, 8).map((result) => ({
      primary: text(result?.id, "intent"),
      secondary: text(result?.detail, ""),
      meta: text(result?.status, "done"),
      tone: result?.status === "done" ? "good" : "bad",
    })),
  ];

  return {
    title: "Your requests",
    note: rows.length ? null : "nothing requested from here yet",
    rows,
  };
}

/**
 * The actions offered on one decision.
 *
 * Options come from the decision itself, so the page never offers a choice the
 * factory did not. A decision with no recorded options gets a free-text reply
 * rather than an invented menu.
 */
export function decisionActions(decision) {
  const options = list(decision?.options).map((option) => String(option)).filter(Boolean);
  return {
    id: text(decision?.id, ""),
    question: text(decision?.question || decision?.summary, "decision"),
    options,
    freeText: options.length === 0,
  };
}

/** Decisions the founder can answer from here, with their ids intact. */
export function answerableDecisions(panels) {
  if (unavailable(panels?.company)) return [];
  return list(panels.company.decisions)
    .map(decisionActions)
    .filter((decision) => decision.id !== "");
}
