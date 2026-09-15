// Launch: hand the factory work, from a phone, now or tonight.
//
// This is the only screen on the console that spends money, so it is built
// around one rule the others do not need:
//
//     NOTHING IS ENQUEUED UNTIL THE FOUNDER HAS READ BACK WHAT WILL RUN.
//
// Pressing "Start it now" does not start anything. It shows the project by
// name and the objective as typed, says plainly what pressing again will do,
// and waits. That step is not a nicety: an objective started by mistake runs
// unattended for hours against a real repository and a real bill, and the
// founder is on a phone where a mis-tap is easy.
//
// The second rule is inherited from the rest of the console: the queued state
// is honest. "Sent" means an intent is on the queue, not that anything ran.
// The machine polls, claims, executes and reports back, and this page says so
// in those words until it hears otherwise. There is no optimistic success.
//
// An intent names an action and never carries a command — the project is a
// key from a published list, the objective is bounded text, and neither ever
// becomes a path or a shell string. See factory/lib/integrations/intent-protocol.mjs.

import { list, text, unavailable } from "./render.mjs";
import { intentStatus } from "./home.mjs";

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = String(textContent);
  return node;
}

// ─── model ───────────────────────────────────────────────────────────────────

const ITEM_STATUS = {
  queued: "waiting for tonight",
  running: "running now",
  complete: "finished",
  failed: "stopped before delivery",
};

export function launchModel(snapshot) {
  const panel = snapshot?.panels?.launch;
  if (unavailable(panel)) {
    return {
      available: false,
      projects: [],
      overnight: { status: "idle", items: [], limit: 8 },
      maxObjectiveLength: 1000,
      reason: text(panel?.reason, "The machine has not published what it can be handed yet."),
    };
  }
  return {
    available: true,
    maxObjectiveLength: Number(panel.maxObjectiveLength) || 1000,
    projects: list(panel.projects).map((project) => ({
      key: text(project?.key, ""),
      name: text(project?.name, project?.key || "Untitled project"),
      // The factory itself is a legitimate target — it is how most of this
      // repository got built — but it is flagged so the picker can label it
      // the way the tunnel does and never default to it.
      isHeadquarters: project?.isHeadquarters === true,
      launchable: project?.launchable === true,
      blockedReason: project?.blockedReason || null,
    })).filter((project) => project.key),
    overnight: {
      status: text(panel?.overnight?.status, "idle"),
      limit: Number(panel?.overnight?.limit) || 8,
      currentItemId: panel?.overnight?.currentItemId || null,
      items: list(panel?.overnight?.items).map((item) => ({
        id: text(item?.id, ""),
        objective: text(item?.objective, ""),
        projectId: text(item?.projectId, ""),
        status: text(item?.status, "queued"),
        error: item?.error || null,
      })),
    },
    reason: null,
  };
}

// ─── render ──────────────────────────────────────────────────────────────────

// Kept across redraws so a publish landing mid-typing does not wipe the box.
// The console repaints on every snapshot, and losing a half-written objective
// to a background refresh is how a founder learns not to trust the page.
const draft = { objective: "", projectKey: null, confirming: null };

export function resetLaunchDraft() {
  draft.objective = "";
  draft.projectKey = null;
  draft.confirming = null;
}

export function renderLaunch(root, snapshot, { onIntent = () => {}, intentStateFor = () => null } = {}) {
  root.replaceChildren();
  const model = launchModel(snapshot);

  root.append(el("p", "view-lede", "Hand the factory work — now, or on tonight's plan."));

  if (!model.available) {
    root.append(el("p", "home-calm home-calm--small", model.reason));
    return model;
  }
  if (!model.projects.length) {
    root.append(el("p", "home-calm home-calm--small",
      "No project is registered that the factory can build in. Register one on the machine first."));
    return model;
  }

  // Default to the first ordinary project that can actually be launched into,
  // so the common case is one tap and some typing. The factory is never the
  // default even when it is the only launchable target: handing work to the
  // machine that runs the factory is always a deliberate choice.
  if (!draft.projectKey) {
    const preferred = model.projects.find((p) => p.launchable && !p.isHeadquarters)
      || model.projects.find((p) => !p.isHeadquarters)
      || model.projects[0];
    draft.projectKey = preferred.key;
  }

  root.append(composer(model, { onIntent, intentStateFor }));
  root.append(plan(model, { onIntent, intentStateFor }));
  return model;
}

function composer(model, { onIntent, intentStateFor }) {
  const box = el("section", "launch-box");

  // ── project picker
  box.append(el("h2", "home-heading", "Which project"));
  const picker = el("div", "launch-projects");
  for (const project of model.projects) {
    const chip = el("button", `launch-project${project.key === draft.projectKey ? " is-selected" : ""}${project.launchable ? "" : " is-blocked"}`);
    chip.type = "button";
    // The human name leads; the key is small and muted, for recognition only.
    // "(factory)" is the tunnel dashboard's own wording for the headquarters
    // entry — the same thing must be called the same thing on both surfaces.
    chip.append(el("strong", null, project.isHeadquarters ? `${project.name} (factory)` : project.name));
    chip.append(el("span", "home-id", project.key));
    if (!project.launchable) {
      // Shown, not hidden: "it is not there" and "it is paused" are different
      // problems, and a picker that silently drops a project the founder
      // expects sends them looking for a bug that is not there.
      chip.append(el("span", "launch-blocked", project.blockedReason));
      chip.disabled = true;
    } else {
      chip.addEventListener("click", () => {
        draft.projectKey = project.key;
        draft.confirming = null;
        rerender();
      });
    }
    picker.append(chip);
  }
  box.append(picker);

  const selected = model.projects.find((p) => p.key === draft.projectKey) || null;

  // ── the outcome box
  box.append(el("h2", "home-heading", "What do you want to be true"));
  const field = el("textarea", "launch-input");
  field.rows = 5;
  field.maxLength = model.maxObjectiveLength;
  field.placeholder = "Describe the outcome, not the implementation. The factory decides how.";
  field.value = draft.objective;
  field.setAttribute("aria-label", "The outcome you want");
  field.addEventListener("input", () => {
    draft.objective = field.value;
    counter.textContent = countLabel(field.value.length, model.maxObjectiveLength);
    // Any edit invalidates a confirmation: what was read back is no longer
    // what would run.
    if (draft.confirming) { draft.confirming = null; rerender(); }
  });
  box.append(field);

  const counter = el("p", "home-meta home-meta--dim", countLabel(draft.objective.length, model.maxObjectiveLength));
  box.append(counter);

  // ── the honest state of anything already sent
  const nowKey = `objective.start:${draft.projectKey}`;
  const nightKey = `overnight.add:${draft.projectKey}`;
  for (const key of [nowKey, nightKey]) {
    const state = intentStateFor(key);
    if (state) box.append(intentStatus(state));
  }

  if (!selected?.launchable) {
    box.append(el("p", "launch-blocked-note",
      `${selected?.name || "This project"} cannot be handed work right now — ${selected?.blockedReason || "it is unavailable"}.`));
    return box;
  }

  // A release confirmation belongs to the plan below, not to this box.
  if (draft.confirming && draft.confirming.when !== "release") {
    box.append(confirmation(draft.confirming, selected, model, { onIntent }));
    return box;
  }

  const actions = el("div", "launch-actions");
  actions.append(action("Start it now", "primary", () => ask("now")));
  actions.append(action("Add to tonight's plan", "secondary", () => ask("night")));
  box.append(actions);

  const queued = model.overnight.items.filter((i) => i.status === "queued").length;
  if (queued >= model.overnight.limit) {
    box.append(el("p", "launch-blocked-note",
      `Tonight's plan is full at ${model.overnight.limit}. Remove one below before adding more.`));
  }
  return box;

  function ask(when) {
    const objective = draft.objective.trim();
    if (!objective) {
      box.append(el("p", "launch-blocked-note", "Say what you want to be true first."));
      return;
    }
    draft.confirming = { when, objective };
    rerender();
  }
}

// The read-back. Project by name, objective verbatim, and what pressing again
// actually does — including, in as many words, that it spends money.
function confirmation(pending, project, model, { onIntent }) {
  if (pending.when === "release") return releaseConfirmation(model, { onIntent });
  return outcomeConfirmation({
    when: pending.when,
    objective: pending.objective,
    project,
    onConfirm: (kind, args, button, key) => {
      onIntent(kind, args, button, key);
      draft.confirming = null;
      draft.objective = "";
      rerender();
    },
    onCancel: () => { draft.confirming = null; rerender(); },
  });
}

/**
 * The read-back, as one component.
 *
 * Exported because the Next tab accepts a proposal into exactly this flow. A
 * second confirmation written beside this one is how the two screens would
 * come to warn about spending in different words, and the wording IS the
 * safeguard — it is the last thing between a mis-tap and hours of unattended
 * spend.
 *
 * `when` is "now" (start an objective) or "night" (join tonight's plan).
 * `onConfirm` receives the intent to enqueue rather than enqueuing it, so the
 * caller keeps ownership of its own draft state.
 */
export function outcomeConfirmation({ when, objective, project, onConfirm, onCancel }) {
  const now = when === "now";
  const card = el("section", `launch-confirm launch-confirm--${when}`);
  card.append(el("span", "launch-confirm-eyebrow", now ? "Start this now?" : "Add this to tonight?"));

  const line = el("p", "launch-confirm-line");
  line.append(document.createTextNode(now ? "The factory will start work on " : "Tonight the factory will work on "));
  line.append(el("strong", null, project.isHeadquarters ? `${project.name} (factory)` : project.name));
  line.append(document.createTextNode(project.isHeadquarters
    ? " — the machine this console runs on — trying to make this true:"
    : ", trying to make this true:"));
  card.append(line);

  // Verbatim, not summarised. The whole point is that the founder reads back
  // exactly what will run.
  card.append(el("blockquote", "launch-confirm-objective", objective));

  card.append(el("p", "launch-confirm-cost", now
    ? "This runs unattended and spends real money on model calls. It goes through the usual gates — high-risk work still stops for your signature."
    : "Nothing runs now. It joins tonight's plan, which you release yourself."));

  const actions = el("div", "launch-actions");
  const go = action(now ? "Yes, start it" : "Yes, plan it", "primary", () => {
    const kind = now ? "objective.start" : "overnight.add";
    onConfirm(kind, { objective, projectId: project.key }, go, `${kind}:${project.key}`);
  });
  actions.append(go);
  actions.append(action("Cancel", "secondary", () => onCancel()));
  card.append(actions);
  return card;
}

// Releasing the night spends real money unattended on work queued earlier, so
// it gets the same second press as starting an objective — and the read-back
// names every objective, because "8 queued" is a count, not a thing anyone has
// actually read.
function releaseConfirmation(model, { onIntent }) {
  const queued = model.overnight.items.filter((item) => item.status === "queued");
  const card = el("section", "launch-confirm launch-confirm--release");
  card.append(el("span", "launch-confirm-eyebrow", "Release tonight's plan?"));
  card.append(el("p", "launch-confirm-line",
    `The factory will work through ${queued.length} objective${queued.length === 1 ? "" : "s"}, one at a time, starting now:`));

  const listEl = el("ol", "launch-confirm-list");
  for (const item of queued) {
    const row = el("li");
    row.append(el("span", "launch-confirm-item", item.objective));
    row.append(el("span", "home-id", item.projectId));
    listEl.append(row);
  }
  card.append(listEl);

  card.append(el("p", "launch-confirm-cost",
    "This runs unattended and spends real money on model calls, for hours. Stopping later lets the objective in flight finish first — it does not kill it."));

  const actions = el("div", "launch-actions");
  const go = action("Yes, run tonight's plan", "primary", () => {
    onIntent("overnight.start", {}, go, "overnight.start");
    draft.confirming = null;
    rerender();
  });
  actions.append(go);
  actions.append(action("Cancel", "secondary", () => { draft.confirming = null; rerender(); }));
  card.append(actions);
  return card;
}

const RUN_STATUS = {
  running: "The overnight run is going now.",
  stopped: "The last run was stopped.",
  complete: "The last run finished everything on the plan.",
  "needs-attention": "The last run ended with something unfinished.",
};

function plan(model, { onIntent, intentStateFor }) {
  const section = el("section", "launch-plan");
  section.append(el("h2", "home-heading", "Tonight's plan"));

  const queued = model.overnight.items.filter((item) => item.status === "queued").length;
  const running = model.overnight.status === "running";
  const lede = RUN_STATUS[model.overnight.status];
  section.append(el("p", "home-meta home-meta--dim",
    `${lede ? `${lede} ` : ""}${queued} of ${model.overnight.limit} planned${queued || running ? "" : " — nothing is waiting for tonight"}.`));

  // Whatever is already in flight, honestly, before any control is offered.
  for (const key of ["overnight.start", "overnight.stop"]) {
    const state = intentStateFor(key);
    if (state) section.append(intentStatus(state));
  }

  if (draft.confirming?.when === "release") {
    section.append(releaseConfirmation(model, { onIntent }));
  } else if (running) {
    // Stopping is cheap and reversible, so it needs no second press. It must
    // not promise more than it does: the objective in flight finishes first.
    const stop = action("Stop the run", "secondary", () => {
      onIntent("overnight.stop", {}, stop, "overnight.stop");
      rerender();
    });
    const actions = el("div", "launch-actions");
    actions.append(stop);
    section.append(actions);
    section.append(el("p", "launch-confirm-cost",
      "Stopping lets the objective in flight finish, then ends the run. It does not kill work already started."));
  } else if (queued) {
    // No dead controls: the release button exists only when there is something
    // to release.
    const actions = el("div", "launch-actions");
    actions.append(action("Run tonight's plan now", "primary", () => {
      draft.confirming = { when: "release" };
      rerender();
    }));
    section.append(actions);
  }

  if (!model.overnight.items.length) return section;

  const rows = el("ol", "launch-list");
  for (const item of model.overnight.items) {
    const row = el("li", `launch-item launch-item--${item.status}`);
    // The objective leads, because that is what the founder recognises.
    row.append(el("p", "launch-item-objective", item.objective));
    const meta = el("p", "home-meta");
    meta.append(el("span", null, item.projectId));
    meta.append(el("span", "launch-item-status", ITEM_STATUS[item.status] || item.status));
    row.append(meta);
    if (item.error) row.append(el("p", "launch-item-error", item.error));
    row.append(el("div", "home-id", item.id));

    const removeState = intentStateFor(`overnight.remove:${item.id}`);
    if (removeState) row.append(intentStatus(removeState));
    // Removing is only offered for what can actually be removed. The machine
    // refuses to edit a plan mid-run, so drawing the control there would be a
    // button that cannot complete.
    else if (item.status === "queued" && !running) {
      const remove = action("Remove", "secondary", () => {
        onIntent("overnight.remove", { itemId: item.id }, remove, `overnight.remove:${item.id}`);
        rerender();
      });
      remove.className = "launch-btn launch-btn--secondary launch-btn--small";
      row.append(remove);
    }
    rows.append(row);
  }
  section.append(rows);
  return section;
}

function action(label, tone, onClick) {
  const button = el("button", `launch-btn launch-btn--${tone}`, label);
  button.type = "button";
  button.addEventListener("click", () => onClick(button));
  return button;
}

function countLabel(used, max) {
  const left = max - used;
  return left < 100 ? `${left} character${left === 1 ? "" : "s"} left of ${max}` : `up to ${max} characters`;
}

// The view owns a draft, so it asks the shell to repaint rather than the other
// way round. `app.js` sets this once.
let rerender = () => {};
export function setLaunchRerender(fn) {
  rerender = typeof fn === "function" ? fn : () => {};
}
