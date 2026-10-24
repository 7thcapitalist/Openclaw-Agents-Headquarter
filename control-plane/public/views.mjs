// The console's tabs beyond Home. Same modules, same vocabulary, same mapping
// as the local dashboard — a screen that exists in both is the same screen.

import { degraded, list, money, num, text, unavailable } from "./render.mjs";
import { BOARD_COLUMNS, buildBoard, filterByProject, filterStalled } from "./board.mjs";
import { stageLabel, taskTitle, taskOutcomeLine } from "./stage-vocabulary.mjs";
import { intentStatus } from "./home.mjs";
import { idleReasonLabel } from "./learning.mjs";

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = String(textContent);
  return node;
}

function idLine(id) {
  return el("div", "home-id", id);
}

// ─── Board ───────────────────────────────────────────────────────────────────

export function renderBoard(root, snapshot, {
  project = null, onTask = () => {}, stalledOnly = false, onStalledOnly = null, now = Date.now(),
} = {}) {
  root.replaceChildren();
  const operations = snapshot?.panels?.operations;
  const tasks = unavailable(operations) ? [] : list(operations.tasks);
  const scoped = filterByProject(tasks, project);
  // The whole board is built first so the filter has an honest count to offer
  // even while it is on.
  const all = buildBoard(scoped, { now });
  const board = stalledOnly ? buildBoard(filterStalled(scoped, { now }), { now }) : all;

  root.append(el("p", "view-lede",
    `Where every piece of work sits right now${project ? ` · ${project}` : ""} — ${board.total} task${board.total === 1 ? "" : "s"}`
    + `${stalledOnly ? ` with no movement in ${all.stalledAfterDays}+ days` : ""}.`));

  // A warning is shown BESIDE the work, never instead of it. An unreadable
  // cost ledger used to blank this whole board while 21 tasks were running.
  const boardWarning = degraded(operations);
  if (boardWarning) root.append(el("p", "panel-degraded", boardWarning));

  if (onStalledOnly && (all.stalled || stalledOnly)) {
    const bar = el("div", "board-filter");
    const toggle = el("button", `board-filter-btn${stalledOnly ? " is-on" : ""}`,
      stalledOnly ? "Showing only what has stopped" : `Show only what has stopped (${all.stalled})`);
    toggle.type = "button";
    toggle.setAttribute("aria-pressed", String(Boolean(stalledOnly)));
    toggle.addEventListener("click", () => onStalledOnly(!stalledOnly));
    bar.append(toggle);
    // The threshold is stated, so "stopped" can never be read as a judgement
    // the board made on its own terms.
    bar.append(el("span", "home-meta home-meta--dim", `no movement in ${all.stalledAfterDays}+ days`));
    root.append(bar);
  }

  if (stalledOnly && !board.total) {
    root.append(el("p", "home-calm home-calm--small", "Everything has moved in the last few days."));
    return board;
  }

  const grid = el("div", "board-grid");
  for (const column of BOARD_COLUMNS) {
    const col = el("section", "board-col");
    const head = el("div", "board-col-head");
    head.append(el("span", null, column));
    head.append(el("b", null, String(board.counts[column])));
    col.append(head);
    if (!board.columns[column].length) col.append(el("p", "home-meta", "Nothing here."));
    for (const card of board.columns[column]) col.append(boardCard(card, onTask));
    grid.append(col);
  }
  root.append(grid);
  return board;
}

function boardCard(card, onTask) {
  const node = el("article", `board-card${card.movement?.stalled ? " board-card--stalled" : ""}`);
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.append(el("h4", null, card.title));
  node.append(el("div", "home-meta", card.outcomeLine));
  const foot = el("div", "board-card-foot");
  if (card.project) foot.append(el("span", "home-chip", card.project));
  if (card.assignee) foot.append(el("span", "home-chip home-chip--muted", card.assignee));
  if (card.risk === "high") foot.append(el("span", "home-chip home-chip--risk", "high risk"));
  node.append(foot);
  // MOVEMENT, not activity: this is the last recorded state transition, not
  // the last time an agent worked on it. Eight days of silence looked exactly
  // like an hour of it until this line existed.
  if (card.movement) {
    node.append(el("div", `board-card-moved${card.movement.stalled ? " is-stalled" : ""}`, card.movement.label));
  }
  node.append(idLine(card.id));
  node.addEventListener("click", () => onTask(card.id));
  node.addEventListener("keydown", (e) => { if (e.key === "Enter") onTask(card.id); });
  return node;
}

// ─── Projects ────────────────────────────────────────────────────────────────

export function renderProjects(root, snapshot, { onProject = () => {} } = {}) {
  root.replaceChildren();
  const company = unavailable(snapshot?.panels?.company) ? null : snapshot.panels.company;
  const deployments = unavailable(snapshot?.panels?.deployments) ? null : snapshot.panels.deployments;
  const projects = list(company?.projects);

  if (!projects.length) {
    root.append(el("p", "home-calm", "No projects are registered yet."));
    return;
  }
  root.append(el("p", "view-lede", "How each project is doing. Tap one to see only its work on the Board."));

  const deployByKey = new Map(list(deployments?.deployments).map((d) => [d.projectKey, d]));
  const wrap = el("div", "home-cards");
  for (const project of projects) {
    const card = el("article", "home-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.append(el("h3", "home-question", text(project.name, project.key)));
    if (project.mission) card.append(el("p", "home-why", text(project.mission, "")));

    const counts = project.taskCounts || {};
    const stats = el("div", "stat-line");
    stats.append(statChip(num(counts.active, 0), "running"));
    stats.append(statChip(num(counts.blocked, 0) + num(counts.failed, 0), "blocked"));
    stats.append(statChip(num(project.openDecisions, 0), "waiting on you"));
    stats.append(statChip(num(project.taskCount, 0), "tasks"));
    card.append(stats);

    const spend = project.spend?.costMicros;
    const deploy = deployByKey.get(project.key) || project.deployment || null;
    const meta = [];
    meta.push(spend != null ? `${money(spend)} spent` : "no spend recorded");
    // A URL alone is not a deployment. Before deployment records existed the
    // only way to have a URL was to have deployed, so "has a URL" stood in for
    // "deployed"; a founder-declared registry URL breaks that equivalence, and
    // claiming "deployed" on the strength of a note in a config file is
    // exactly the kind of wrong number this console must never show.
    meta.push(deploy?.state === "deployed"
      ? "deployed"
      : deploy?.productionUrl
        ? "URL declared, no deploy recorded"
        : `not deployed${deploy?.state ? ` (${deploy.state})` : ""}`);
    card.append(el("p", "home-meta", meta.join(" · ")));

    if (deploy?.productionUrl) {
      const links = el("div", "home-links");
      const a = el("a", "home-link", deploy.state === "deployed" ? "Open the live site ↗" : "Open the declared URL ↗");
      a.href = deploy.productionUrl; a.target = "_blank"; a.rel = "noreferrer";
      a.addEventListener("click", (e) => e.stopPropagation());
      links.append(a);
      card.append(links);
    }
    card.append(idLine(project.key));
    card.addEventListener("click", () => onProject(project.key));
    card.addEventListener("keydown", (e) => { if (e.key === "Enter") onProject(project.key); });
    wrap.append(card);
  }
  root.append(wrap);
}

function statChip(value, label) {
  const chip = el("span", "stat-chip");
  chip.append(el("strong", null, String(value)));
  chip.append(document.createTextNode(` ${label}`));
  return chip;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export function renderAgents(root, snapshot) {
  root.replaceChildren();
  const company = unavailable(snapshot?.panels?.company) ? null : snapshot.panels.company;
  const agents = list(company?.agents?.agents);
  if (!agents.length) {
    root.append(el("p", "home-calm", "No agents are registered."));
    return;
  }
  root.append(el("p", "view-lede", "Every role, what it is on right now, and the model it actually runs on."));

  const listEl = el("ul", "home-list");
  for (const agent of agents) {
    const row = el("li", "home-row");
    const busy = agent.running || agent.currentTask;
    row.append(el("span", `home-dot home-dot--${agent.blocked || agent.needsFounder ? "bad" : busy ? "good" : "idle"}`));
    const body = el("div", "home-row-body");
    body.append(el("div", "home-row-title", text(agent.name, agent.id)));

    // What it is on, or honestly idle.
    const task = agent.currentTask;
    const doing = busy && task
      ? `${taskTitle({ outcome: task.objective || task.outcome, taskId: task.id })}${task.stage ? ` · ${stageLabel(task.stage)}` : ""}`
      : agent.blocked ? "Blocked" : "Idle";
    body.append(el("div", "home-meta", doing));

    // Harness AND the seat — the field that already misled once.
    const seat = agent.modelSeat;
    const runs = seat
      ? `${agent.harness || "?"} → ${seat.primary}${seat.source === "config" ? " (configured)" : ""}`
      : `${agent.harness || "?"} → model unknown`;
    body.append(el("div", "home-meta home-meta--dim", runs));
    if (agent.lastActivityAt) body.append(el("div", "home-meta home-meta--dim", `last active ${agent.lastActivityAt}`));
    body.append(idLine(agent.id));
    row.append(body);
    listEl.append(row);
  }
  root.append(listEl);
}


// ─── Deliveries ──────────────────────────────────────────────────────────────

const FINISHED = new Set(["merged", "complete", "completed", "merge-ready"]);

/**
 * What the factory has produced, and what to do next.
 *
 * The suggested next step comes from the proposer, which is report-only on the
 * machine and report-only here: it is a suggestion the founder accepts, never
 * something the factory has already decided.
 */
export function renderDeliveries(root, snapshot, { onTask = () => {} } = {}) {
  root.replaceChildren();
  const ops = unavailable(snapshot?.panels?.operations) ? null : snapshot.panels.operations;
  const costByTask = ops?.costs?.byTask || {};
  const delivered = list(ops?.tasks)
    .filter((t) => FINISHED.has(String(t?.status || "").toLowerCase()))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  root.append(el("p", "view-lede", "What the factory has produced, newest first."));

  if (!delivered.length) {
    root.append(el("p", "home-calm", "Nothing has been delivered yet."));
  } else {
    const wrap = el("div", "home-cards");
    for (const task of delivered) wrap.append(deliveryCard(task, costByTask[task.taskId], onTask));
    root.append(wrap);
    // Said once, not on all fourteen cards. A dead link would be worse than an
    // honest absence, but so is the same sentence repeated down the screen.
    if (delivered.some((t) => !t.previewUrl)) {
      root.append(el("p", "home-meta home-meta--dim",
        "Previews are missing because the factory does not yet write a deployment record when a task finishes."));
    }
  }

}

function deliveryCard(task, cost, onTask) {
  const card = el("article", "home-card");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.append(el("h3", "home-question", taskTitle({ outcome: task.outcome, taskId: task.taskId })));

  const bits = [];
  if (task.projectId) bits.push(task.projectId);
  if (cost?.costMicros != null) bits.push(`${money(cost.costMicros)} spent`);
  else bits.push("cost not recorded");
  bits.push(taskOutcomeLine({ status: task.status, stage: task.stage }));
  card.append(el("p", "home-meta", bits.join(" · ")));

  const links = el("div", "home-links");
  if (task.prUrl) links.append(extLink(task.prUrl, "Pull request ↗"));
  if (task.previewUrl) links.append(extLink(task.previewUrl, "Preview ↗"));
  card.append(links);
  card.append(idLine(task.taskId));
  card.addEventListener("click", (e) => { if (e.target.tagName !== "A") onTask(task.taskId); });
  card.addEventListener("keydown", (e) => { if (e.key === "Enter") onTask(task.taskId); });
  return card;
}

function proposalCard(proposal, { onStart, onQueue, intentStateFor }) {
  const card = el("article", "home-card home-card--decision");
  const head = el("div", "home-card-head");
  head.append(el("span", "home-chip home-chip--decision", `Suggestion ${proposal.rank ?? ""}`.trim()));
  if (proposal.projectId) head.append(el("span", "home-meta", proposal.projectId));
  card.append(head);
  card.append(el("h3", "home-question", text(proposal.title, "A next step")));
  if (proposal.why) card.append(el("p", "home-why", text(proposal.why, "")));

  const key = `proposal:${proposal.goalId || proposal.title}`;
  const state = intentStateFor(key);
  if (state) { card.append(intentStatus(state)); return card; }

  // A proposal is aimed at a goal, and a goal may sit above the projects rather
  // than inside one. With no project there is nowhere to send the work, so the
  // card says that instead of offering a button that would be refused.
  if (!proposal.projectId) {
    card.append(el("p", "home-meta home-meta--dim",
      "This sits above any single project, so it has no repository to run in. "
      + "Start it from the command center on Today, aimed at the project you mean."));
    return card;
  }

  if (onStart || onQueue) {
    const actions = el("div", "home-actions");
    // Two explicit choices, never an automatic start. The proposer proposes;
    // the founder disposes. The local dashboard deliberately has no write route
    // for proposals for exactly this reason, and that property is preserved by
    // making acceptance a click with a stated consequence.
    if (onStart) {
      const now = el("button", "home-option", "Start it now");
      now.type = "button";
      now.addEventListener("click", () => onStart(proposal, now, key));
      actions.append(now);
    }
    if (onQueue) {
      const tonight = el("button", "home-option home-option--quiet", "Add it to tonight");
      tonight.type = "button";
      tonight.addEventListener("click", () => onQueue(proposal, tonight, key));
      actions.append(tonight);
    }
    card.append(actions);
  }
  return card;
}

function extLink(href, label) {
  const a = el("a", "home-link", label);
  a.href = href; a.target = "_blank"; a.rel = "noreferrer";
  return a;
}

// ─── Learning ───────────────────────────────────────────────────────────────

export function renderLearning(root, snapshot, { onMode = null, intentStateFor = () => null } = {}) {
  root.replaceChildren();
  const source = snapshot?.panels?.learning;
  const reason = unavailable(source);
  root.append(el("p", "view-lede", "What the factory learned, what it started, and why it is waiting."));
  if (!source || reason) {
    root.append(el("p", "home-calm", `Learning state is unavailable${reason ? `: ${reason}` : "."}`));
    return;
  }

  const modeCard = el("section", "home-card learning-mode-card");
  modeCard.append(el("h2", "home-heading", `Mode · ${source.mode || "unknown"}`));
  const actions = el("div", "home-actions learning-mode-actions");
  for (const mode of ["off", "shadow", "on"]) {
    const key = `learning:mode:${mode}`;
    const button = el("button", `home-option${source.mode === mode ? " is-current" : ""}`, mode);
    button.type = "button";
    button.disabled = !onMode || source.mode === mode;
    button.setAttribute("aria-pressed", String(source.mode === mode));
    button.addEventListener("click", () => onMode?.(mode, button, key));
    actions.append(button);
    const pending = source.mode === mode ? null : intentStateFor(key);
    if (pending) actions.append(intentStatus(pending));
  }
  modeCard.append(actions);
  root.append(modeCard);

  const launches = list(source.launches);
  const activity = [
    ...launches.map((item) => ({ item, label: "launched" })),
    ...list(source.wouldHaveLaunched).map((item) => ({ item, label: "would have launched" })),
    ...list(source.proposals).map((item) => ({ item, label: "awaiting founder" })),
  ].sort((a, b) => String(b.item?.at || "").localeCompare(String(a.item?.at || "")));
  const idle = idleReasonLabel(source.idleReason, source);
  if (idle) root.append(el("p", "learning-idle", `Idle: ${idle}`));

  const credit = el("section", "learning-credit");
  const used = el("div"); used.append(el("strong", null, source.credit?.usedBySelfImprovement ?? 0)); used.append(el("span", null, "used by self-improvement"));
  const expired = el("div"); expired.append(el("strong", null, source.credit?.wouldHaveExpired ?? 0)); expired.append(el("span", null, "would otherwise have expired"));
  credit.append(used, expired, el("small", null, source.credit?.basis || "estimate"));
  root.append(credit);

  const findings = list(source.findings);
  if (!findings.length && !activity.length) {
    root.append(el("p", "home-calm", "No findings or launches yet."));
    return;
  }
  const grid = el("div", "learning-grid");
  grid.append(learningList("Recent findings", findings.map((finding) => {
    const card = el("article", "home-card");
    card.append(el("h3", "home-question", finding.title || finding.id || "Untitled finding"));
    card.append(el("p", "home-meta", finding.eligible ? "eligible" : `ineligible${finding.ineligibleReason ? ` · ${finding.ineligibleReason}` : ""}`));
    for (const evidence of list(finding.evidence)) card.append(el("div", "home-id", evidence));
    return card;
  }), "No findings yet."));
  grid.append(learningList("Learning activity", activity.map(({ item, label }) => {
    const card = el("article", "home-card");
    card.append(el("span", "home-chip", label));
    card.append(el("h3", "home-question", item?.objective || item?.objectiveId || "Objective not recorded"));
    card.append(el("p", "home-meta", `${item?.at || "time unknown"} · from finding ${item?.findingId || "unknown"}`));
    return card;
  }), "Nothing launched yet."));
  root.append(grid);
}

function learningList(title, cards, empty) {
  const section = el("section");
  section.append(el("h2", "home-heading", title));
  if (!cards.length) section.append(el("p", "home-calm home-calm--small", empty));
  else { const wrap = el("div", "home-cards"); wrap.append(...cards); section.append(wrap); }
  return section;
}

// ── Next ─────────────────────────────────────────────────────────────────────
//
// What the factory suggests doing, and the direction that suggestion serves.
// These were two separate absences: proposals were rendered at the bottom of
// Deliveries under a card that said starting work was not wired, and the goals
// panel — published every cycle — was rendered nowhere at all.
//
// The framing stays "ranked from canonical state; nothing here starts on its
// own". That is true, and it is what makes the tab safe to leave open.

/**
 * The goals roll-up: the one-line answer to "are we getting anywhere".
 *
 * Reads `summary` when the machine published one and derives it from the goal
 * tree otherwise, so a mirror from an older publisher still says something.
 */
export function goalsRollup(panels) {
  const goals = panels?.goals;
  // A panel the machine never sent and a panel whose builder threw are
  // different facts. `unavailable()` answers "no data published" for both, so
  // the absent case is named here before asking it.
  if (!goals) {
    return { available: false, reason: "No goals have been published yet." };
  }
  // Asked before `unavailable()`, which owns the `configured === false` case
  // and would answer it with a bare "not configured". Here there is something
  // truer to say. Same ordering, and the same reason for it, as `budgetModel`
  // in money.mjs.
  if (!goals.unavailable && goals.configured === false) {
    return {
      available: false,
      // An empty gauge reads as broken; this reads as true.
      reason: "No goals are registered yet, so there is no direction to measure against.",
    };
  }
  const reason = unavailable(goals);
  if (reason) {
    return { available: false, reason: `The goals panel is unavailable: ${reason}.` };
  }

  const summary = goals.summary || {};
  const roots = list(goals.roots).length ? list(goals.roots) : list(goals.goals);
  const total = num(summary.total);

  return {
    available: true,
    state: text(summary.state, "unknown"),
    percent: num(summary.percent),
    total,
    complete: num(summary.complete),
    blocked: num(summary.blocked),
    active: num(summary.active),
    // "23 tracked units" is the tunnel's phrasing and the founder's.
    line: total
      ? `${num(summary.complete)} of ${total} tracked units complete`
        + ` · ${num(summary.blocked)} blocked`
        + ` · ${num(summary.active)} in flight`
      : "Nothing is tracked under these goals yet.",
    roots: roots.map((goal) => ({
      id: text(goal.id, null),
      title: text(goal.title, "Untitled goal"),
      level: text(goal.level, ""),
      projectId: text(goal.projectId, null),
      percent: num(goal.progress?.percent),
      state: text(goal.progress?.state, "unknown"),
      blocked: num(goal.progress?.blocked),
      total: num(goal.progress?.total),
    })),
  };
}

export function renderNext(root, snapshot, {
  onStart = null, onQueue = null, intentStateFor = () => null,
} = {}) {
  root.replaceChildren();

  const proposals = unavailable(snapshot?.panels?.proposals) ? null : snapshot.panels.proposals;
  const items = list(proposals?.proposals);

  root.append(el("p", "view-lede",
    "Ranked from canonical state. Nothing here starts on its own — you choose what runs, and when."));

  if (items.length) {
    const wrap = el("div", "home-cards");
    for (const proposal of items) wrap.append(proposalCard(proposal, { onStart, onQueue, intentStateFor }));
    root.append(wrap);
  } else {
    const reason = unavailable(snapshot?.panels?.proposals);
    root.append(el("p", "home-calm", reason
      ? `The factory has not published suggestions: ${reason}`
      : "The factory has nothing to suggest right now."));
  }

  // The direction those suggestions serve.
  const goals = goalsRollup(snapshot?.panels || {});
  root.append(el("h2", "home-heading", "Where this is going"));

  if (!goals.available) {
    root.append(el("p", "home-calm home-calm--small", goals.reason));
    return;
  }

  root.append(el("p", "home-meta", goals.line));

  if (goals.roots.length) {
    const listEl = el("ul", "home-list");
    for (const goal of goals.roots) listEl.append(goalRow(goal));
    root.append(listEl);
  }
}

function goalRow(goal) {
  const row = el("li", "home-row");
  const tone = goal.state === "blocked" ? "bad" : goal.state === "complete" ? "good" : "warn";
  row.append(el("span", `home-dot home-dot--${tone}`));

  const main = el("div", "home-row-body");
  main.append(el("strong", null, goal.title));
  const bits = [`${goal.percent}%`];
  if (goal.total) bits.push(`${goal.total} tracked`);
  if (goal.blocked) bits.push(`${goal.blocked} blocked`);
  if (goal.projectId) bits.push(goal.projectId);
  main.append(el("span", "home-meta home-meta--dim", bits.join(" · ")));
  row.append(main);
  return row;
}
