// The control plane's client: sign in, then draw the mirror.
//
// The server is the authority on access. Nothing here decides whether a viewer
// is allowed in — it asks /api/session and draws what it is told, because a
// client that could grant itself the view would put the gate in the wrong place
// (DC-2026-004 puts the check at one boundary, and that boundary is on the
// server).
//
// Rendering logic lives in render.mjs as pure functions over the snapshot, so
// the part that can actually be wrong is testable without a browser. This file
// is the DOM and the fetching.

import { answerableDecisions, freshness, intentsPanel, panelsFor, statsFrom } from "/render.mjs";
import { renderHome } from "/home.mjs";
import { renderAgents, renderBoard, renderDeliveries, renderNext, renderProjects } from "/views.mjs";
import { renderMoney } from "/money.mjs";
import { renderCommandCenter } from "/command-center.mjs";
import { renderTaskDetail } from "/task-detail.mjs";

const TIMEOUT_MS = 12_000;

// Slower than the 30s publish interval on purpose: a viewer does not need to
// see every publish, and a tab left open overnight should not spend the day
// polling.
const POLL_MS = 60_000;

const els = {
  signin: document.getElementById("signin"),
  signinForm: document.getElementById("signin-form"),
  signinError: document.getElementById("signin-error"),
  signinSubmit: document.getElementById("signin-submit"),
  password: document.getElementById("password"),
  signOut: document.getElementById("sign-out"),
  refresh: document.getElementById("refresh"),
  freshness: document.getElementById("freshness"),
  state: document.getElementById("state"),
  eyebrow: document.getElementById("state-eyebrow"),
  title: document.getElementById("state-title"),
  body: document.getElementById("state-body"),
  mirror: document.getElementById("mirror"),
  home: document.getElementById("home"),
  tabs: document.getElementById("tabs"),
  view: document.getElementById("view"),
  sheet: document.getElementById("sheet"),
  sheetBody: document.getElementById("sheet-body"),
  staleBanner: document.getElementById("stale-banner"),
  stats: document.getElementById("stats"),
  panels: document.getElementById("panels"),
};

let timer = null;

async function request(url, options = {}) {
  const abort = new AbortController();
  const id = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: abort.signal, cache: "no-store" });
  } finally {
    clearTimeout(id);
  }
}

function view(which) {
  els.signin.hidden = which !== "signin";
  els.state.hidden = which !== "state";
  els.mirror.hidden = which !== "mirror";
  const authed = which !== "signin";
  els.signOut.hidden = !authed;
  els.refresh.hidden = which !== "mirror";
  els.freshness.hidden = which !== "mirror";
}

function showSignIn(message) {
  stopPolling();
  view("signin");
  els.signinError.hidden = !message;
  if (message) els.signinError.textContent = message;
  els.password.focus();
}

function showState({ eyebrow, title, body }) {
  view("state");
  els.eyebrow.textContent = eyebrow;
  els.title.textContent = title;
  els.body.textContent = body;
}

// textContent everywhere, never innerHTML. The snapshot is company data that
// passed through a redactor, not a sanitiser — it is not HTML and must never be
// parsed as any.
function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

function renderStats(stats) {
  els.stats.replaceChildren();
  for (const stat of stats) {
    const card = el("div", stat.attention ? "stat attention" : "stat");
    card.append(el("strong", null, stat.value), el("span", null, stat.label));
    if (stat.sub) card.append(el("small", null, stat.sub));
    els.stats.append(card);
  }
}

// Only https, and only what the browser itself agrees is a URL. This exists so
// `javascript:`, `data:` and friends can never arrive as a row field and be
// handed to an anchor.
function safeHref(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderPanels(panels) {
  els.panels.replaceChildren();
  for (const panel of panels) {
    const card = el("section", panel.unknown ? "panel unknown" : "panel");
    card.append(el("h2", null, panel.title));
    if (panel.note) card.append(el("p", "panel-note", panel.note));

    for (const row of panel.rows) {
      const line = el("div", `row tone-${row.tone || "muted"}`);
      const main = el("div", "row-main");
      const href = safeHref(row.link);
      if (href) {
        // The one place a row becomes a link: the address of the machine this
        // page reports on. Everything here comes from a published snapshot, so
        // the scheme is checked rather than trusted — a row is data, and data
        // does not get to choose a URL scheme.
        const anchor = el("a", "row-link", row.primary);
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        main.append(anchor);
      } else {
        main.append(el("strong", null, row.primary));
      }
      if (row.secondary) main.append(el("span", null, row.secondary));
      line.append(main);
      if (row.meta) line.append(el("em", "row-meta", row.meta));
      card.append(line);
    }

    els.panels.append(card);
  }
}

// Asking is not doing. The button reports that the request was QUEUED, because
// the machine executes it on its next poll — up to one interval later. Saying
// "done" here would be the one lie this topology makes easy to tell.
// What the founder asked for, and what became of it.
//
// Keyed by the thing acted on, not by intent id, so a card can find its own
// pending state on every re-render. This is module state rather than DOM state
// because Home re-renders wholesale on each publish, and a label written onto a
// button is erased by the next paint — which is exactly what "I clicked and
// nothing happened" was: a 4-second "Queued" that reverted, on a card that
// never changed.
const pendingIntents = new Map();

export function intentStateFor(key) {
  return pendingIntents.get(key) || null;
}

async function submitIntent(kind, args, button, key = null) {
  const track = key || `${kind}:${JSON.stringify(args)}`;
  // One click, one intent. Two identical decision.resolve intents were enqueued
  // 239ms apart on 2026-09-15 and both failed; a second press must not queue a
  // second request.
  if (pendingIntents.get(track)?.state === "queued") return;

  pendingIntents.set(track, { state: "queued", kind, at: Date.now(), detail: null });
  if (button) { button.disabled = true; button.textContent = "Sending…"; }
  redrawHome();

  try {
    const response = await request("/api/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, args }),
    });
    if (response.status === 401) { pendingIntents.delete(track); return showSignIn("That session has expired. Sign in again."); }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      pendingIntents.set(track, { state: "failed", kind, at: Date.now(), detail: body?.error || `the control plane answered ${response.status}` });
      redrawHome();
      return;
    }
    const body = await response.json().catch(() => ({}));
    pendingIntents.set(track, { state: "waiting", kind, at: Date.now(), id: body?.id || null, detail: null });
    redrawHome();
    watchIntent(track, body?.id);
  } catch {
    pendingIntents.set(track, { state: "failed", kind, at: Date.now(), detail: "the control plane could not be reached" });
    redrawHome();
  }
}

// Poll the queue for what the machine decided. The worker claims on its own
// cadence, so this is honest waiting rather than a fake success.
async function watchIntent(track, id) {
  if (!id) return;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    let results;
    try {
      const response = await request("/api/intents");
      if (!response.ok) continue;
      ({ results } = await response.json());
    } catch { continue; }
    const hit = (results || []).find((r) => r.id === id);
    if (!hit) continue;
    pendingIntents.set(track, {
      state: hit.status === "done" ? "done" : "failed",
      kind: hit.kind || null,
      at: Date.now(),
      detail: hit.detail || null,
    });
    redrawHome();
    if (hit.status === "done") await loadMirror();
    return;
  }
  const current = pendingIntents.get(track);
  if (current) pendingIntents.set(track, { ...current, state: "slow" });
  redrawHome();
}

function redrawHome() {
  if (lastSnapshot) {
    try { drawHome(lastSnapshot); } catch { /* a redraw must never take the page down */ }
  }
}


function renderDecisions(decisions) {
  if (!decisions.length) return null;
  const card = el("section", "panel");
  card.append(el("h2", null, "Decisions waiting on you"));

  for (const decision of decisions) {
    const block = el("div", "decision");
    block.append(el("strong", null, decision.question));
    if (decision.why) block.append(el("p", "decision-why", decision.why));
    if (decision.recommendation) {
      const rec = el("p", "decision-rec");
      rec.append(el("small", null, "The factory recommends"), document.createTextNode(decision.recommendation));
      block.append(rec);
    }

    const actions = el("div", "decision-actions");
    if (decision.freeText) {
      const input = el("input", "decision-input");
      input.type = "text";
      input.placeholder = "Your answer";
      const send = el("button", "btn-primary", "Send");
      send.addEventListener("click", () => {
        if (input.value.trim()) submitIntent("decision.resolve", { decisionId: decision.id, choice: input.value.trim() }, send);
      });
      actions.append(input, send);
    } else {
      for (const option of decision.options) {
        const button = el("button", "btn-option", option);
        button.addEventListener("click", () => submitIntent("decision.resolve", { decisionId: decision.id, choice: option }, button));
        actions.append(button);
      }
    }
    block.append(actions);
    card.append(block);
  }
  return card;
}

async function loadIntents() {
  try {
    const response = await request("/api/intents");
    if (!response.ok) return;
    const queue = await response.json();
    const panel = intentsPanel(queue);
    const existing = document.getElementById("intents-panel");
    const card = el("section", "panel");
    card.id = "intents-panel";
    card.append(el("h2", null, panel.title));
    if (panel.note) card.append(el("p", "panel-note", panel.note));
    for (const row of panel.rows) {
      const line = el("div", `row tone-${row.tone || "muted"}`);
      const main = el("div", "row-main");
      main.append(el("strong", null, row.primary));
      if (row.secondary) main.append(el("span", null, row.secondary));
      line.append(main, el("em", "row-meta", row.meta));
      card.append(line);
    }
    if (existing) existing.replaceWith(card);
    else els.panels.prepend(card);
  } catch {
    // The mirror is the point of this page; a queue that will not load must not
    // take the view down with it.
  }
}

// The last snapshot drawn, so a pending intent can repaint Home without
// refetching. Home is re-rendered wholesale, so anything written onto the DOM
// by a click is erased by the next paint unless it lives here.
let lastSnapshot = null;

// Which tab is showing, and any project the Board is narrowed to. Kept here so
// a publish repaints the current tab rather than throwing the founder back to
// Home every thirty seconds.
let activeTab = "today";
let boardProject = null;
// Held here, beside boardProject and for the same reason: a publish lands
// every thirty seconds and repaints the current tab, and a filter that reset
// itself on each one would be unusable.
let boardStalledOnly = false;

const TABS = [
  ["today", "Today"],
  ["board", "Board"],
  ["next", "Next"],
  ["deliveries", "Deliveries"],
  ["money", "Money"],
  ["projects", "Projects"],
  ["agents", "Agents"],
];

// Task detail, reachable from anywhere a task appears.
async function openTask(taskId) {
  if (!taskId) return;
  els.sheet.hidden = false;
  els.sheetBody.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "home-meta";
  loading.textContent = "Loading the execution record…";
  els.sheetBody.append(loading);
  try {
    const response = await request(`/api/task?id=${encodeURIComponent(taskId)}`);
    if (response.status === 404) {
      loading.textContent = "No detail has been published for this task yet.";
      return;
    }
    if (!response.ok) {
      loading.textContent = `The control plane answered ${response.status}.`;
      return;
    }
    renderTaskDetail(els.sheetBody, await response.json());
  } catch {
    loading.textContent = "The control plane could not be reached.";
  }
}

function closeTask() {
  els.sheet.hidden = true;
  els.sheetBody.replaceChildren();
}

function drawTabs() {
  els.tabs.replaceChildren();
  for (const [id, label] of TABS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tab${id === activeTab ? " tab--active" : ""}`;
    button.textContent = label;
    button.addEventListener("click", () => {
      activeTab = id;
      if (id !== "board") { boardProject = null; boardStalledOnly = false; }
      if (lastSnapshot) drawHome(lastSnapshot);
    });
    els.tabs.append(button);
  }
}

function drawHome(snapshot) {
  lastSnapshot = snapshot;
  drawTabs();

  const onTab = activeTab !== "today";
  els.home.hidden = onTab;
  els.view.hidden = !onTab;
  if (onTab) {
    if (activeTab === "board") {
      renderBoard(els.view, snapshot, {
        project: boardProject,
        onTask: openTask,
        stalledOnly: boardStalledOnly,
        onStalledOnly: (value) => { boardStalledOnly = value; drawHome(snapshot); },
      });
    } else if (activeTab === "projects") {
      renderProjects(els.view, snapshot, {
        onProject: (key) => { boardProject = key; activeTab = "board"; drawHome(snapshot); },
      });
    } else if (activeTab === "agents") {
      renderAgents(els.view, snapshot);
    } else if (activeTab === "money") {
      renderMoney(els.view, snapshot);
    } else if (activeTab === "deliveries") {
      renderDeliveries(els.view, snapshot, { onTask: openTask });
    } else if (activeTab === "next") {
      // Two choices, never an automatic start. `objective.start` and
      // `overnight.add` are both wired, so both buttons can actually complete —
      // which is what removed the `onAccept: null` that used to sit here.
      renderNext(els.view, snapshot, {
        intentStateFor,
        onStart: (proposal, button, key) => submitIntent(
          "objective.start",
          { objective: proposal.title, projectId: proposal.projectId },
          button, key,
        ),
        onQueue: (proposal, button, key) => submitIntent(
          "overnight.add",
          { objective: proposal.title, projectId: proposal.projectId },
          button, key,
        ),
      });
    }
    return;
  }

  renderHome(els.home, snapshot, {
    intentStateFor,
    onAnswer: (decision, choice, button) =>
      submitIntent("decision.resolve", { decisionId: decision.id, choice }, button, `decision:${decision.id}`),
    // Every handler here maps to a kind wired in scripts/hq-intents.mjs. A
    // handler passed for an unwired kind would draw a button that cannot work,
    // so this list and that file's handler map are the same list.
    commandCenter: (root) => renderCommandCenter(root, snapshot, {
      intentStateFor,
      onStart: (args, button, key) => submitIntent("objective.start", args, button, key),
      onAsk: (args, button, key) => submitIntent("question.ask", args, button, key),
      onOvernightAdd: (args, button, key) => submitIntent("overnight.add", args, button, key),
      onOvernightRemove: (args, button, key) => submitIntent("overnight.remove", args, button, key),
      onOvernightStart: (args, button, key) => submitIntent("overnight.start", args, button, key),
      onOvernightStop: (args, button, key) => submitIntent("overnight.stop", args, button, key),
    }),
  });
}

function renderMirror(snapshot) {
  const age = freshness(snapshot?.publishedAt);
  view("mirror");

  els.freshness.textContent = `published ${age.label}`;
  els.freshness.className = age.stale ? "freshness stale" : "freshness";

  // Rule 2: never let a number read as live when it is not.
  els.staleBanner.hidden = !age.stale;
  if (age.stale) {
    els.staleBanner.textContent = age.unknown
      ? "This snapshot does not say when it was published. Treat everything below as of unknown age."
      : `This snapshot is ${age.label}. The factory machine may be offline, or the publisher stopped — everything below is as of then, not now.`;
  }

  // Home first, and on its own terms. Everything the other four views will
  // eventually show stays below it, so nothing is lost while Home is the only
  // view that has been designed.
  drawHome(snapshot);

  renderStats(statsFrom(snapshot?.panels));
  renderPanels(panelsFor(snapshot));

  const decisions = renderDecisions(answerableDecisions(snapshot?.panels || {}));
  if (decisions) els.panels.prepend(decisions);
  loadIntents();
}

async function loadMirror() {
  let response;
  try {
    response = await request("/api/mirror");
  } catch {
    showState({
      eyebrow: "Offline",
      title: "The control plane could not be reached.",
      body: "Headquarters itself is unaffected — it runs on the factory machine and this view is a mirror of it.",
    });
    return;
  }

  if (response.status === 401) return showSignIn("That session has expired. Sign in again.");

  if (response.status === 404) {
    return showState({
      eyebrow: "Waiting for first publish",
      title: "No snapshot has been published yet.",
      body: "The control plane is reachable and the store is empty. The factory machine has not published a projection yet.",
    });
  }

  if (!response.ok) {
    return showState({
      eyebrow: "Store unreachable",
      title: "The snapshot store did not answer.",
      body: `The store responded with ${response.status}. This view is a mirror; the factory is unaffected.`,
    });
  }

  let snapshot;
  try {
    snapshot = await response.json();
  } catch {
    return showState({
      eyebrow: "Unreadable",
      title: "The snapshot could not be read.",
      body: "Treat this view as stale until the next publish succeeds.",
    });
  }

  try {
    renderMirror(snapshot);
  } catch (error) {
    // A whole-page render failure still has to say something true.
    showState({
      eyebrow: "Render failed",
      title: "This snapshot could not be displayed.",
      body: `${String(error?.message || error).slice(0, 160)} — the data is stored and intact; only this view failed.`,
    });
  }
}

function startPolling() {
  stopPolling();
  timer = setInterval(loadMirror, POLL_MS);
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

els.signinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  els.signinSubmit.disabled = true;
  els.signinError.hidden = true;
  try {
    const response = await request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: els.password.value }),
    });
    if (response.ok) {
      els.password.value = "";
      await loadMirror();
      startPolling();
      return;
    }
    // 503 is the control plane saying a credential is not configured on the
    // SERVER. Reporting that as "that password was not accepted" sends the
    // founder hunting for a typo in a password that was never going to be
    // checked. Say what is actually wrong.
    showSignIn(
      response.status === 503
        ? "This deployment is missing HQ_VIEW_PASSWORD or HQ_SESSION_SECRET. Nothing typed here can work until they are set."
        : response.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "That password was not accepted.",
    );
  } catch {
    showSignIn("Could not reach the control plane.");
  } finally {
    els.signinSubmit.disabled = false;
  }
});

els.signOut.addEventListener("click", async () => {
  try {
    await request("/api/session", { method: "DELETE" });
  } catch {
    // Best effort: the view resets either way, and an orphaned cookie grants
    // nothing on its own.
  }
  showSignIn();
});

els.refresh.addEventListener("click", () => loadMirror());
els.sheet.addEventListener("click", (event) => { if (event.target.dataset.sheetClose) closeTask(); });
document.getElementById("sheet-close").addEventListener("click", closeTask);
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !els.sheet.hidden) closeTask(); });

async function main() {
  try {
    const response = await request("/api/session");
    // The same defect on the boot path: an unconfigured deployment answered 503
    // and fell through to the sign-in form, making a server misconfiguration
    // indistinguishable from "please log in".
    if (response.status === 503) {
      return showState({
        eyebrow: "Not configured",
        title: "This deployment is missing a credential.",
        body: "HQ_VIEW_PASSWORD and HQ_SESSION_SECRET must be set on the deployment before anyone can sign in. The factory machine is unaffected.",
      });
    }
    const { authenticated } = await response.json();
    if (authenticated) {
      await loadMirror();
      startPolling();
      return;
    }
  } catch {
    // Unknown is never treated as allowed.
  }
  showSignIn();
}

main();
