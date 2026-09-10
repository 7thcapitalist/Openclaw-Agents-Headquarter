// Rendering for the Founder Inbox — the chief-of-staff card.
//
// Pure string rendering, no DOM deps: imported by app.js and by factory tests
// (same shape as objectiveView.mjs). Every field it reads is produced by the
// backend translation in factory/lib/hq/founder-inbox.mjs — this file decides
// how a founder-readable item LOOKS, never what it says.
//
// The card answers four questions in order and nothing else:
//   type label → what kind of thing this is
//   title      → what the founder has to decide
//   context    → why it matters, in one or two sentences
//   actions    → what to click
//   next       → what the factory does afterwards
// Everything an operator would want — ids, prompts, stages, options, evidence,
// raw factory text — lives behind "View details" and never above it.

const TONE_CLASS = { warn: "fi-tone-warn", bad: "fi-tone-bad", info: "fi-tone-info" };

// Map a translated action onto the dashboard's existing handler contract, so
// the founder card changes presentation only — no new endpoints, no new wiring.
function actionAttrs(action, item) {
  const postTask = item.kind === "post-task-decision" || item.deferred === true ? "1" : "0";
  switch (action.intent) {
    case "approve": return `data-approve="${item.taskId || ""}"`;
    case "reject": return `data-reject="${item.taskId || ""}"`;
    case "choose": return `data-resolve-choice="${item.statePath || ""}" data-choice="${action.value || ""}" data-post-task="${postTask}"`;
    case "direct": return `data-resolve-other="${item.statePath || ""}" data-post-task="${postTask}"`;
    case "retry-task": return `data-retry-task="${item.taskId || ""}"`;
    case "report": return `data-report-task="${item.taskId || ""}"`;
    default: return "";
  }
}

function renderActions(item, { esc }) {
  const actions = item.founder?.actions || [];
  if (!actions.length) return "";
  return `<div class="fi-actions">${actions.map((action) => {
    const attrs = actionAttrs(action, item);
    if (!attrs) return "";
    const full = action.intent === "choose" && action.value && action.value !== action.label ? ` title="${esc(action.value)}"` : "";
    return `<button class="btn ${action.tone === "primary" ? "" : "secondary"}" ${attrs}${full}>${esc(action.label)}</button>`;
  }).join("")}</div>`;
}

function metaLine(item, { esc }) {
  const bits = [];
  if (item.project) bits.push(esc(item.project));
  if (item.founder?.waiting) bits.push(esc(item.founder.waiting));
  return bits.join(" · ");
}

function row(label, value, { esc }) {
  if (!value) return "";
  return `<div class="fi-fact"><span>${esc(label)}</span><div>${esc(value)}</div></div>`;
}

// The operator view, folded away. Nothing here is founder vocabulary, and
// nothing here is lost — this is the full item as the factory recorded it.
function renderDetails(item, { esc }) {
  const t = item.technical || {};
  const drilldowns = [
    t.taskId ? `<button class="btn secondary tiny" data-task-execution="${esc(t.taskId)}">Full execution view</button>` : "",
    t.taskId ? `<button class="btn secondary tiny" data-report-task="${esc(t.taskId)}">Report</button>` : "",
    t.objectiveId ? `<button class="btn secondary tiny" data-objective-execution="${esc(t.objectiveId)}">Objective</button>` : "",
  ].filter(Boolean).join("");
  const options = (t.options || []).length
    ? `<div class="fi-fact"><span>Options as written</span><div><ul class="fi-list">${t.options.map((option) => `<li>${esc(option)}</li>`).join("")}</ul></div></div>`
    : "";
  return `<details class="fi-details">
    <summary>View details</summary>
    <div class="fi-detail-body">
      ${drilldowns ? `<div class="fi-detail-actions">${drilldowns}</div>` : ""}
      ${row("Objective", t.objective, { esc })}
      ${row("What the factory recorded", t.rawTitle, { esc })}
      ${row("Stage detail", t.rawDetail, { esc })}
      ${row("Factory recommendation", t.recommendation, { esc })}
      ${options}
      ${row("Stage", t.stage, { esc })}
      ${row("Risk", t.risk, { esc })}
      ${row("Task", t.taskId, { esc })}
      ${row("Objective id", t.objectiveId, { esc })}
      ${row("Raised at", t.requestedAt, { esc })}
      ${row("State file", t.statePath, { esc })}
      ${t.outcome?.whatTheFactoryTried ? row("What the factory tried", t.outcome.whatTheFactoryTried, { esc }) : ""}
    </div>
  </details>`;
}

// Approvals carry the one-click signing contract: the wrapper attributes the
// approve handler reads, its status line, and the terminal fallback.
function approvalExtras(item, { esc }) {
  if (item.founder?.type !== "approval") return "";
  return `<div class="approve-status" data-approve-status hidden></div>
    <details class="fi-details">
      <summary>Approve from a trusted terminal instead</summary>
      <div class="fi-detail-body"><p class="muted small">Your signature comes from a key held only in this browser — the dashboard and the agents never see it. If this browser cannot reach that key, run <code>npm run approve${item.taskId ? ` -- --task ${esc(item.taskId)}` : ""}</code> at the repo root.</p></div>
    </details>`;
}

export function renderFounderInboxCard(item, { esc }) {
  const f = item.founder;
  // An item from an older payload (or an unexpected shape) still has to render.
  if (!f) return `<article class="fi-card"><h3 class="fi-title">${esc(item.title || "Needs you")}</h3><p class="fi-context">${esc(item.detail || "")}</p></article>`;
  const showSubject = f.subject && f.subject !== f.title;
  return `<article class="fi-card ${TONE_CLASS[f.tone] || "fi-tone-info"} fi-${esc(f.type)}"${f.type === "approval" ? ` data-approval-task="${esc(item.taskId || "")}" data-approval-statepath="${esc(item.statePath || "")}"` : ""}>
    <div class="fi-type">${esc(f.typeLabel)}</div>
    <h3 class="fi-title">${esc(f.title)}</h3>
    ${showSubject ? `<p class="fi-subject">${esc(f.subject)}</p>` : ""}
    ${f.context ? `<p class="fi-context">${esc(f.context)}</p>` : ""}
    ${f.why ? `<p class="fi-why"><span>Why you</span>${esc(f.why)}</p>` : ""}
    ${renderActions(item, { esc })}
    ${f.next ? `<p class="fi-next"><span>${f.type === "approval" ? "After you approve" : "After you decide"}</span>${esc(f.next)}</p>` : ""}
    ${approvalExtras(item, { esc })}
    ${renderDetails(item, { esc })}
    <div class="fi-meta">${metaLine(item, { esc })}</div>
  </article>`;
}

export function renderFounderInboxEmpty() {
  return `<div class="fi-empty"><strong>You're all caught up.</strong><span>Nothing needs you right now. The factory will bring you the next real decision.</span></div>`;
}
