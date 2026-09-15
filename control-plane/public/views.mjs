// The console's tabs beyond Home. Same modules, same vocabulary, same mapping
// as the local dashboard — a screen that exists in both is the same screen.

import { list, money, num, text, unavailable } from "./render.mjs";
import { BOARD_COLUMNS, buildBoard, filterByProject } from "./board.mjs";
import { stageLabel, taskTitle, taskOutcomeLine } from "./stage-vocabulary.mjs";

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

export function renderBoard(root, snapshot, { project = null, onTask = () => {} } = {}) {
  root.replaceChildren();
  const tasks = unavailable(snapshot?.panels?.operations) ? [] : list(snapshot.panels.operations.tasks);
  const board = buildBoard(filterByProject(tasks, project));

  root.append(el("p", "view-lede",
    `Where every piece of work sits right now${project ? ` · ${project}` : ""} — ${board.total} task${board.total === 1 ? "" : "s"}.`));

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
  const node = el("article", "board-card");
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.append(el("h4", null, card.title));
  node.append(el("div", "home-meta", card.outcomeLine));
  const foot = el("div", "board-card-foot");
  if (card.project) foot.append(el("span", "home-chip", card.project));
  if (card.assignee) foot.append(el("span", "home-chip home-chip--muted", card.assignee));
  if (card.risk === "high") foot.append(el("span", "home-chip home-chip--risk", "high risk"));
  node.append(foot);
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
    meta.push(deploy?.productionUrl ? "deployed" : `not deployed${deploy?.state ? ` (${deploy.state})` : ""}`);
    card.append(el("p", "home-meta", meta.join(" · ")));

    if (deploy?.productionUrl) {
      const links = el("div", "home-links");
      const a = el("a", "home-link", "Open the live site ↗");
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
