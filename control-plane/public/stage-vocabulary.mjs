// The words the founder sees for factory machinery. ONE source, both surfaces.
//
// This file is served by Vercel from control-plane/public/ AND by the local
// dashboard, which maps /lib/stage-vocabulary.mjs onto this exact path. It is
// one physical file on disk, not a copy kept in step by discipline — the
// vocabulary drifting between the two consoles is precisely the failure this
// prevents, and there is no build step to generate one from the other.
//
// It was inline in dashboard/backend/public/app.js, which is why the hosted
// console rendered raw stage keys like "product" and "release" while the local
// one said "Shaping the outcome".

/** Stage key -> what that stage is actually doing, in plain language. */
export const STAGE_LABEL = Object.freeze({
  product: "Shaping the outcome",
  architect: "Designing the approach",
  builder: "Building",
  reviewer: "Independent review",
  qa: "Quality check",
  security: "Security check",
  release: "Preparing delivery",
});

export const STAGES = Object.freeze(Object.keys(STAGE_LABEL));

/** A stage's human label. An unknown key is de-slugged rather than shown raw. */
export function stageLabel(stage) {
  if (!stage) return "Not started";
  return STAGE_LABEL[stage] || deslug(stage);
}

/** Stage status -> how it reads to a person. */
export const STAGE_STATUS = Object.freeze({
  pass: "complete",
  completed: "complete",
  working: "working",
  fail: "stopped",
  failed: "stopped",
  blocked: "needs attention",
  "decision-required": "waiting on you",
  pending: "waiting",
});

export function stageStatusLabel(status) {
  return STAGE_STATUS[status] || deslug(status || "pending");
}

/** Event type -> what happened, in words shared by both founder consoles. */
export const EVENT_VERB = Object.freeze({
  "stage-pass": "finished",
  "stage-decision-required": "asked you",
  "task-resumed": "resumed",
  "task-created": "started",
  "handoff-ready": "handed over",
  "merge-ready": "ready to merge",
  "recovery-diagnosing": "started recovery",
  "recovery-escalated": "escalated",
  "dispatch-blocked": "blocked",
  "task-closed-unsigned": "closed",
  "founder-decision-applied": "you decided",
});

/**
 * A founder-readable event line. Routine failure routing is explicit about
 * requiring no founder action; a separate decision/escalation event is the
 * signal when the workflow genuinely needs the founder.
 */
export function eventLine(event) {
  const type = String(event?.type || "event");
  if (type === "commit-frozen") {
    return "The change was locked in for review. Nothing needed from you.";
  }
  if (type === "stage-fail") {
    const stage = stageLabel(event?.stage);
    const route = ["reviewer", "qa", "security", "release"].includes(String(event?.stage || ""))
      ? "sending it back to the builder"
      : "the factory is routing it for another attempt";
    return `${stage} found a problem — ${route}. Nothing needed from you.`;
  }
  if (type === "failure-routed") {
    const destination = event?.stage === "builder"
      ? "the builder to fix"
      : `${stageLabel(event?.stage).toLowerCase()} for another attempt`;
    return `Sent back to ${destination}. Nothing needed from you.`;
  }
  return EVENT_VERB[type] || deslug(type);
}

/** Task status -> how it reads to a person. */
export const TASK_STATUS = Object.freeze({
  active: "In progress",
  blocked: "Blocked",
  failed: "Failed",
  "merge-ready": "Ready to merge",
  merged: "Done",
  complete: "Done",
  completed: "Done",
});

export function taskStatusLabel(status) {
  return TASK_STATUS[status] || deslug(status || "unknown");
}

// ─── naming ──────────────────────────────────────────────────────────────────

// Ids that are structure, not names. `obj-c58897c0-game-backend` is an
// objective hash plus a slug; the hash is noise and the slug is a weak hint.
const ID_SHAPE = /^(?:obj|task)-[0-9a-f]{6,}-?/i;

/**
 * Turn a slug into something readable. "game-backend" -> "Game backend".
 * Used only as a FALLBACK: a task's own one-line outcome is the title.
 */
export function deslug(value) {
  const text = String(value || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The title for a task, in the order the founder should get it.
 *
 * 1. its own one-line outcome — what the work is FOR
 * 2. failing that, the slug inside its id, de-slugged into a phrase
 * 3. failing that, "Untitled task"
 *
 * An id is NEVER the title. It is rendered separately, small and muted, for
 * copying. A task reaching "Untitled task" is a publisher bug to fix, not
 * something to paper over by falling back to the id.
 */
export function taskTitle({ outcome = null, objective = null, taskId = null } = {}) {
  const stated = firstLine(outcome || objective);
  if (stated) return stated;
  const slug = String(taskId || "").replace(ID_SHAPE, "");
  const fromSlug = deslug(slug);
  if (fromSlug && fromSlug.length > 2) return fromSlug;
  return "Untitled task";
}

/** Whether a title had to be invented — so a view can flag the publisher bug. */
export function titleIsFallback({ outcome = null, objective = null } = {}) {
  return !firstLine(outcome || objective);
}

function firstLine(text) {
  if (typeof text !== "string") return "";
  const line = text.split("\n").map((s) => s.trim()).find(Boolean) || "";
  if (!line) return "";
  // An outcome can be a paragraph; the title is its first sentence, bounded.
  const sentence = line.split(/(?<=[.?!])\s/)[0] || line;
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence;
}

/**
 * What happened to a task, in words. Never "failed at —".
 *
 * A stage of null means it never got that far, and saying so is more useful
 * than an em dash: "failed before it started" is a different bug from "failed
 * at Quality check".
 */
export function taskOutcomeLine({ status = null, stage = null } = {}) {
  const state = String(status || "unknown");
  const where = stage ? stageLabel(stage) : null;
  if (state === "failed") return where ? `Failed at ${where.toLowerCase()}` : "Failed before it started";
  if (state === "blocked") return where ? `Blocked at ${where.toLowerCase()}` : "Blocked before it started";
  if (state === "active") return where ? `${where}` : "Starting";
  if (state === "merged" || state === "complete" || state === "completed") return "Delivered";
  if (state === "merge-ready") return "Ready to merge";
  return where ? `${taskStatusLabel(state)} at ${where.toLowerCase()}` : taskStatusLabel(state);
}
