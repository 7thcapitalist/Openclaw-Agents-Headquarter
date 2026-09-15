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

function renderPanels(panels) {
  els.panels.replaceChildren();
  for (const panel of panels) {
    const card = el("section", panel.unknown ? "panel unknown" : "panel");
    card.append(el("h2", null, panel.title));
    if (panel.note) card.append(el("p", "panel-note", panel.note));

    for (const row of panel.rows) {
      const line = el("div", `row tone-${row.tone || "muted"}`);
      const main = el("div", "row-main");
      main.append(el("strong", null, row.primary));
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
async function submitIntent(kind, args, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Queueing…";
  try {
    const response = await request("/api/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, args }),
    });
    if (response.status === 401) return showSignIn("That session has expired. Sign in again.");
    button.textContent = response.ok ? "Queued" : "Could not queue";
    if (response.ok) await loadIntents();
  } catch {
    button.textContent = "Could not queue";
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = original;
    }, 4000);
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
  renderHome(els.home, snapshot, {
    onAnswer: (decision, choice, button) =>
      submitIntent("decision.resolve", { decisionId: decision.id, choice }, button),
  });

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
