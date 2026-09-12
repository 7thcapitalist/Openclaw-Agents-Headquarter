// Find the task where a thing was discussed, without reading anything the
// panels do not already show.
//
// Adapted from Paperclip's `company-search` service and `Search.tsx` at pinned
// commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). Issue #158.
//
// HQ had no search endpoint at all. Finding "the task where the Vercel CLI pin
// was discussed" meant opening objectives one at a time. That mattered less
// when HQ held objectives and tasks; it matters now that it also holds goals
// (#136), decision history (#142), run timelines (#148), scorecards (#144) and
// interactions (#151). This campaign made the corpus worth searching.
//
// WHAT THIS SEARCHES, AND WHY IT IS NOT AN INDEX OVER THE RUNTIME TREE.
// Every layer here is an EXISTING PROJECTION - the same function the
// corresponding panel calls, with the same sanitisation. Search adds a filter,
// never a reader. A full-text index over the runtime tree would read prompts,
// agent prose and arbitrary files, which is precisely what those projections
// exist to avoid. The rule is one sentence: nothing can appear in a result that
// does not already appear in the panel the result came from.
//
// The one layer that is not a projection is `evidence`, which is PATHS ONLY.
// An evidence artifact is a file in the repository; its path is a reference the
// operator can follow, and its contents are none of HQ's business here.

import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { buildGoalsSnapshot } from "./goals.mjs";
import { buildDecisionHistory } from "./decision-history.mjs";
import { buildInteractionThread } from "./interactions.mjs";
import { buildRunTimeline } from "./run-timeline.mjs";
import { defaultStateRoot } from "./tasks.mjs";

export const SEARCH_LAYERS = Object.freeze(["goals", "decisions", "interactions", "timeline", "evidence"]);

const MIN_QUERY = 2;
const MAX_QUERY = 200;
const MAX_TERMS = 8;
const MAX_SNIPPET = 240;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// A bound on work, not on truth: a factory with more tasks than this gets a
// result set marked `truncated` rather than a request that never returns.
const MAX_TASKS = 200;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// The query becomes a list of plain lowercase terms and never a regular
// expression. A caller-supplied pattern is a way to burn CPU on a read-only
// endpoint, and a way to widen a match past what the caller can already see.
export function parseQuery(raw) {
  const text = String(raw ?? "").replace(CONTROL_CHARS, " ").trim();
  if (text.length < MIN_QUERY) throw new Error(`query must be at least ${MIN_QUERY} characters`);
  if (text.length > MAX_QUERY) throw new Error(`query must be at most ${MAX_QUERY} characters`);
  const terms = [...new Set(text.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
  if (!terms.length) throw new Error("query has no searchable terms");
  return { text, terms };
}

export function parseLayers(raw) {
  if (raw == null || raw === "") return [...SEARCH_LAYERS];
  const asked = String(raw).toLowerCase().split(",").map((part) => part.trim()).filter(Boolean);
  const unknown = asked.filter((layer) => !SEARCH_LAYERS.includes(layer));
  if (unknown.length) throw new Error(`unknown search layer(s): ${unknown.join(", ")}`);
  return asked.length ? [...new Set(asked)] : [...SEARCH_LAYERS];
}

// Every term must appear somewhere in the record. AND, not OR: across five
// layers of one factory, OR returns everything and finds nothing.
function matches(haystack, terms) {
  const text = haystack.toLowerCase();
  return terms.every((term) => text.includes(term));
}

// A bounded window around the first match, so a long field cannot become an
// unbounded response body.
function snippet(text, terms) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= MAX_SNIPPET) return value;
  const at = value.toLowerCase().indexOf(terms[0]);
  if (at < 0) return `${value.slice(0, MAX_SNIPPET - 1)}...`;
  const start = Math.max(0, at - Math.floor(MAX_SNIPPET / 3));
  const end = Math.min(value.length, start + MAX_SNIPPET);
  return `${start > 0 ? "..." : ""}${value.slice(start, end).trim()}${end < value.length ? "..." : ""}`;
}

const bounded = (value, min, max, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
};

export function searchHq({ hqRoot, query, stateRoot = null, layers = SEARCH_LAYERS, limit = DEFAULT_LIMIT, now = new Date().toISOString() }) {
  const parsed = parseQuery(query);
  const wanted = layers.filter((layer) => SEARCH_LAYERS.includes(layer));
  const cap = bounded(limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  const root = resolve(stateRoot || defaultStateRoot(hqRoot));
  const warnings = [];
  const results = [];
  const counts = Object.fromEntries(SEARCH_LAYERS.map((layer) => [layer, 0]));

  const found = taskDirs(root);
  const tasks = found.slice(0, MAX_TASKS);
  const truncatedTasks = found.length > MAX_TASKS;

  const push = (result) => { counts[result.layer] += 1; results.push(result); };

  if (wanted.includes("goals")) searchGoals({ hqRoot, stateRoot: root, now, parsed, push, warnings });
  if (wanted.includes("decisions")) searchDecisions({ hqRoot, stateRoot: root, now, parsed, push, warnings });
  if (wanted.includes("interactions")) searchInteractions({ tasks, parsed, push, warnings });
  if (wanted.includes("timeline")) searchTimeline({ hqRoot, stateRoot: root, tasks, parsed, push, warnings });
  if (wanted.includes("evidence")) searchEvidence({ tasks, parsed, push, warnings });

  // Newest first, ties broken by layer then ref so the order is stable across
  // calls. A result list that reshuffles is a result list nobody trusts.
  results.sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))
    || a.layer.localeCompare(b.layer)
    || String(a.ref).localeCompare(String(b.ref)));

  return {
    version: 1,
    asOf: now,
    available: warnings.length === 0,
    warnings,
    query: parsed.text,
    terms: parsed.terms,
    layers: wanted,
    // `total` is what matched; `results` is what is returned. Reporting only
    // the second would make a truncated answer look complete.
    total: results.length,
    truncated: results.length > cap || truncatedTasks,
    counts,
    tasksScanned: tasks.length,
    results: results.slice(0, cap),
  };
}

// ----------------------------------------------------------------- the layers

function searchGoals({ hqRoot, stateRoot, now, parsed, push, warnings }) {
  let snapshot;
  try { snapshot = buildGoalsSnapshot({ hqRoot, stateRoot, now }); }
  catch (error) { warnings.push(`goals unavailable: ${error.message}`); return; }
  warnings.push(...(snapshot.warnings || []).map((warning) => `goals: ${warning}`));

  // Exactly the fields the goals projection carries. Searching a field the
  // panel does not project would be search reading something the operator
  // cannot see, which is the one thing this endpoint must not do.
  for (const goal of snapshot.goals || []) {
    const hay = [goal.id, goal.title, goal.level, goal.projectId, goal.objectiveId].filter(Boolean).join(" ");
    if (!matches(hay, parsed.terms)) continue;
    push({
      layer: "goals",
      ref: goal.id,
      title: goal.title || goal.id,
      snippet: snippet(`${goal.level} goal: ${goal.title || goal.id}`, parsed.terms),
      // A goal is a tracked definition, not an event, so it has no timestamp of
      // its own. It sorts last rather than being given a fabricated one.
      at: null,
      taskId: null,
      objectiveId: goal.objectiveId || null,
      progress: goal.progress?.percent ?? null,
      // Where the operator goes to see this in full, so a hit is never a dead
      // end.
      source: "GET /api/hq/goals",
    });
  }
}

function searchDecisions({ hqRoot, stateRoot, now, parsed, push, warnings }) {
  let history;
  try { history = buildDecisionHistory({ hqRoot, stateRoot, now }); }
  catch (error) { warnings.push(`decisions unavailable: ${error.message}`); return; }
  warnings.push(...(history.warnings || []).map((warning) => `decisions: ${warning}`));

  for (const decision of history.decisions || []) {
    const hay = [decision.kind, decision.state, decision.summary, decision.question, decision.taskId, decision.objectiveId, decision.projectId]
      .filter(Boolean).join(" ");
    if (!matches(hay, parsed.terms)) continue;
    push({
      layer: "decisions",
      ref: `${decision.taskId || "unknown"}:${decision.kind}:${decision.requestedAt || decision.updatedAt || ""}`,
      title: `${decision.kind} - ${decision.state}`,
      snippet: snippet(decision.summary || decision.question || decision.kind, parsed.terms),
      at: decision.updatedAt || decision.requestedAt || null,
      taskId: decision.taskId || null,
      objectiveId: decision.objectiveId || null,
      source: "GET /api/hq/decisions",
    });
  }
}

function searchInteractions({ tasks, parsed, push, warnings }) {
  for (const taskDir of tasks) {
    const taskId = basename(taskDir);
    const thread = buildInteractionThread({ taskDir, limit: 500 });
    if (thread.available === false) {
      // A thread that was never written is not a degraded thread.
      if (thread.reason && !/ENOENT/.test(thread.reason)) warnings.push(`interactions ${taskId}: ${thread.reason}`);
      continue;
    }
    for (const item of thread.interactions || []) {
      // `body` was already scrubbed of secrets by createInteraction and the
      // record marks itself untrusted-input. Search neither re-reads the source
      // nor un-redacts anything.
      const hay = [item.body, item.author?.id, item.kind, ...(item.mentions || [])].filter(Boolean).join(" ");
      if (!matches(hay, parsed.terms)) continue;
      push({
        layer: "interactions",
        ref: item.interactionId,
        title: `${item.kind} by ${item.author?.type || "unknown"}:${item.author?.id || "unknown"}`,
        snippet: snippet(item.body, parsed.terms),
        at: item.occurredAt || null,
        taskId: item.taskId || taskId,
        objectiveId: item.objectiveId || null,
        trust: "untrusted-input",
        source: `GET /api/founder/tasks/${item.taskId || taskId}/interactions`,
      });
    }
  }
}

function searchTimeline({ hqRoot, stateRoot, tasks, parsed, push, warnings }) {
  for (const taskDir of tasks) {
    const taskId = basename(taskDir);
    let timeline;
    try { timeline = buildRunTimeline({ hqRoot, taskId, stateRoot }); }
    catch (error) { warnings.push(`timeline ${taskId}: ${error.message}`); continue; }
    if (!timeline) continue;

    for (const entry of timeline.entries || []) {
      const hay = [entry.kind, entry.actor, entry.stage, entry.detail].filter(Boolean).join(" ");
      if (!matches(hay, parsed.terms)) continue;
      push({
        layer: "timeline",
        ref: `${taskId}:${entry.at}:${entry.source}:${entry.kind}`,
        title: `${entry.source} - ${entry.kind}`,
        snippet: snippet(entry.detail || entry.kind, parsed.terms),
        at: entry.at || null,
        taskId,
        objectiveId: timeline.task?.objectiveId || null,
        stage: entry.stage || null,
        actor: entry.actor || null,
        source: `GET /api/founder/tasks/${taskId}/timeline`,
      });
    }
  }
}

// Paths only. An evidence artifact is a file in the repository: the path is a
// reference the operator can follow, and reading the file here would make
// search the one thing in HQ that reads arbitrary repository content.
function searchEvidence({ tasks, parsed, push, warnings }) {
  for (const taskDir of tasks) {
    const taskId = basename(taskDir);
    let state;
    try { state = JSON.parse(readFileSync(join(taskDir, "state.json"), "utf8")); }
    catch (error) { warnings.push(`evidence ${taskId}: ${error.message}`); continue; }

    for (const [stage, result] of Object.entries(state?.stages || {})) {
      for (const artifact of result?.evidence || []) {
        const path = String(artifact?.path || "");
        if (!path || !matches(path, parsed.terms)) continue;
        push({
          layer: "evidence",
          ref: `${taskId}:${stage}:${path}`,
          title: path,
          // The path IS the result. There is deliberately no content snippet.
          snippet: path,
          at: artifact.recordedAt || result.completedAt || null,
          taskId,
          objectiveId: state?.task?.objectiveId || null,
          stage,
          source: `GET /api/founder/tasks/${taskId}/timeline`,
        });
      }
    }
  }
}

// ------------------------------------------------------------------ internals

// Task directories under the state root. Nothing here follows a path supplied
// by the caller: the query filters records, it can never widen the set of files
// read.
function taskDirs(root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (existsSync(join(path, "state.json")) && basename(dirname(path)) === "tasks") out.push(path);
    else taskDirs(path, out);
  }
  return out;
}

function safeReadDir(path) {
  try { return readdirSync(path, { withFileTypes: true }); } catch { return []; }
}
