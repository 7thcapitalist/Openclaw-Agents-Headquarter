// Next: what the factory thinks is worth doing, and where the company is going.
//
// `buildWorkProposals` has been published all along, and the console already
// rendered it — read-only, at the bottom of Deliveries, with a card saying
// "starting work from the console is not wired yet". That was true and honest
// until Launch existed. It is now false, so the suggestion becomes something
// the founder can act on.
//
// THE PROPOSER PROPOSES, THE FOUNDER DISPOSES. This is not a nicety. The local
// dashboard deliberately has no write route for proposals — see the comment
// above `GET /api/hq/proposals` in dashboard/backend/server.mjs — precisely so
// that a ranking can never become an instruction. Accepting therefore offers
// two EXPLICIT choices, "start it now" and "add it to tonight", and there is
// no path anywhere on this screen that starts work without the founder saying
// which and then confirming it.
//
// The confirmation is imported from launch.mjs rather than written again. A
// second one beside it is how the two screens would come to warn about
// spending in different words, and the wording is the safeguard.

import { list, num, text } from "./render.mjs";
import { intentStatus } from "./home.mjs";
import { outcomeConfirmation } from "./launch.mjs";

/**
 * Is this panel missing, or merely incomplete?
 *
 * `goals` and `proposals` both set `available: warnings.length === 0`, so
 * `available: false` means "something was noted", NOT "there is no data". The
 * shared `unavailable()` helper reads it as "not configured", which throws
 * away a goal tree the founder has and renders it as though goals were never
 * registered. Only an absent or explicitly `unavailable` panel is missing.
 */
function missing(panel) {
  if (!panel || typeof panel !== "object") return "no data published";
  if (panel.unavailable) return text(panel.reason, "unavailable on the machine");
  return null;
}

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = String(textContent);
  return node;
}

// goalsView.mjs's STATE_LABEL, state for state and word for word, so a goal in
// the same state is named the same thing on both surfaces.
//
// Copying it rather than inventing labels is not pedantry: the first cut of
// this tab knew four states, so `pending` fell through to the unavailable
// default and a goal reading "50% · 3/6" was captioned "No linked work".
const GOAL_STATE = {
  completed: ["Complete", "ok"],
  active: ["In progress", "ok"],
  blocked: ["Blocked", "warn"],
  pending: ["Not started", "muted"],
  partial: ["Partly tracked", "warn"],
  unknown: ["Unrecognised state", "warn"],
  unavailable: ["No linked work", "muted"],
};

const PROPOSAL_KIND = {
  unblock: "Blocked work",
  neglected: "Nobody picked this up",
  systemic: "A pattern worth fixing",
};

// ─── model ───────────────────────────────────────────────────────────────────

export function nextModel(snapshot) {
  const panel = snapshot?.panels?.proposals;
  const reason = missing(panel);
  return {
    proposals: {
      available: !reason,
      reason: reason || null,
      // Report-only on the machine and report-only here; the console offers a
      // proposal as a suggestion, never as something already decided.
      reportOnly: panel?.reportOnly !== false,
      threshold: num(panel?.threshold),
      items: reason ? [] : list(panel.proposals).map((proposal) => ({
        rank: num(proposal?.rank),
        kind: text(proposal?.kind, ""),
        title: text(proposal?.title, "A next step"),
        why: text(proposal?.why, ""),
        goalId: text(proposal?.goalId, ""),
        goalTitle: text(proposal?.goalTitle, ""),
        // Null for a company-level goal, which cannot be handed to a project.
        projectId: proposal?.projectId || null,
        ancestry: list(proposal?.ancestry).map((a) => text(a, "")).filter(Boolean),
        evidence: proposal?.evidence || null,
      })),
    },
    goals: goalsModel(snapshot?.panels?.goals),
  };
}

export function goalsModel(panel) {
  const reason = missing(panel);
  if (reason) return { available: false, configured: null, reason, roots: [], summary: null };
  if (panel.configured === false) {
    // An empty gauge reads as broken; this reads as true.
    return { available: false, configured: false, reason: "No goals are registered yet.", roots: [], summary: null };
  }
  const summary = panel.summary || {};
  return {
    available: true,
    configured: true,
    // `available: false` here means a warning was recorded, not that the goals
    // are gone — the same trap the Money tab hit. The totals are shown with a
    // caveat rather than withheld.
    incomplete: panel.available === false,
    warnings: list(panel.warnings).map((w) => text(w, "")).filter(Boolean),
    summary: {
      state: text(summary.state, "unavailable"),
      percent: Math.max(0, Math.min(100, num(summary.percent))),
      total: num(summary.total),
      complete: num(summary.complete),
      blocked: num(summary.blocked),
      active: num(summary.active),
      unknown: num(summary.unknown),
      unavailable: num(summary.unavailable),
    },
    roots: list(panel.roots).map(shapeGoal),
  };
}

function shapeGoal(goal) {
  const progress = goal?.progress || {};
  return {
    id: text(goal?.id, ""),
    title: text(goal?.title, "Untitled goal"),
    level: text(goal?.level, ""),
    projectId: goal?.projectId || null,
    progress: {
      state: text(progress.state, "unavailable"),
      percent: Math.max(0, Math.min(100, num(progress.percent))),
      total: num(progress.total),
      complete: num(progress.complete),
      blocked: num(progress.blocked),
      active: num(progress.active),
    },
    children: list(goal?.children).map(shapeGoal),
  };
}

// ─── render ──────────────────────────────────────────────────────────────────

// Which proposal is mid-confirmation, and for when. Held across redraws so a
// publish landing every thirty seconds cannot dismiss a read-back the founder
// is part-way through.
const pending = { goalId: null, when: null };

export function resetNextDraft() { pending.goalId = null; pending.when = null; }

export function renderNext(root, snapshot, { onIntent = () => {}, intentStateFor = () => null, projectsFor = null } = {}) {
  root.replaceChildren();
  const model = nextModel(snapshot);

  root.append(el("p", "view-lede",
    "What the factory thinks is worth doing next — ranked from canonical state. Nothing here is started automatically."));

  root.append(proposals(model.proposals, { onIntent, intentStateFor, projectsFor, snapshot }));
  root.append(goals(model.goals));
  return model;
}

function proposals(model, { onIntent, intentStateFor, projectsFor, snapshot }) {
  const section = el("section", "next-proposals");
  section.append(el("h2", "home-heading", "Suggested next"));

  if (!model.available) {
    section.append(el("p", "home-calm home-calm--small",
      `The machine has not published any proposals — ${model.reason}.`));
    return section;
  }
  if (!model.items.length) {
    // A sentence, not an empty list. "Nothing is proposed" and "the proposer
    // is broken" must not look the same.
    section.append(el("p", "home-calm home-calm--small",
      "Nothing is proposed right now. The proposer only speaks up about work that is blocked, "
      + "neglected, or shows a repeated pattern."));
    return section;
  }

  for (const proposal of model.items) {
    section.append(proposalCard(proposal, { onIntent, intentStateFor, projectsFor, snapshot }));
  }
  return section;
}

function proposalCard(proposal, { onIntent, intentStateFor, projectsFor, snapshot }) {
  const card = el("article", "next-card");

  const head = el("div", "next-card-head");
  if (proposal.rank) head.append(el("span", "next-rank", `#${proposal.rank}`));
  if (proposal.kind) head.append(el("span", "home-chip home-chip--muted", PROPOSAL_KIND[proposal.kind] || proposal.kind));
  if (proposal.projectId) head.append(el("span", "home-meta", proposal.projectId));
  card.append(head);

  // The goal leads, in the founder's own words from factory/goals.json.
  card.append(el("h3", "home-question", proposal.title));
  if (proposal.why) card.append(el("p", "home-why", proposal.why));

  // The numbers the proposer ranked on, so the ranking can be checked rather
  // than taken on trust.
  if (proposal.evidence) {
    const ev = proposal.evidence;
    const bits = [];
    if (num(ev.blocked)) bits.push(`${num(ev.blocked)} blocked`);
    if (num(ev.active)) bits.push(`${num(ev.active)} in flight`);
    if (num(ev.remaining)) bits.push(`${num(ev.remaining)} remaining`);
    if (num(ev.total)) bits.push(`of ${num(ev.total)} tracked`);
    if (bits.length) card.append(el("p", "home-meta home-meta--dim", bits.join(" · ")));
  }

  const key = (kind) => `${kind}:proposal:${proposal.goalId || proposal.title}`;
  for (const kind of ["objective.start", "overnight.add"]) {
    const state = intentStateFor(key(kind));
    if (state) { card.append(intentStatus(state)); return card; }
  }

  // A company-level goal names no project, and an objective must be started
  // against one. Drawing a button that cannot complete is the thing the
  // standing rules forbid, so it is replaced with the reason.
  if (!proposal.projectId) {
    card.append(el("p", "next-blocked",
      "This is a company-level goal and names no project, so it cannot be handed to the factory from here. "
      + "Pick the project it belongs to on the Launch tab."));
    if (proposal.ancestry.length) card.append(ancestryLine(proposal));
    return card;
  }

  const project = resolveProject(proposal.projectId, { projectsFor, snapshot });
  if (!project.launchable) {
    card.append(el("p", "next-blocked",
      `${project.name} cannot be handed work right now — ${project.blockedReason || "it is unavailable"}.`));
    if (proposal.ancestry.length) card.append(ancestryLine(proposal));
    return card;
  }

  if (pending.goalId === (proposal.goalId || proposal.title)) {
    // The same read-back Launch uses, imported rather than rewritten.
    card.append(outcomeConfirmation({
      when: pending.when,
      objective: proposal.title,
      project,
      onConfirm: (kind, args, button) => {
        onIntent(kind, args, button, key(kind));
        resetNextDraft();
        rerender();
      },
      onCancel: () => { resetNextDraft(); rerender(); },
    }));
    return card;
  }

  // Two explicit choices, never an automatic start.
  const actions = el("div", "launch-actions");
  actions.append(choice("Start it now", "primary", () => {
    pending.goalId = proposal.goalId || proposal.title; pending.when = "now"; rerender();
  }));
  actions.append(choice("Add it to tonight", "secondary", () => {
    pending.goalId = proposal.goalId || proposal.title; pending.when = "night"; rerender();
  }));
  card.append(actions);

  if (proposal.ancestry.length) card.append(ancestryLine(proposal));
  return card;
}

// What this proposal rolls up into, so a suggestion is never rootless.
function ancestryLine(proposal) {
  return el("p", "home-meta home-meta--dim", `part of: ${proposal.ancestry.join(" › ")}`);
}

// The proposal names a project key; Launch publishes what can be launched into.
// Without that list the console cannot know whether a project is paused, so it
// says so rather than guessing.
function resolveProject(projectId, { projectsFor, snapshot }) {
  const projects = typeof projectsFor === "function" ? projectsFor(snapshot) : [];
  const found = (projects || []).find((p) => p.key === projectId);
  if (found) return found;
  return {
    key: projectId,
    name: projectId,
    isHeadquarters: false,
    launchable: false,
    blockedReason: "the machine has not published it as somewhere work can be sent",
  };
}

function goals(model) {
  const section = el("section", "next-goals");
  section.append(el("h2", "home-heading", "Where this is going"));

  if (!model.available) {
    section.append(el("p", "home-calm home-calm--small", model.reason));
    return section;
  }

  const s = model.summary;
  const [label] = GOAL_STATE[s.state] || GOAL_STATE.unknown;
  section.append(el("p", "home-meta home-meta--dim", label));

  if (model.incomplete) {
    section.append(el("p", "money-warning",
      `Some canonical work could not be read, so these totals are incomplete${model.warnings.length ? `: ${model.warnings[0]}` : "."}`));
  }

  // goalsView.mjs's sentence, word for word.
  const line = `${s.complete} of ${s.total} tracked units complete`
    + (s.blocked ? ` · ${s.blocked} blocked` : "")
    + (s.active ? ` · ${s.active} in flight` : "")
    + (s.unavailable ? ` · ${s.unavailable} goal${s.unavailable === 1 ? "" : "s"} with no linked work` : "")
    + (s.unknown ? ` · ${s.unknown} unrecognised` : "");
  section.append(bar(s.percent, s.state, `${s.percent}% of tracked work complete`));
  section.append(el("p", "next-goal-summary", line));

  const listEl = el("ul", "next-goal-list");
  for (const root of model.roots) listEl.append(goalRow(root, 0));
  section.append(listEl);
  return section;
}

function goalRow(goal, depth) {
  const row = el("li", `next-goal next-goal--d${Math.min(depth, 2)}`);
  const head = el("div", "next-goal-head");
  head.append(el("strong", null, goal.title));
  const [label, tone] = GOAL_STATE[goal.progress.state] || GOAL_STATE.unknown;
  head.append(el("em", `next-goal-state next-goal-state--${tone}`, label));
  row.append(head);

  row.append(bar(goal.progress.percent, goal.progress.state, `${goal.progress.percent}% of ${goal.title} complete`));
  row.append(el("p", "home-meta",
    goal.progress.total
      ? `${goal.progress.percent}% · ${goal.progress.complete}/${goal.progress.total}`
        + (goal.progress.blocked ? ` · ${goal.progress.blocked} blocked` : "")
        + (goal.progress.active ? ` · ${goal.progress.active} in flight` : "")
      : "no linked work"));

  if (goal.children.length) {
    const kids = el("ul", "next-goal-list");
    for (const child of goal.children) kids.append(goalRow(child, depth + 1));
    row.append(kids);
  }
  return row;
}

function bar(percent, state, label) {
  const [, tone] = GOAL_STATE[state] || GOAL_STATE.unknown;
  const wrap = el("div", "money-bar money-bar--slim");
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", label);
  const fill = el("span", `money-bar-fill money-bar-fill--${tone === "ok" ? "ok" : tone === "warn" ? "warn" : "share"}`);
  fill.style.width = `${percent}%`;
  wrap.append(fill);
  return wrap;
}

function choice(label, tone, onClick) {
  const button = el("button", `launch-btn launch-btn--${tone}`, label);
  button.type = "button";
  button.addEventListener("click", () => onClick(button));
  return button;
}

let rerender = () => {};
export function setNextRerender(fn) { rerender = typeof fn === "function" ? fn : () => {}; }
