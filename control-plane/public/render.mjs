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
//
// THREE DIFFERENT THINGS, AND THEY WERE CONFLATED.
//
// The published contract already distinguishes them; this helper did not, and
// read the wrong field:
//
//   `unavailable: true`   the builder THREW. `gather()` in publisher.mjs
//                         replaces the panel with this marker, so there is no
//                         data at all. This is genuine absence.
//   `configured: false`   the founder has not set this up — no budget
//                         policies, no goals registered. Also nothing to show,
//                         and "not configured" is the true thing to say.
//   `available: false`    the builder SUCCEEDED and recorded a warning. Ten
//                         builders set it as `warnings.length === 0`, so it
//                         means "something was noted", never "there is no
//                         data" — DATA IS PRESENT, right there beside it.
//
// Treating the third as absence blanked working panels. The worst case was the
// Board: `buildOperationsSnapshot` pushes a warning when the COST LEDGER is
// unreadable and sets `available` from `warnings.length`, and the Board does
// `unavailable(panels.operations) ? [] : …` — so an unreadable cost ledger
// rendered an empty board, captioned "not configured", while 21 tasks were
// running. That is the failure the founder already lived through once, from a
// different cause.
//
// So absence is decided by the two fields that mean absence. Degradation is a
// separate question, answered by `degraded()` below, and a panel that has data
// renders it with the warning beside it.
export function unavailable(panel) {
  if (!panel || typeof panel !== "object") return "no data published";
  if (panel.unavailable) return text(panel.reason, "unavailable on the machine");
  if (panel.configured === false) return text(panel.reason, "not configured");
  return null;
}

/**
 * Did this panel build with warnings? Returns a sentence, or null.
 *
 * Every caller that renders a panel's data should render this beside it. It is
 * deliberately NOT part of `unavailable()`: the whole defect was one question
 * ("can I show this?") being answered by a field that meant something else
 * ("was anything noted?").
 */
export function degraded(panel) {
  if (!panel || typeof panel !== "object") return null;
  if (panel.unavailable || panel.available !== false) return null;
  const warnings = list(panel.warnings).map((w) => text(w, "")).filter(Boolean);
  if (!warnings.length) return "Some of this could not be read, so it may be incomplete.";
  return `Some of this could not be read, so it may be incomplete: ${warnings[0]}`
    + (warnings.length > 1 ? ` (+${warnings.length - 1} more)` : "");
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

  // `available: false` on this panel means no budget POLICY is configured — it
  // does not mean there is no spend. Treating the two as the same hid a real
  // ledger behind "not configured" while the header showed $0.08 from the very
  // same numbers. Only an absent totals object means there is nothing to show.
  const totals = budgets?.totals;
  if (!totals || typeof totals !== "object" || Array.isArray(totals)) {
    return { title: "Spend", note: unavailable(budgets) || "no spend recorded", rows: [] };
  }

  const t = totals;
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

  const note = budgets?.configured === false
    ? "no budget policy configured — these are recorded totals"
    : budgets?.enforcement ? `enforcement: ${text(budgets.enforcement)}` : null;
  return { title: "Spend", note, rows };
}

export function goalsPanel(panels) {
  const goals = panels?.goals;
  const reason = unavailable(goals);
  if (reason) return { title: "Goals", note: reason, rows: [] };

  // Progress lives under `progress`, not on the goal itself. Reading
  // `goal.percent` gave `num(undefined)` — 0 — so every goal in this fold
  // reported 0% regardless of its real state.
  const rows = list(goals.goals).map((goal) => {
    const percent = num(goal.progress?.percent);
    const state = text(goal.progress?.state, "");
    return {
      primary: text(goal.title || goal.name, "goal"),
      secondary: text(goal.projectId || goal.project || goal.parent, ""),
      meta: `${percent}%`,
      tone: state === "blocked" ? "bad" : percent >= 100 || state === "complete" ? "good" : "muted",
    };
  });

  return { title: "Goals", note: rows.length ? null : "no goals configured", rows };
}

const RENDERERS = {
  company: [activityPanel, projectsPanel, attentionPanel, agentsPanel],
  operations: [tasksPanel, operationsPanel],
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
    // Why the factory is stuck, and what it would do. Both are already computed
    // and were being dropped — a question with no context forces the founder to
    // open the local dashboard to answer it, which defeats the point of a
    // control plane they can reach from anywhere.
    why: text(decision?.why, ""),
    recommendation: text(decision?.recommendation, ""),
    project: text(decision?.project, ""),
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

// --- what the factory is actually doing --------------------------------------

/**
 * Relative time, for a feed where "when" is most of the meaning.
 *
 * Shares `freshness`'s refusal to guess: a value that is not a parseable
 * timestamp says so rather than rendering as "now".
 */
export function ago(at, now = Date.now()) {
  if (typeof at !== "string") return "unknown";
  const then = Date.parse(at);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

// A task id carries its objective, which carries the founder's whole prompt.
// Rendering that raw fills the panel with one wall of text, so the readable
// part is the node name — the segment after the objective hash.
export function shortTaskId(taskId) {
  const id = text(taskId, "");
  const match = /^obj-[0-9a-f]+-(.+)$/.exec(id);
  return match ? match[1].replace(/-/g, " ") : id;
}

// Phrasing taken from the event types this factory actually emits, read off a
// live feed rather than guessed. An unmapped type still renders — as its own
// name — because a new event type appearing is information, not a reason to
// drop the row.
const EVENT_VERBS = {
  "dispatch-ready": "is queued for",
  "dispatch-running": "is running",
  "dispatch-completed": "finished",
  "dispatch-failed": "failed on",
  "recovery-verifying": "is verifying",
  "recovery-repair-attempted": "attempted a repair on",
  "recovery-escalated": "escalated",
  "pr-merged": "merged the PR for",
  "pr-opened": "opened a PR for",
  "task-created": "created",
  "task-blocked": "blocked on",
  "stage-completed": "completed",
  "stage-failed": "failed",
  "deferred-decision-recorded": "recorded your decision on",
};

/**
 * The live feed: which agent is doing what, right now and recently.
 *
 * This is the panel that answers "what are the agents doing", and it is built
 * from the events the factory already records rather than from agent status
 * flags — a flag says "working", an event says what it is working ON.
 */
export function activityPanel(panels) {
  const company = panels?.company;
  const reason = unavailable(company);
  if (reason) return { title: "What the factory is doing", note: reason, rows: [] };

  const events = list(company.activityFeed).slice(0, 14);

  const rows = events.map((event) => {
    const who = text(event?.actor, text(event?.stage, "the factory"));
    const verb = EVENT_VERBS[event?.type] || text(event?.type, "acted");
    const what = shortTaskId(event?.taskId);
    const stage = text(event?.stage, "");
    const failed = /fail|block/i.test(String(event?.type || "")) || event?.outcome === "fail";

    return {
      primary: `${who} ${verb}${what ? ` ${what}` : ""}`,
      secondary: [text(event?.project, ""), stage && stage !== who ? `stage: ${stage}` : ""]
        .filter(Boolean)
        .join("  ·  "),
      meta: ago(event?.at),
      tone: failed ? "bad" : event?.type === "dispatch-running" ? "good" : "muted",
    };
  });

  return {
    title: "What the factory is doing",
    note: rows.length ? null : "no activity recorded yet",
    rows,
  };
}

const TASK_TONE = { active: "good", blocked: "bad", failed: "bad", "merge-ready": "warn", merged: "muted" };

/**
 * Every task the factory is carrying, most recently touched first.
 *
 * Sorted by activity rather than by name: the founder's question is "what is
 * moving", and a list ordered alphabetically answers a question nobody asked.
 * Finished work sinks below live work for the same reason.
 */
export function tasksPanel(panels) {
  const operations = panels?.operations;
  const reason = unavailable(operations);
  if (reason) return { title: "Tasks", note: reason, rows: [] };

  const tasks = list(operations.tasks).slice();
  const rank = (task) => (task?.status === "active" ? 0 : task?.status === "blocked" ? 1 : 2);
  tasks.sort((a, b) => rank(a) - rank(b) || String(b?.updatedAt || "").localeCompare(String(a?.updatedAt || "")));

  const rows = tasks.slice(0, 20).map((task) => ({
    primary: shortTaskId(task?.taskId),
    secondary: [
      task?.stage ? `stage: ${text(task.stage)}` : "",
      task?.actor ? `actor: ${text(task.actor)}` : "",
      task?.lease ? "leased" : "",
    ].filter(Boolean).join("  ·  "),
    meta: `${text(task?.status, "unknown")} · ${ago(task?.updatedAt)}`,
    tone: TASK_TONE[task?.status] || "muted",
  }));

  const hidden = Math.max(0, tasks.length - rows.length);
  return {
    title: "Tasks",
    note: rows.length ? (hidden ? `${hidden} more not shown` : null) : "no tasks",
    rows,
  };
}
