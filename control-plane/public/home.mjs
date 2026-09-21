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
import { eventLine, stageLabel, taskOutcomeLine, taskTitle } from "./stage-vocabulary.mjs";

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
    .map((decision) => {
      const raw = text(decision?.question || decision?.summary, "");
      const split = splitQuestion(raw, text(decision?.why, ""));
      return {
        id: text(decision?.id, ""),
        taskId: text(decision?.taskId, ""),
        project: text(decision?.project, ""),
        // The question in plain language, as the title (A4). Machine prose —
        // session keys, evidence paths, gateway diagnostics — never leads.
        question: plainQuestion(split.question),
        context: plainContext(split.why, split.question),
        // The work this blocks, BY NAME (A3).
        blocks: taskTitle({ outcome: decision?.taskOutcome, taskId: decision?.taskId }),
        recommendation: text(decision?.recommendation, ""),
        options: list(decision?.options).map((o) => String(o)).filter(Boolean),
        since: text(decision?.requestedAt, ""),
        risk: text(decision?.risk, ""),
        // Kept, not deleted — folded behind "Show technical detail".
        technical: technicalOf(raw, split.why),
      };
    })
    .filter((decision) => decision.id !== "");
}

// A headline the founder can scan, without losing a word of the original.
//
// Not every decision arrives with a crafted question. A recovery escalation
// writes its whole prose summary into the field — 558 characters of dispatch
// ids and redacted paths in the live mirror — and rendering that as an <h3>
// turned the card into a wall of bold text that is harder to read than the raw
// JSON. So: clamp the headline at a sentence boundary where there is one, and
// push the remainder into the detail line that sits under it.
const HEADLINE_MAX = 120;

export function splitQuestion(question, why) {
  if (question.length <= HEADLINE_MAX) return { question, why };

  // Prefer a real sentence break inside the budget; fall back to a word break.
  const window = question.slice(0, HEADLINE_MAX + 40);
  const sentence = window.search(/[.?!]\s/);
  const cut = sentence > 40 && sentence <= HEADLINE_MAX + 20
    ? sentence + 1
    : (window.lastIndexOf(" ", HEADLINE_MAX) > 40 ? window.lastIndexOf(" ", HEADLINE_MAX) : HEADLINE_MAX);

  const head = question.slice(0, cut).trim();
  const rest = question.slice(cut).trim();
  return {
    question: /[.?!]$/.test(head) ? head : `${head}…`,
    // Nothing is discarded: the remainder leads the detail line.
    why: rest && why ? `${rest} — ${why}` : rest || why,
  };
}

// Machine prose that must never be a headline (A4). These are the shapes that
// turned a decision card into a wall of dispatch ids: session keys, evidence
// paths, gateway diagnostics, and the stack-trace-ish tail of a recovery error.
const MACHINE = [
  /\bsession [a-z-]*:?[a-z0-9:-]*factory-[a-z0-9-]+/gi,
  /\bevidence\/[\w./-]+/gi,
  /\bagent:[a-z-]+:[a-z0-9-]+/gi,
  /\bobj-[0-9a-f]{6,}[a-z0-9-]*/gi,
  /\btask-[0-9a-f]{6,}/gi,
  /`[^`]+`/g,
];

/** Strip machine shapes and keep the first plain sentence or two. */
function plainOf(text, max = 240) {
  let out = String(text || "");
  for (const re of MACHINE) out = out.replace(re, "");
  out = out.replace(/\(\s*[;,.]?\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/\s+([.;,])/g, "$1").trim();
  out = out.replace(/^[;:,.\s-]+/, "").trim();
  if (out.length <= max) return out;
  const cut = out.lastIndexOf(" ", max);
  return `${out.slice(0, cut > 40 ? cut : max)}…`;
}

/**
 * A question a person can answer, as the card's title.
 *
 * A recovery escalation writes its whole prose summary into this field. Leading
 * with that is what made the card unreadable, so the machine shapes come out
 * and, when nothing human survives, the card says what it actually is instead
 * of showing the wreckage.
 */
export function plainQuestion(question) {
  const cleaned = plainOf(question, 150);
  if (cleaned.length >= 25) return cleaned;
  return "The factory needs a decision before it can continue.";
}

/** One or two sentences of context, never repeating the title. */
export function plainContext(why, question) {
  const cleaned = plainOf(why, 260);
  if (!cleaned || cleaned === plainOf(question, 260)) return "";
  return cleaned;
}

/** Everything technical, preserved verbatim for the fold. */
export function technicalOf(...parts) {
  const text = parts.map((p) => String(p || "").trim()).filter(Boolean).join("\n\n").trim();
  return text || "";
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
        id: text(task?.taskId, ""),
        title: taskTitle({ outcome: task?.outcome, taskId: task?.taskId }),
        status,
        stage: task?.stage || null,
        // "Failed before it started" instead of "failed at —".
        outcomeLine: taskOutcomeLine({ status, stage: task?.stage || null }),
        since: text(task?.updatedAt, ""),
      });
    }
    for (const objective of list(panels.operations.objectives)) {
      if (objective?.healthy !== false) continue;
      const findings = list(objective.findings);
      out.push({
        kind: "objective",
        id: text(objective?.objectiveId, ""),
        title: taskTitle({ outcome: objective?.objective, taskId: objective?.objectiveId }),
        status: "unhealthy",
        stage: null,
        outcomeLine: "Objective needs attention",
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
  //
  // Read from operations first, then budgets. This used to be a workaround:
  // `budgets.available` goes false for an ordinary warning — two unpriced
  // events is enough — and `unavailable()` treated that as a dead panel, which
  // rendered a real $0.09 as "$0.00 spend to date". That was patched here,
  // at one call site, while eight other builders carried the same conflation.
  //
  // `unavailable()` no longer confuses "recorded a warning" with "has no
  // data", so this fallback is no longer load-bearing. It stays because the
  // two panels carry identical totals and preferring the one that is up is
  // still the right order to read them in.
  const totals = ops?.costs?.totals || budgets?.totals || null;
  const micros = num(totals?.costMicros, 0);
  const unpriced = num(totals?.unpricedEvents, 0);
  const events = num(totals?.events, 0);

  return {
    running: num(ops?.summary?.activeRuns, 0),
    tasks: num(ops?.summary?.tasks, 0),
    blocked: num(ops?.summary?.blockedRuns, 0),
    projects: num(company?.summary?.projects, 0),
    spendLabel: money(micros),
    unpricedEvents: unpriced,
    // Name the window precisely rather than implying "today".
    //
    // The ledger has no per-day bucket, so this is everything it has ever
    // recorded — and saying "today" would be a lie the page cannot detect. It
    // also says when it is incomplete: an unpriced event is usage with no rate
    // in factory/pricing.json, and reporting it as free is how $128 of work
    // read as $0.09.
    spendWindow: events ? `across all ${events} recorded runs` : "no runs recorded yet",
    spendComplete: unpriced === 0,
  };
}

const FINISHED = new Set(["merged", "complete", "completed", "merge-ready"]);

/**
 * What finished recently, newest first.
 *
 * Its absence is what cost five days: PRs #2-#5 merged to main and nothing on
 * any founder-facing surface said so. A console that only shows problems tells
 * you the factory is broken and never that it delivered.
 */
export function homeFinished(panels, { limit = 6 } = {}) {
  if (unavailable(panels?.operations)) return [];
  const costByTask = panels.operations.costs?.byTask || {};
  return list(panels.operations.tasks)
    .filter((task) => FINISHED.has(String(task?.status || "").toLowerCase()))
    .map((task) => ({
      id: text(task?.taskId, ""),
      title: taskTitle({ outcome: task?.outcome, taskId: task?.taskId }),
      project: text(task?.projectId, ""),
      status: String(task?.status || ""),
      finishedAt: text(task?.updatedAt, ""),
      cost: costByTask[task?.taskId] || null,
      prUrl: text(task?.prUrl, "") || null,
      previewUrl: text(task?.previewUrl, "") || null,
    }))
    .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))
    .slice(0, limit);
}

/**
 * Everything the factory has done, in time order, with which agent and when.
 *
 * The data has been published all along — 200 records, each carrying an actor —
 * and the console rendered none of it. This is the view that exists on the
 * local dashboard and had no equivalent here.
 */
export function homeActivity(panels, { limit = 60 } = {}) {
  if (unavailable(panels?.company)) return [];
  return list(panels.company.activityFeed).slice(0, limit).map((event) => ({
    at: text(event?.at, ""),
    verb: eventLine(event),
    actor: text(event?.actor, ""),
    stage: event?.stage ? stageLabel(event.stage) : "",
    taskId: text(event?.taskId, ""),
    title: taskTitle({ outcome: event?.objective, taskId: event?.taskId }),
    project: text(event?.project, ""),
  }));
}

/**
 * Is the machine healthy?
 *
 * Item 8 of the founder's list, and the half that was missing: cost was on
 * this page and correct, health was not on it at all. `/api/system/readiness`
 * existed, worked, and had no surface on either screen — so the 2026-09-14
 * outage was noticed by a founder feeling that something was wrong.
 *
 * A check this process could not run is `unknown`, never a failure. Reporting
 * "pm2 is not reachable" as an outage would teach the founder to ignore this
 * panel, which is the one outcome worse than not having it.
 */
export function homeHealth(panels) {
  const readiness = panels?.readiness;
  if (unavailable(readiness)) {
    return { available: false, status: "unknown", line: "Machine health was not published in this snapshot.", checks: [], warnings: [] };
  }
  const order = { fail: 0, warn: 1, degraded: 2, unknown: 3, ok: 4 };
  const checks = Object.entries(readiness.checks || {})
    .map(([key, check]) => ({
      key,
      name: CHECK_NAMES[key] || key,
      status: text(check?.status, "unknown"),
      detail: text(check?.detail, ""),
    }))
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.name.localeCompare(b.name));
  const status = text(readiness.status, "unknown");
  const bad = checks.filter((check) => check.status === "fail" || check.status === "warn");
  return {
    available: true,
    status,
    checks,
    warnings: list(readiness.warnings).map((warning) => text(warning, "")).filter(Boolean),
    // One line the founder reads without opening anything.
    line: status === "ok"
      ? "The machine is healthy."
      : bad.length
        ? bad.map((check) => `${check.name}: ${check.detail}`).join(" · ")
        : "Some checks could not be run on the machine.",
  };
}

// Human names, because a key is not a name. `stateStores` is the thing that
// reached 399 GiB; "State stores" is what the founder calls it.
const CHECK_NAMES = {
  disk: "Disk",
  stateStores: "State stores",
  services: "Services",
  gateway: "Gateway",
};

export function homeModel(snapshot, now = Date.now()) {
  const panels = snapshot?.panels || {};
  const decisions = homeDecisions(panels);
  const attention = homeAttention(panels);
  const health = homeHealth(panels);
  return {
    age: ageLine(snapshot?.publishedAt, now),
    decisions,
    attention,
    pulse: homePulse(panels),
    finished: homeFinished(panels),
    activity: homeActivity(panels),
    activityTotal: unavailable(panels?.company) ? 0 : list(panels.company.activityFeed).length,
    health,
    // "Nothing needs you right now" is a lie on a machine that is failing a
    // check. A degraded machine is something that needs the founder, even
    // when the task queue is quiet.
    calm: decisions.length === 0 && attention.length === 0 && health.status !== "fail" && health.status !== "warn",
  };
}

// ─── render ──────────────────────────────────────────────────────────────────

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = String(textContent);
  return node;
}

// Health reads as one line when the machine is fine and opens to the checks
// when it is not — the founder should not have to expand anything to learn
// that nothing is wrong, and should not have to hunt when something is.
function healthBlock(health) {
  const tone = health.status === "fail" ? " home-health--fail"
    : health.status === "warn" ? " home-health--warn"
      : health.status === "ok" ? " home-health--ok" : " home-health--unknown";
  const box = el("details", `home-health${tone}`);
  box.open = health.status === "fail" || health.status === "warn";

  const head = el("summary", "home-health-head");
  head.append(el("span", "home-health-dot"));
  const label = health.status === "ok" ? "Machine healthy"
    : health.status === "fail" ? "Machine needs attention"
      : health.status === "warn" ? "Machine has a warning"
        : "Machine health unknown";
  head.append(el("strong", null, label));
  head.append(el("span", "home-meta", health.line));
  box.append(head);

  if (!health.available) {
    box.append(el("p", "home-meta home-meta--dim",
      "The machine did not publish a health report in this snapshot, so this says nothing about whether it is healthy."));
    return box;
  }

  const rows = el("ul", "home-health-list");
  for (const check of health.checks) {
    const row = el("li", `home-health-row home-health-row--${check.status}`);
    row.append(el("span", "home-health-name", check.name));
    row.append(el("span", "home-health-status", check.status));
    if (check.detail) row.append(el("span", "home-meta", check.detail));
    rows.append(row);
  }
  box.append(rows);
  return box;
}

function decisionCard(decision, onAnswer, intentState) {
  const card = el("article", "home-card home-card--decision");

  const head = el("div", "home-card-head");
  head.append(el("span", "home-chip home-chip--decision", "Needs you"));
  if (decision.project) head.append(el("span", "home-meta", decision.project));
  if (decision.risk === "high") head.append(el("span", "home-chip home-chip--risk", "high risk"));
  card.append(head);

  // 1. the question, in plain language
  card.append(el("h3", "home-question", decision.question));
  // 2. context: what the work was, what went wrong
  if (decision.context) card.append(el("p", "home-why", decision.context));
  // 3. what it blocks, by name
  if (decision.blocks && decision.blocks !== "Untitled task") {
    const blocks = el("p", "home-blocks");
    blocks.append(el("span", "home-blocks-label", "Blocking: "));
    blocks.append(document.createTextNode(decision.blocks));
    card.append(blocks);
  }
  if (decision.recommendation) {
    const rec = el("p", "home-rec");
    rec.append(el("strong", null, "Recommended: "));
    rec.append(document.createTextNode(decision.recommendation));
    card.append(rec);
  }

  // 4. the options — or, once acted on, what became of the answer.
  //
  // No control may look actionable and do nothing: once an answer is sent the
  // options stop being buttons, because pressing one again cannot help.
  if (intentState) {
    card.append(intentStatus(intentState));
    if (decision.taskId) card.append(el("p", "home-id", decision.taskId));
    return card;
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

  // 5. everything technical, kept but folded away, closed by default
  if (decision.technical) {
    const fold = el("details", "home-technical");
    fold.append(el("summary", null, "Show technical detail"));
    fold.append(el("pre", "home-pre", decision.technical));
    card.append(fold);
  }

  // The id is for copying, never the name.
  if (decision.taskId) card.append(el("p", "home-id", decision.taskId));
  return card;
}

/**
 * What became of an answer, stated honestly.
 *
 * The machine polls on its own cadence and this page only changes when a new
 * snapshot is published, so "sent" is never reported as "done". Naming the
 * staleness is the difference between a page that is waiting and a page that
 * looks broken.
 */
export function intentStatus(state) {
  const box = el("div", `home-intent home-intent--${state.state}`);
  if (state.state === "queued") {
    box.append(el("strong", null, "Sending…"));
    return box;
  }
  if (state.state === "waiting") {
    box.append(el("strong", null, "Sent. Waiting for the machine."));
    box.append(el("p", null,
      "The factory machine picks up queued work about every 30 seconds, and this page changes when it next publishes. "
      + "Nothing has been applied until this says so."));
    return box;
  }
  if (state.state === "slow") {
    box.append(el("strong", null, "Still waiting."));
    box.append(el("p", null, "The machine has not reported back yet. It may be offline — the page is not stuck."));
    return box;
  }
  if (state.state === "done") {
    box.append(el("strong", null, "Done."));
    if (state.detail) box.append(el("p", null, state.detail));
    return box;
  }
  box.append(el("strong", null, "That did not work."));
  box.append(el("p", null, state.detail || "The machine refused it and gave no reason."));
  return box;
}

function attentionRow(item) {
  const row = el("li", "home-row");
  const tone = item.status === "failed" || item.status === "unhealthy" ? "bad" : "warn";
  row.append(el("span", `home-dot home-dot--${tone}`));
  const body = el("div", "home-row-body");
  // The one-line outcome is the title; the id goes underneath, muted, for
  // copying. A slug is a fallback, never the answer (A3).
  body.append(el("div", "home-row-title", item.title));
  body.append(el("div", "home-meta", item.detail ? item.detail : item.outcomeLine));
  if (item.id && item.id !== item.title) body.append(el("div", "home-id", item.id));
  row.append(body);
  return row;
}

function activityRow(event) {
  const row = el("li", "home-feed-row");
  row.append(el("time", "home-feed-when", agoLabel(event.at) || "—"));
  const body = el("div", "home-feed-body");
  const line = el("div", "home-feed-line");
  if (event.actor) line.append(el("span", "home-chip home-chip--muted", event.actor));
  line.append(document.createTextNode(` ${event.verb}${event.stage ? ` · ${event.stage}` : ""}`));
  body.append(line);
  body.append(el("div", "home-meta", event.title));
  row.append(body);
  return row;
}

function finishedRow(item) {
  const row = el("li", "home-row home-row--done");
  row.append(el("span", "home-dot home-dot--good"));
  const body = el("div", "home-row-body");
  body.append(el("div", "home-row-title", item.title));

  const bits = [];
  if (item.project) bits.push(item.project);
  if (item.finishedAt) bits.push(agoLabel(item.finishedAt));
  if (item.cost && item.cost.costMicros != null) bits.push(money(item.cost.costMicros));
  body.append(el("div", "home-meta", bits.join(" · ") || "delivered"));

  if (item.prUrl || item.previewUrl) {
    const links = el("div", "home-links");
    if (item.prUrl) links.append(link(item.prUrl, "Pull request ↗"));
    if (item.previewUrl) links.append(link(item.previewUrl, "Preview ↗"));
    body.append(links);
  }
  if (item.id) body.append(el("div", "home-id", item.id));
  row.append(body);
  return row;
}

function link(href, label) {
  const a = el("a", "home-link", label);
  a.href = href;
  a.target = "_blank";
  a.rel = "noreferrer";
  return a;
}

function agoLabel(at) {
  const then = Date.parse(at);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/**
 * Draw Home into `root`. `onAnswer(decision, choice, button)` is called when the
 * founder picks an option; it is the caller's job to queue the intent and to be
 * honest that queueing is not the same as done.
 */
export function renderHome(root, snapshot, { onAnswer = () => {}, intentStateFor = () => null, commandCenter = null, now = Date.now() } = {}) {
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

  root.append(healthBlock(model.health));

  // Starting work is the first thing the founder does here, so it sits above
  // every read-only section below. It stays UNDER the freshness and health
  // rail, which is the one thing that must never move off the top: acting on a
  // stale page is the failure this page was rebuilt to prevent.
  //
  // Injected rather than imported. command-center.mjs imports `intentStatus`
  // from this module, and importing it back would make the two circular.
  if (commandCenter) {
    try { commandCenter(root, model); } catch { /* the launcher must never take Home down */ }
  }

  if (model.calm) {
    root.append(el("p", "home-calm", "Nothing needs you right now."));
  }

  if (model.decisions.length) {
    root.append(el("h2", "home-heading", model.decisions.length === 1 ? "1 decision needs you" : `${model.decisions.length} decisions need you`));
    const wrap = el("div", "home-cards");
    for (const decision of model.decisions) wrap.append(decisionCard(decision, onAnswer, intentStateFor(`decision:${decision.id}`)));
    root.append(wrap);
  }

  if (model.attention.length) {
    root.append(el("h2", "home-heading", model.attention.length === 1 ? "1 thing is stuck" : `${model.attention.length} things are stuck`));
    const listEl = el("ul", "home-list");
    for (const item of model.attention) listEl.append(attentionRow(item));
    root.append(listEl);
  }

  // What finished recently. Its absence is what cost five days.
  root.append(el("h2", "home-heading", "What finished recently"));
  if (model.finished.length) {
    const done = el("ul", "home-list");
    for (const item of model.finished) done.append(finishedRow(item));
    root.append(done);
  } else {
    root.append(el("p", "home-calm home-calm--small", "Nothing has finished yet."));
  }

  // What the factory has done. The local dashboard has had this all along and
  // the console had no version of it.
  if (model.activity.length) {
    root.append(el("h2", "home-heading", "What the factory has done"));
    root.append(el("p", "home-meta home-meta--dim",
      `the most recent ${model.activity.length} of ${model.activityTotal} published events, newest first`));
    const feed = el("ol", "home-feed");
    for (const event of model.activity) feed.append(activityRow(event));
    root.append(feed);
  }

  const p = model.pulse;
  const pulse = el("p", "home-pulse");
  pulse.textContent =
    `${p.running} running of ${p.tasks} tasks across ${p.projects} project${p.projects === 1 ? "" : "s"}` +
    ` · ${p.spendLabel} ${p.spendWindow}` +
    (p.spendComplete ? "" : ` · ${p.unpricedEvents} run${p.unpricedEvents === 1 ? "" : "s"} have no price yet, so this is a floor`);
  root.append(pulse);

  return model;
}
