// The founder-readable completion report for one task.
//
// Pure projection of the task's own recorded state — the same state.json the
// workflow engine and GitHub publish step already wrote. It invents nothing:
// every line traces to a stage verdict, a structured event, an evidence path,
// or the recorded `githubPublish` result. Generated when a task reaches a
// terminal or paused state (see openclaw-runner.mjs), for successes and
// failures alike, so the founder never has to read raw state to know what
// happened.

const STAGES = ["product", "architect", "builder", "reviewer", "qa", "security", "release"];

const STATUS_LABEL = {
  "merge-ready": "Merge-ready — every gate passed, awaiting the founder's merge",
  merged: "Merged",
  blocked: "Blocked — needs the founder",
  active: "In progress",
};

function elapsedMs(state, now = Date.now()) {
  const created = Date.parse(state.createdAt || "");
  if (!Number.isFinite(created)) return null;
  const events = Array.isArray(state.events) ? state.events : [];
  const terminal = state.status === "merge-ready" || state.status === "merged";
  const lastEvent = events.length ? Date.parse(events[events.length - 1].at || "") : NaN;
  const end = terminal && Number.isFinite(lastEvent) ? lastEvent : now;
  return Math.max(0, end - created);
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// The chain of setbacks the task hit and how each was cleared — read straight
// from the event log plus any recorded founder decisions.
function blockersEncountered(state) {
  const events = Array.isArray(state.events) ? state.events : [];
  const decisions = Array.isArray(state.founderDecisions) ? state.founderDecisions : [];
  const lines = [];
  for (const e of events) {
    if (e.type === "stage-fail" || e.type === "dispatch-failed") {
      lines.push(`- ${e.stage || "?"} failed${e.actor ? ` (${e.actor})` : ""} at ${e.at || "?"}`);
    } else if (e.type === "failure-routed") {
      lines.push(`  → routed back to ${e.stage} (attempt ${e.attempt ?? "?"})`);
    } else if (e.type === "stage-decision-required") {
      lines.push(`- ${e.stage || "?"} raised a decision for the founder at ${e.at || "?"}`);
    } else if (e.type === "founder-decision-recorded") {
      lines.push(`  → founder answered at ${e.at || "?"}: ${truncate(e.direction || "", 200)}`);
    } else if (e.type === "founder-approval-recorded") {
      lines.push(`  → founder signed the high-risk approval at ${e.at || "?"}`);
    } else if (e.type === "task-resumed") {
      lines.push(`  → resumed at ${e.at || "?"}`);
    }
  }
  if (!lines.length && decisions.length) {
    for (const d of decisions) lines.push(`- founder decision at ${d.at}: ${truncate(d.direction || "", 200)}`);
  }
  return lines;
}

function githubSection(state) {
  const gp = state.githubPublish;
  if (!gp) {
    return ["GitHub: not published (the workflow reached this state without the publish step running)."];
  }
  const lines = [];
  if (gp.ownerRepo) lines.push(`- Repository: ${gp.ownerRepo}`);
  if (gp.pushed) {
    lines.push(`- Branch pushed: \`${state.branch}\`${gp.remote ? ` → ${gp.remote}` : ""}`);
  } else {
    lines.push(`- Branch: not pushed`);
  }
  if (gp.commitSha) lines.push(`- Commit: ${gp.commitSha}${gp.commitRange ? ` (range ${gp.commitRange})` : ""}`);
  if (gp.prUrl) lines.push(`- Pull request: ${gp.prUrl}`);
  else if (gp.pushed) lines.push(`- Pull request: not opened${gp.reason ? ` — ${gp.reason}` : ""} (open it manually)`);
  if (!gp.published && gp.reason) lines.push(`- Not published: ${gp.reason}`);
  lines.push("- Merge is always a separate, manual founder decision. The factory never merges.");
  return lines;
}

/**
 * @param {object} state  the task's full state.json object
 * @param {object} [opts]
 * @param {number} [opts.now]  epoch ms, for deterministic tests
 * @returns {string} markdown
 */
export function buildCompletionReport(state, { now = Date.now() } = {}) {
  const task = state.task || {};
  const out = [];
  out.push(`# Completion report — ${task.id || "task"}`);
  out.push("");
  out.push(`**Status:** ${STATUS_LABEL[state.status] || state.status || "unknown"}`);
  out.push(`**Project:** ${task.project || "—"}  ·  **Risk:** ${task.risk || "—"}  ·  **Work type:** ${task.workType || "—"}`);
  if (state.branch) out.push(`**Branch:** \`${state.branch}\``);
  out.push("");

  out.push("## Outcome");
  out.push(task.outcome || "(no outcome recorded)");
  out.push("");

  if (Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length) {
    out.push("## Acceptance criteria");
    for (const c of task.acceptanceCriteria) out.push(`- ${c}`);
    out.push("");
  }

  out.push("## Timeline");
  out.push(`- Created: ${state.createdAt || "—"}`);
  out.push(`- Last activity: ${state.updatedAt || "—"}`);
  out.push(`- Elapsed (wall clock): ${formatDuration(elapsedMs(state, now))}`);
  out.push("");

  out.push("## Stages");
  let ran = 0;
  for (const stage of STAGES) {
    const s = state.stages?.[stage];
    if (!s || s.status === "pending") continue;
    ran += 1;
    const evidence = Array.isArray(s.evidence) ? s.evidence.length : 0;
    out.push(`- **${stage}** — ${s.status}${s.actor ? ` (${s.actor})` : ""}${s.summary ? ` — ${truncate(s.summary, 240)}` : ""}${evidence ? ` · ${evidence} evidence artifact${evidence === 1 ? "" : "s"}` : ""}`);
  }
  if (!ran) out.push("- (no stage has produced a verdict yet)");
  out.push("");

  if (state.status === "blocked" && state.blocker) {
    out.push("## Why it is blocked");
    out.push(`- Stage: ${state.blocker.stage || "—"}`);
    out.push(`- Outcome: ${state.blocker.outcome || "—"}`);
    out.push(`- Detail: ${truncate(state.blocker.summary || "", 400)}`);
    out.push("");
  }

  const blockers = blockersEncountered(state);
  if (blockers.length) {
    out.push("## Setbacks and how they were handled");
    out.push(...blockers);
    out.push("");
  }

  out.push("## GitHub");
  out.push(...githubSection(state));
  out.push("");

  out.push("---");
  out.push("_Generated by the OpenClaw factory from this task's recorded state. Nothing here is inferred beyond what the pipeline recorded._");
  return out.join("\n");
}

function truncate(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`;
}
