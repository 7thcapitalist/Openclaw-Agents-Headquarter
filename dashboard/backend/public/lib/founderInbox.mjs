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

// ── version skew ────────────────────────────────────────────────────────────
//
// Static assets are read from disk on every request; the server's modules are
// loaded once at boot. So a deploy that is not followed by a restart serves this
// file against a payload from a server that predates the founder translation —
// no `founder`, no `technical`. That must cost the founder wording, never the
// ability to act: an approval still approves, a decision still resolves.
//
// The card below is deliberately plain. It is the degraded path, and it should
// look like one.
const LEGACY_TYPE = {
  approval: { type: "approval", label: "Needs your approval", tone: "warn" },
  decision: { type: "decision", label: "Needs your decision", tone: "warn" },
  "post-task-decision": { type: "decision", label: "Needs your decision", tone: "warn" },
  blocked: { type: "blocker", label: "Blocked", tone: "bad" },
  question: { type: "question", label: "Needs your input", tone: "info" },
};

// Placeholder options are not real one-click answers, and one of them is worse
// than useless: resolving with "Keep paused" would record that direction AND
// resume the task. Source of truth is PLACEHOLDER_OPTION in
// factory/lib/hq/founder-inbox.mjs; keep the two in step.
const LEGACY_PLACEHOLDER = /^(provide direction|keep paused|approve and resume|submit signed approval|other\b)/i;

function legacyActions(item) {
  if (item.kind === "approval") {
    return item.taskId
      ? [{ intent: "approve", label: "Approve", tone: "primary" }, { intent: "reject", label: "Reject", tone: "secondary" }]
      : [];
  }
  if (item.kind === "decision" || item.kind === "post-task-decision") {
    if (!item.statePath) return [];
    const choices = (item.options || [])
      .map((option) => String(option || "").trim())
      .filter((option) => option && !LEGACY_PLACEHOLDER.test(option))
      .map((option) => ({ intent: "choose", value: option, label: option, tone: "secondary" }));
    if (choices.length) choices[0].tone = "primary";
    return [...choices, { intent: "direct", label: choices.length ? "Something else…" : "Tell the team what to do", tone: choices.length ? "secondary" : "primary" }];
  }
  if (item.kind === "blocked" && item.taskId) {
    return [{ intent: "retry-task", label: "Retry", tone: "primary" }, { intent: "report", label: "See what happened", tone: "secondary" }];
  }
  return [];
}

function legacyFounder(item) {
  const meta = LEGACY_TYPE[item.kind] || LEGACY_TYPE.decision;
  const raw = String(item.title || "Needs you").replace(/\s+/g, " ").trim();
  return {
    type: meta.type,
    typeLabel: meta.label,
    tone: meta.tone,
    // An untranslated title can be a whole diagnosis. Cap the heading; the rest
    // is still on the card, and all of it is in the details fold.
    title: raw.length > 140 ? `${raw.slice(0, 140).replace(/\s+\S*$/, "")}…` : raw,
    subject: "",
    context: item.detail || "",
    why: "",
    next: "",
    actions: legacyActions(item),
    priority: 4,
    waiting: "",
  };
}

// The operator payload, rebuilt from the raw item when the server did not send
// one. Mirrors technicalOf() in factory/lib/hq/founder-inbox.mjs.
function legacyTechnical(item) {
  return {
    kind: item.kind || null,
    action: item.action || null,
    project: item.project || null,
    taskId: item.taskId || null,
    objectiveId: item.objectiveId || null,
    stage: item.stage || null,
    risk: item.risk || null,
    requestedAt: item.requestedAt || null,
    statePath: item.statePath || null,
    objective: item.objective || null,
    rawTitle: item.title || null,
    rawDetail: item.detail || null,
    recommendation: item.recommendation || null,
    options: item.options || [],
    outcome: item.outcome || null,
  };
}

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

function renderActions(item, founder, { esc }) {
  const actions = founder.actions || [];
  if (!actions.length) return "";
  return `<div class="fi-actions">${actions.map((action) => {
    const attrs = actionAttrs(action, item);
    if (!attrs) return "";
    const full = action.intent === "choose" && action.value && action.value !== action.label ? ` title="${esc(action.value)}"` : "";
    return `<button class="btn ${action.tone === "primary" ? "" : "secondary"}" ${attrs}${full}>${esc(action.label)}</button>`;
  }).join("")}</div>`;
}

function metaLine(item, founder, { esc }) {
  const bits = [];
  if (item.project) bits.push(esc(item.project));
  if (founder.waiting) bits.push(esc(founder.waiting));
  return bits.join(" · ");
}

function row(label, value, { esc }) {
  if (!value) return "";
  return `<div class="fi-fact"><span>${esc(label)}</span><div>${esc(value)}</div></div>`;
}

// The operator view, folded away. Nothing here is founder vocabulary, and
// nothing here is lost — this is the full item as the factory recorded it.
function renderDetails(item, { esc }) {
  const t = item.technical || legacyTechnical(item);
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
function approvalExtras(item, founder, { esc }) {
  if (founder.type !== "approval") return "";
  return `<div class="approve-status" data-approve-status hidden></div>
    <details class="fi-details">
      <summary>Approve from a trusted terminal instead</summary>
      <div class="fi-detail-body"><p class="muted small">Your signature comes from a key held only in this browser — the dashboard and the agents never see it. If this browser cannot reach that key, run <code>npm run approve${item.taskId ? ` -- --task ${esc(item.taskId)}` : ""}</code> at the repo root.</p></div>
    </details>`;
}

export function renderFounderInboxCard(item, { esc }) {
  // An item from a server that predates the founder translation is rendered
  // from the raw fields instead — same card, same actions, factory wording.
  const f = item.founder || legacyFounder(item);
  const showSubject = f.subject && f.subject !== f.title;
  return `<article class="fi-card ${TONE_CLASS[f.tone] || "fi-tone-info"} fi-${esc(f.type)}"${f.type === "approval" ? ` data-approval-task="${esc(item.taskId || "")}" data-approval-statepath="${esc(item.statePath || "")}"` : ""}>
    <div class="fi-type">${esc(f.typeLabel)}</div>
    <h3 class="fi-title">${esc(f.title)}</h3>
    ${showSubject ? `<p class="fi-subject">${esc(f.subject)}</p>` : ""}
    ${f.context ? `<p class="fi-context">${esc(f.context)}</p>` : ""}
    ${f.why ? `<p class="fi-why"><span>Why you</span>${esc(f.why)}</p>` : ""}
    ${renderActions(item, f, { esc })}
    ${f.next ? `<p class="fi-next"><span>${f.type === "approval" ? "After you approve" : "After you decide"}</span>${esc(f.next)}</p>` : ""}
    ${approvalExtras(item, f, { esc })}
    ${renderDetails(item, { esc })}
    <div class="fi-meta">${metaLine(item, f, { esc })}</div>
  </article>`;
}

export function renderFounderInboxEmpty() {
  return `<div class="fi-empty"><strong>You're all caught up.</strong><span>Nothing needs you right now. The factory will bring you the next real decision.</span></div>`;
}
