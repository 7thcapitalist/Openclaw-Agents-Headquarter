// Home: the one screen that answers "does anything need me right now?"
//
// Order is the design. Decisions first, because a blocked founder queue is the
// failure this whole control plane exists to prevent — five days of shipped
// work went unseen because `npm run approve --list` printed "nothing is
// waiting" while two decisions sat unread. Then what is broken. Then one line
// of pulse. If none of that applies, one line saying so, rather than a wall of
// panels implying there is something to read.
//
// The model half is pure so it can be tested without a browser. Rendering is
// DOM-API only — no innerHTML anywhere near snapshot data.

import { freshness, list, money, num, text, unavailable } from "./render.mjs";

// ─── model ───────────────────────────────────────────────────────────────────

/** "as of 19:42, 40 seconds ago" — the clock time AND the age, always both. */
export function ageLine(publishedAt, now = Date.now()) {
  const fresh = freshness(publishedAt, now);
  if (fresh.unknown) return { ...fresh, line: "age unknown — treat this page as stale" };

  const at = new Date(Date.parse(publishedAt));
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const seconds = fresh.seconds;
  const spoken =
    seconds < 90 ? `${seconds} second${seconds === 1 ? "" : "s"} ago`
      : seconds < 5400 ? `${Math.round(seconds / 60)} minutes ago`
        : seconds < 172_800 ? `${Math.round(seconds / 3600)} hours ago`
          : `${Math.round(seconds / 86_400)} days ago`;
  return { ...fresh, line: `as of ${clock}, ${spoken}` };
}

/** Decisions waiting on the founder, with their options. */
export function homeDecisions(panels) {
  if (unavailable(panels?.company)) return [];
  return list(panels.company.decisions)
    .map((decision) => ({
      id: text(decision?.id, ""),
      taskId: text(decision?.taskId, ""),
      project: text(decision?.project, ""),
      question: text(decision?.question || decision?.summary, "A decision is needed."),
      why: text(decision?.why, ""),
      recommendation: text(decision?.recommendation, ""),
      options: list(decision?.options).map((o) => String(o)).filter(Boolean),
      since: text(decision?.requestedAt, ""),
      risk: text(decision?.risk, ""),
    }))
    .filter((decision) => decision.id !== "");
}

const BROKEN = new Set(["blocked", "failed"]);

/** Anything blocked or failed — after decisions, because it is not a question. */
export function homeAttention(panels) {
  const out = [];
  if (!unavailable(panels?.operations)) {
    for (const task of list(panels.operations.tasks)) {
      const status = String(task?.status || "").toLowerCase();
      if (!BROKEN.has(status)) continue;
      out.push({
        kind: "task",
        id: text(task?.taskId, "unknown"),
        status,
        stage: text(task?.stage, "—"),
        since: text(task?.updatedAt, ""),
      });
    }
    for (const objective of list(panels.operations.objectives)) {
      if (objective?.healthy !== false) continue;
      const findings = list(objective.findings);
      out.push({
        kind: "objective",
        id: text(objective?.objectiveId, "unknown"),
        status: "unhealthy",
        stage: text(findings[0]?.code, "—"),
        detail: text(findings[0]?.message, ""),
        since: text(objective?.recordedAt, ""),
      });
    }
  }
  return out;
}

/** One line. Not a dashboard. */
export function homePulse(panels) {
  const ops = unavailable(panels?.operations) ? null : panels.operations;
  const company = unavailable(panels?.company) ? null : panels.company;
  const budgets = unavailable(panels?.budgets) ? null : panels.budgets;

  // Deliberately "spend to date", not "today": the snapshot carries no per-day
  // cost bucket, and labelling an all-time total as today's would be a lie the
  // viewer cannot detect. Adding `byDay` to the snapshot is a builder change.
  const micros = num(budgets?.totals?.costMicros, 0);
  const unpriced = num(budgets?.totals?.unpricedEvents, 0);

  return {
    running: num(ops?.summary?.activeRuns, 0),
    tasks: num(ops?.summary?.tasks, 0),
    blocked: num(ops?.summary?.blockedRuns, 0),
    projects: num(company?.summary?.projects, 0),
    spendLabel: money(micros),
    unpricedEvents: unpriced,
  };
}

export function homeModel(snapshot, now = Date.now()) {
  const panels = snapshot?.panels || {};
  const decisions = homeDecisions(panels);
  const attention = homeAttention(panels);
  return {
    age: ageLine(snapshot?.publishedAt, now),
    decisions,
    attention,
    pulse: homePulse(panels),
    calm: decisions.length === 0 && attention.length === 0,
  };
}

// ─── render ──────────────────────────────────────────────────────────────────

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = String(textContent);
  return node;
}

function decisionCard(decision, onAnswer) {
  const card = el("article", "home-card home-card--decision");

  const head = el("div", "home-card-head");
  head.append(el("span", "home-chip home-chip--decision", "Needs you"));
  if (decision.project) head.append(el("span", "home-meta", decision.project));
  if (decision.risk === "high") head.append(el("span", "home-chip home-chip--risk", "high risk"));
  card.append(head);

  card.append(el("h3", "home-question", decision.question));
  if (decision.why) card.append(el("p", "home-why", decision.why));
  if (decision.recommendation) {
    const rec = el("p", "home-rec");
    rec.append(el("strong", null, "Recommended: "));
    rec.append(document.createTextNode(decision.recommendation));
    card.append(rec);
  }

  const actions = el("div", "home-actions");
  if (decision.options.length) {
    for (const option of decision.options) {
      const button = el("button", "home-option", option);
      button.type = "button";
      button.addEventListener("click", () => onAnswer(decision, option, button));
      actions.append(button);
    }
  } else {
    const input = el("input", "home-freetext");
    input.type = "text";
    input.placeholder = "Your answer";
    const send = el("button", "home-option", "Send");
    send.type = "button";
    send.addEventListener("click", () => onAnswer(decision, input.value, send));
    actions.append(input, send);
  }
  card.append(actions);

  const foot = el("p", "home-meta home-foot");
  foot.textContent = decision.taskId ? `${decision.taskId}` : decision.id;
  card.append(foot);
  return card;
}

function attentionRow(item) {
  const row = el("li", "home-row");
  const tone = item.status === "failed" || item.status === "unhealthy" ? "bad" : "warn";
  row.append(el("span", `home-dot home-dot--${tone}`));
  const body = el("div", "home-row-body");
  body.append(el("div", "home-row-title", item.id));
  body.append(el("div", "home-meta", item.detail ? item.detail : `${item.status} at ${item.stage}`));
  row.append(body);
  return row;
}

/**
 * Draw Home into `root`. `onAnswer(decision, choice, button)` is called when the
 * founder picks an option; it is the caller's job to queue the intent and to be
 * honest that queueing is not the same as done.
 */
export function renderHome(root, snapshot, { onAnswer = () => {}, now = Date.now() } = {}) {
  const model = homeModel(snapshot, now);
  root.replaceChildren();

  // Age, always. This page is eventually consistent and must never imply
  // otherwise — an 11-hour-old mirror looked exactly like a live one.
  const age = el("div", `home-age${model.age.stale ? " home-age--stale" : ""}`);
  age.append(el("span", "home-age-dot"));
  age.append(el("span", null, model.age.line));
  root.append(age);

  if (model.age.stale) {
    const warn = el("div", "home-stale");
    warn.append(el("strong", null, model.age.unknown ? "This page may not be current." : "This page is not live."));
    warn.append(document.createTextNode(
      model.age.unknown
        ? " The snapshot carries no usable timestamp. Check the factory machine before acting on anything here."
        : ` The factory machine last published ${model.age.line.replace(/^as of \d\d:\d\d, /, "")}. Something has stopped publishing — check the machine before acting on anything below.`,
    ));
    root.append(warn);
  }

  if (model.calm) {
    root.append(el("p", "home-calm", "Nothing needs you right now."));
  }

  if (model.decisions.length) {
    root.append(el("h2", "home-heading", model.decisions.length === 1 ? "1 decision needs you" : `${model.decisions.length} decisions need you`));
    const wrap = el("div", "home-cards");
    for (const decision of model.decisions) wrap.append(decisionCard(decision, onAnswer));
    root.append(wrap);
  }

  if (model.attention.length) {
    root.append(el("h2", "home-heading", model.attention.length === 1 ? "1 thing is stuck" : `${model.attention.length} things are stuck`));
    const listEl = el("ul", "home-list");
    for (const item of model.attention) listEl.append(attentionRow(item));
    root.append(listEl);
  }

  const p = model.pulse;
  const pulse = el("p", "home-pulse");
  pulse.textContent =
    `${p.running} running of ${p.tasks} tasks across ${p.projects} project${p.projects === 1 ? "" : "s"}` +
    ` · ${p.spendLabel} spend to date` +
    (p.unpricedEvents ? ` (${p.unpricedEvents} unpriced)` : "");
  root.append(pulse);

  return model;
}
