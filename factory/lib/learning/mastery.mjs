// Mastery pass for the Company Learning System.
//
// Every cycle — whether or not anything failed — the Learning Agent works on
// making one role better at its craft. It picks the next role in a fixed
// rotation, studies that role's recent work, researches how the job is done
// well (allowlisted, budgeted), and files agent-improvement findings that flow
// through the normal reconcile -> synthesize -> promote path. A dated entry is
// appended to the role's dossier so competence accrues visibly over time.
//
// Pure except for the injected research `execute`.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { sanitizeExcerpt } from "../common/redact.mjs";
import { fingerprint, slugify } from "../common/fingerprint.mjs";
import { runResearch } from "./research.mjs";

export const DEFAULT_ROTATION = [
  "product",
  "architect",
  "backend-builder",
  "frontend-builder",
  "reviewer",
  "qa",
  "security",
  "release",
];

// Role -> the pipeline stage(s) it owns, for pulling that role's task records.
const ROLE_STAGES = {
  product: ["product"],
  architect: ["architect"],
  "backend-builder": ["builder"],
  "frontend-builder": ["builder"],
  reviewer: ["reviewer"],
  qa: ["qa"],
  security: ["security"],
  release: ["release"],
};

// Role -> the finding-schema targetRole enum value (schema has no builder split).
export const ROLE_TARGET = {
  product: "product",
  architect: "architect",
  "backend-builder": "builder",
  "frontend-builder": "builder",
  reviewer: "reviewer",
  qa: "qa",
  security: "security",
  release: "release",
};

const CRAFT = {
  product: "writing observable outcomes and executable acceptance criteria for autonomous build agents",
  architect: "smallest-safe technical design, interface contracts, and rollback specs for AI coding agents",
  "backend-builder": "high-first-pass backend implementation for autonomous coding agents: tests-first, small diffs, dependency hygiene, verification evidence",
  "frontend-builder": "reliable UI implementation and visual/responsive verification workflows for autonomous coding agents",
  reviewer: "high-signal independent code review: rejection criteria, regression detection, acceptance-criteria gaps",
  qa: "acceptance-criteria falsification and edge-case discovery techniques for AI QA agents",
  security: "fast, high-coverage security and privacy review gates for AI-generated changes",
  release: "merge-readiness verification and release-gate evidence standards",
};

export function readMasteryState(learningRoot) {
  const path = join(learningRoot, "mastery-state.json");
  const base = { version: 1, cursor: 0, history: [] };
  if (!existsSync(path)) return base;
  try {
    return { ...base, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return base;
  }
}

export function pickDeepDiveRoles(state, { rotation = DEFAULT_ROTATION, count = 1 } = {}) {
  const roles = [];
  let cursor = Number.isInteger(state?.cursor) ? state.cursor : 0;
  const n = Math.max(1, count);
  for (let i = 0; i < n; i += 1) {
    roles.push(rotation[((cursor % rotation.length) + rotation.length) % rotation.length]);
    cursor += 1;
  }
  return { roles, nextCursor: ((cursor % rotation.length) + rotation.length) % rotation.length };
}

export function roleRecords(records, role) {
  const stages = ROLE_STAGES[role] || [];
  return (records || []).filter((r) =>
    stages.some((s) => (r.assignments || {})[s] && (r.stageOutcomes || []).some((o) => o.stage === s)));
}

export function masteryResearchTopic(role, recs = []) {
  const craft = CRAFT[role] || `making the ${role} agent better at its craft`;
  return [
    `Current best practice for ${craft}.`,
    "Return concrete, adoptable changes to prompts, checklists, tools, or gates — not general commentary.",
    `Context: an OpenClaw software factory with ${recs.length} recent ${role} task(s); the agent is a model-backed autonomous worker following a role prompt.`,
  ].join(" ");
}

export function masteryAgendaContext(hqRoot, role) {
  const path = join(hqRoot, "factory", "knowledge", "agents", `${role}.agenda.md`);
  return existsSync(path) ? readFileSync(path, "utf8").slice(0, 4000) : "";
}

// Turn a research note's proposed actions into agent-improvement findings.
export function masteryFindings({ role, note, roleMetrics = null, now = new Date().toISOString() }) {
  if (!note) return [];
  const actions = (note.proposedActions || []).filter((a) => a.area && a.area !== "none").slice(0, 4);
  const recent = roleMetrics
    ? `Recent: ${roleMetrics.tasks} task(s), first-pass ${Math.round((roleMetrics.firstPassRate || 0) * 100)}%, ${roleMetrics.reworks || 0} rework(s).`
    : "No recent tasks for this role in the window.";
  return actions.map((a) => ({
    kind: "agent-improvement",
    scope: "agent",
    targetRole: ROLE_TARGET[role] || null,
    fingerprint: fingerprint(["mastery", slugify(role), slugify(a.area), slugify(a.action).slice(0, 40)]),
    title: `Mastery (${role}): ${sanitizeExcerpt(a.action, { maxLength: 110 }).text}`,
    observation: `Proactive mastery pass for ${role}. ${recent} Studied "${sanitizeExcerpt(note.topic, { maxLength: 120 }).text}"; research area: ${a.area}.`,
    recommendation: sanitizeExcerpt(a.action, { maxLength: 600 }).text,
    confidence: "medium",
    occurrences: 1,
    taskIds: [],
    evidence: (note.sources || []).slice(0, 3).map((s) => ({
      path: s.url,
      excerpt: sanitizeExcerpt(s.title, { maxLength: 160 }).text,
    })),
  }));
}

export function renderMasteryLogEntry({ role, date, roleMetrics = null, note = null, findingIds = [], error = null }) {
  const lines = [`### ${date} — mastery cycle`, ""];
  lines.push(roleMetrics
    ? `- Recent work: ${roleMetrics.tasks} task(s), first-pass ${Math.round((roleMetrics.firstPassRate || 0) * 100)}%, ${roleMetrics.reworks || 0} rework(s).`
    : "- Recent work: none in window.");
  if (error) {
    lines.push(`- Research: skipped (${sanitizeExcerpt(error, { maxLength: 160 }).text}).`);
  } else if (note) {
    lines.push(`- Studied: ${note.topic}`);
    if (note.sources?.length) {
      lines.push(`- Sources: ${note.sources.map((s) => `[${s.title}](${s.url})`).join("; ")}`);
    }
    if (note.summary) lines.push(`- Takeaway: ${note.summary.slice(0, 400)}`);
  }
  if (findingIds.length) lines.push(`- Proposed: ${findingIds.join(", ")}`);
  lines.push("");
  return lines.join("\n");
}

const DOSSIER_MARKER = "## Mastery log";

export function dossierHeader(role) {
  return [
    `# ${role} — mastery dossier`,
    "",
    "Maintained by the Learning / R&D Agent's mastery pass (`npm run factory:learn -- cycle`).",
    "Each cycle appends what was studied, what changed, and what is next. Newest first.",
    "",
    `${DOSSIER_MARKER}`,
    "",
  ].join("\n");
}

// Insert a new entry directly under the "## Mastery log" heading (newest first).
export function insertMasteryLogEntry(body, entry, role) {
  const text = body && body.includes(DOSSIER_MARKER) ? String(body) : dossierHeader(role);
  const idx = text.indexOf(DOSSIER_MARKER);
  const after = idx + DOSSIER_MARKER.length;
  const head = text.slice(0, after).replace(/\s*$/, "\n\n");
  const tail = text.slice(after).replace(/^\s*/, "");
  return `${head}${entry.replace(/\s*$/, "\n")}\n${tail}`.replace(/\n{3,}/g, "\n\n");
}

// One mastery pass for a role. Research failure is captured, never thrown.
export async function runMasteryPass({ role, records = [], hqRoot, now = new Date().toISOString(), agentId = "learning", execute } = {}) {
  const recs = roleRecords(records, role);
  const topic = masteryResearchTopic(role, recs);
  const agendaContext = masteryAgendaContext(hqRoot, role);
  let note = null;
  let error = null;
  try {
    const opts = { topic, agendaContext, agentId, now };
    if (execute) opts.execute = execute;
    note = await runResearch(opts);
  } catch (e) {
    error = e?.message || String(e);
  }
  return { role, topic, note, error, recentCount: recs.length };
}
