// The founder command center: start an outcome, and plan the night.
//
// The tunnel dashboard has had this since the beginning — a header, a project
// picker, an objective box, and the overnight plan under it. The console has
// had none of it, so "send the factory some work" was a thing the founder
// could only do from the one machine. That is the gap this closes.
//
// THE PROJECT PICKER INCLUDES THE FACTORY. `buildCompanyState` deliberately
// keeps the HQ repo out of `company.projects` — it would distort every
// portfolio roll-up — and publishes it separately as `company.headquarters`.
// That separation is right for counting and wrong for choosing: the founder
// explicitly wants the factory to be a thing he can send work to. So the
// picker unions the two and marks the factory, exactly as the tunnel does with
// `p.isHeadquarters`. Nothing here adds the HQ to `company.projects`.
//
// NO DEAD CONTROLS. Every button below maps to an intent kind wired in
// scripts/hq-intents.mjs. Where the machine would refuse — editing a plan
// while the night is running — the control is not drawn at all rather than
// drawn and rejected.

import { list, text, unavailable } from "./render.mjs";
import { intentStatus } from "./home.mjs";

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent != null) node.textContent = String(textContent);
  return node;
}

/**
 * Where work can be sent.
 *
 * Returns the registered projects plus the factory itself. `key` is the
 * identifier the intent carries as `projectId` — the registry matches on
 * `key`, not on an `id` field, and there is no `id` on a project record.
 */
export function launchTargets(panels) {
  const company = unavailable(panels?.company) ? null : panels.company;
  if (!company) return [];

  const projects = list(company.projects)
    .map((project) => ({
      key: text(project?.key, null),
      name: text(project?.name, null) || text(project?.key, "Untitled project"),
      isHeadquarters: false,
    }))
    .filter((project) => project.key);

  const hq = company.headquarters;
  const headquarters = hq && text(hq.key, null)
    ? [{
        key: text(hq.key, null),
        name: text(hq.name, null) || "Headquarters",
        isHeadquarters: true,
      }]
    : [];

  return [...projects, ...headquarters].map((target) => ({
    ...target,
    // The tunnel's own label. "(factory)" is what tells the founder that this
    // option means the machine improving itself rather than a product.
    label: target.isHeadquarters ? `${target.name} (factory)` : target.name,
  }));
}

/**
 * Tonight's plan, as the console should show it.
 *
 * `canEdit` is the important field: the queue refuses an add or a remove while
 * a night is running, so the controls must not be drawn then. A button whose
 * only outcome is an error message is the thing this codebase calls a dead
 * button.
 */
export function overnightPlan(panels) {
  const panel = panels?.overnight;

  // The panel may be absent entirely on a machine publishing an older mirror.
  // Say that, rather than rendering an empty plan that looks like "no work
  // queued" — the two are completely different facts.
  if (!panel) {
    return {
      available: false,
      reason: "The factory machine has not published an overnight plan yet.",
      items: [], canEdit: false, isRunning: false,
    };
  }
  if (unavailable(panel) || panel.available === false) {
    return {
      available: false,
      reason: text(panel.reason, null) || "The overnight plan could not be read on the factory machine.",
      items: [], canEdit: false, isRunning: false,
    };
  }

  const isRunning = Boolean(panel.summary?.isRunning || panel.status === "running");
  return {
    available: true,
    reason: null,
    status: text(panel.status, "idle"),
    isRunning,
    stopRequested: Boolean(panel.stopRequested),
    limit: Number.isFinite(panel.limit) ? panel.limit : null,
    full: Boolean(panel.full),
    canEdit: !isRunning && !panel.full,
    canAddAtAll: !isRunning,
    items: list(panel.items).map((item) => ({
      id: text(item?.id, null),
      objective: text(item?.objective, "(no objective recorded)"),
      projectId: text(item?.projectId, null),
      status: text(item?.status, "queued"),
      error: text(item?.error, null),
    })).filter((item) => item.id),
    counts: panel.summary?.counts || { queued: 0, running: 0, complete: 0, failed: 0 },
    needsAttention: Boolean(panel.summary?.needsAttention),
  };
}

export function commandCenterModel(snapshot) {
  const panels = snapshot?.panels || {};
  const targets = launchTargets(panels);
  return {
    targets,
    canLaunch: targets.length > 0,
    // Why the launcher is missing, when it is. An absent form with no
    // explanation reads as a broken page.
    launchReason: targets.length
      ? null
      : "No projects have been published yet, so there is nowhere to send work.",
    overnight: overnightPlan(panels),
  };
}

// ─── render ──────────────────────────────────────────────────────────────────

const STATUS_WORDS = {
  queued: "queued",
  running: "running now",
  complete: "done",
  failed: "failed",
};

function projectSelect(targets, id) {
  const select = el("select", "cc-select");
  select.id = id;
  for (const target of targets) {
    const option = el("option", null, target.label);
    option.value = target.key;
    select.append(option);
  }
  return select;
}

/**
 * Draw the command center.
 *
 * Every handler is optional. An omitted handler means the corresponding
 * control is not drawn — the caller decides what this machine can do, and this
 * module never offers something the caller cannot carry out.
 */
export function renderCommandCenter(root, snapshot, {
  onStart = null,
  onOvernightAdd = null,
  onOvernightRemove = null,
  onOvernightStart = null,
  onOvernightStop = null,
  intentStateFor = () => null,
} = {}) {
  const model = commandCenterModel(snapshot);
  const section = el("section", "cc");

  section.append(el("span", "eyebrow", "Founder command center"));
  section.append(el("h2", "cc-title", "What should the factory do?"));

  // ── start an outcome ───────────────────────────────────────────────────────
  if (!model.canLaunch) {
    section.append(el("p", "home-calm home-calm--small", model.launchReason));
  } else if (onStart) {
    const form = el("form", "cc-form");
    const box = el("textarea", "cc-objective");
    box.rows = 3;
    box.placeholder = "Describe the outcome you want. The factory decomposes it into tasks.";
    box.setAttribute("aria-label", "Objective");

    const row = el("div", "cc-row");
    const select = projectSelect(model.targets, "cc-project");
    select.setAttribute("aria-label", "Project");
    const submit = el("button", "btn-primary", "Start an outcome");
    submit.type = "submit";
    row.append(select, submit);

    const state = intentStateFor("objective:start");
    form.append(box, row);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const objective = box.value.trim();
      if (!objective) { box.focus(); return; }
      onStart({ objective, projectId: select.value }, submit, "objective:start");
      box.value = "";
    });
    section.append(form);
    if (state) section.append(intentStatus(state));
  }

  section.append(overnightBlock(model.overnight, model.targets, {
    onOvernightAdd, onOvernightRemove, onOvernightStart, onOvernightStop, intentStateFor,
  }));

  root.append(section);
  return model;
}

function overnightBlock(plan, targets, {
  onOvernightAdd, onOvernightRemove, onOvernightStart, onOvernightStop, intentStateFor,
}) {
  const block = el("div", "cc-night");
  block.append(el("h3", "cc-subtitle", "Tonight's plan"));

  if (!plan.available) {
    block.append(el("p", "home-calm home-calm--small", plan.reason));
    return block;
  }

  // State first, in a sentence. The counts alone do not say whether the night
  // is going.
  const summary = plan.isRunning
    ? (plan.stopRequested
      // The runner checks the stop flag between objectives, so the one in
      // flight finishes. Saying "stopping" without that reads as "it died".
      ? "Running — it will stop after the objective now in flight finishes."
      : `Running — ${plan.counts.complete} done, ${plan.counts.queued} still queued.`)
    : plan.items.length
      ? `${plan.items.length} objective${plan.items.length === 1 ? "" : "s"} queued for tonight.`
      : "Nothing is planned for tonight.";
  block.append(el("p", "cc-night-state", summary));

  if (plan.items.length) {
    const listEl = el("ul", "cc-night-list");
    for (const item of plan.items) {
      const row = el("li", `cc-night-item cc-night-item--${item.status}`);
      const main = el("div", "cc-night-main");
      main.append(el("strong", null, item.objective));
      const meta = [item.projectId, STATUS_WORDS[item.status] || item.status].filter(Boolean).join(" · ");
      main.append(el("span", "home-meta home-meta--dim", meta));
      if (item.error) main.append(el("span", "cc-night-error", item.error));
      row.append(main);

      // Remove is only drawn when the machine would accept one.
      if (onOvernightRemove && plan.canAddAtAll) {
        const remove = el("button", "btn-ghost cc-remove", "Remove");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove "${item.objective}" from tonight's plan`);
        remove.addEventListener("click", () =>
          onOvernightRemove({ itemId: item.id }, remove, `overnight:remove:${item.id}`));
        row.append(remove);
      }
      listEl.append(row);
      const state = intentStateFor(`overnight:remove:${item.id}`);
      if (state) listEl.append(intentStatus(state));
    }
    block.append(listEl);
  }

  // ── add to the plan ────────────────────────────────────────────────────────
  if (onOvernightAdd && targets.length && plan.canAddAtAll) {
    if (plan.full) {
      block.append(el("p", "home-meta home-meta--dim",
        `Tonight's plan is full at ${plan.limit} objectives. Remove one to add another.`));
    } else {
      const form = el("form", "cc-form cc-form--compact");
      const input = el("input", "cc-objective cc-objective--one-line");
      input.type = "text";
      input.placeholder = "Add an objective to tonight's plan";
      input.setAttribute("aria-label", "Overnight objective");
      const row = el("div", "cc-row");
      const select = projectSelect(targets, "cc-night-project");
      select.setAttribute("aria-label", "Project for the overnight objective");
      const add = el("button", "btn-ghost", "Add to tonight");
      add.type = "submit";
      row.append(select, add);
      form.append(input, row);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const objective = input.value.trim();
        if (!objective) { input.focus(); return; }
        onOvernightAdd({ objective, projectId: select.value }, add, "overnight:add");
        input.value = "";
      });
      block.append(form);
      const state = intentStateFor("overnight:add");
      if (state) block.append(intentStatus(state));
    }
  } else if (plan.isRunning && onOvernightAdd) {
    block.append(el("p", "home-meta home-meta--dim",
      "The plan cannot be changed while the night is running."));
  }

  // ── start / stop ───────────────────────────────────────────────────────────
  const controls = el("div", "cc-row cc-row--controls");
  if (!plan.isRunning && onOvernightStart && plan.counts.queued > 0) {
    const start = el("button", "btn-primary", "Start tonight's run");
    start.type = "button";
    start.addEventListener("click", () => onOvernightStart({}, start, "overnight:start"));
    controls.append(start);
  }
  if (plan.isRunning && onOvernightStop && !plan.stopRequested) {
    const stop = el("button", "btn-ghost", "Stop after the current objective");
    stop.type = "button";
    stop.addEventListener("click", () => onOvernightStop({}, stop, "overnight:stop"));
    controls.append(stop);
  }
  if (controls.childElementCount) block.append(controls);

  for (const key of ["overnight:start", "overnight:stop"]) {
    const state = intentStateFor(key);
    if (state) block.append(intentStatus(state));
  }

  return block;
}
