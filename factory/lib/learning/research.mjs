// Phase 4: external-knowledge research for the Company Learning System.
//
// "An employee attends a conference and brings knowledge back." The Learning
// Agent studies a topic (a technology, an engineering practice, an AI
// development, a startup/product lesson, a competitor) and returns a structured,
// source-cited ResearchNote. The note is a recommendation only — it is promoted
// into ENGINEERING_IMPROVEMENTS.md / PROCESS_IMPROVEMENTS.md by the founder like
// any other finding. It never creates an issue or a task on its own.
//
// The model call is injected (`execute`) so this is unit-testable without a
// network or OpenClaw. Output is redacted before it is returned.

import { execFile } from "child_process";
import { promisify } from "util";
import { resolve } from "path";
import { sanitizeExcerpt } from "../common/redact.mjs";
import { slugify } from "../common/fingerprint.mjs";

const execFileAsync = promisify(execFile);

export function researchPrompt(topic, { agendaContext = "" } = {}) {
  return [
    "You are the OpenClaw Learning / R&D Agent doing external research for the company.",
    "You work for HQ, not for any single project. Study the topic below using your available tools.",
    agendaContext ? `\nStanding research agenda context:\n${agendaContext}\n` : "",
    `Topic: ${topic}`,
    "",
    "Return ONLY one JSON object with exactly these fields:",
    "  topic         (string, echo the topic)",
    "  date          (ISO date)",
    "  sources       (array of { title, url }; at least one; real, checkable)",
    "  summary       (string; <= 1500 chars; what a competent engineer needs to know)",
    "  applicability (array of strings; where this could apply inside OpenClaw HQ)",
    "  proposedActions (array of { area, action }; area in: prompt, workflow, tooling, evaluation, architecture, product, none)",
    "",
    "Hard rules:",
    "- Cite every claim to a source. No unsourced assertions.",
    "- No secrets, no private data, no chain-of-thought. Summaries and outcomes only.",
    "- proposedActions are recommendations. Do NOT create issues, tasks, branches, or PRs.",
  ].filter(Boolean).join("\n");
}

export function parseResearchNote(raw, topic, { now = new Date().toISOString() } = {}) {
  const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Research pass did not return a JSON object.");
    obj = JSON.parse(cleaned.slice(start, end + 1));
  }
  const sources = Array.isArray(obj.sources)
    ? obj.sources.map((s) => ({ title: sanitizeExcerpt(String(s.title || ""), { maxLength: 200 }).text, url: String(s.url || "").trim() }))
        .filter((s) => s.title && /^https?:\/\//.test(s.url))
    : [];
  if (!sources.length) throw new Error("Research note must cite at least one real source URL.");
  const actions = Array.isArray(obj.proposedActions)
    ? obj.proposedActions.map((a) => ({
        area: ["prompt", "workflow", "tooling", "evaluation", "architecture", "product", "none"].includes(a.area) ? a.area : "none",
        action: sanitizeExcerpt(String(a.action || ""), { maxLength: 400 }).text,
      })).filter((a) => a.action)
    : [];
  return {
    topic: sanitizeExcerpt(String(obj.topic || topic), { maxLength: 200 }).text,
    date: /^\d{4}-\d{2}-\d{2}/.test(String(obj.date || "")) ? String(obj.date).slice(0, 10) : now.slice(0, 10),
    sources,
    summary: sanitizeExcerpt(String(obj.summary || ""), { maxLength: 1600 }).text,
    applicability: Array.isArray(obj.applicability)
      ? obj.applicability.map((x) => sanitizeExcerpt(String(x), { maxLength: 200 }).text).filter(Boolean).slice(0, 12)
      : [],
    proposedActions: actions.slice(0, 12),
    gatheredAt: now,
  };
}

export async function defaultExecuteResearch({ prompt, agentId = "learning", topic }) {
  const { stdout } = await execFileAsync("openclaw", [
    "agent", "--agent", agentId, "--session-key", `agent:${agentId}:learning-research-${slugify(topic)}`,
    "--message", prompt, "--json", "--timeout", "900",
  ], { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  const envelope = JSON.parse(stdout);
  if (envelope.status !== "ok") throw new Error(`Research pass failed: ${envelope.summary || envelope.status}`);
  const text = envelope.result?.payloads?.map((p) => p.text).filter(Boolean).join("\n");
  if (!text) throw new Error("Research pass returned no text.");
  return text;
}

export async function runResearch({ topic, agendaContext = "", agentId = "learning", now = new Date().toISOString(), execute = defaultExecuteResearch }) {
  if (typeof topic !== "string" || !topic.trim()) throw new Error("research requires a non-empty topic.");
  const prompt = researchPrompt(topic.trim(), { agendaContext });
  const raw = await execute({ prompt, agentId, topic: topic.trim() });
  return parseResearchNote(raw, topic.trim(), { now });
}

export function renderResearchNoteMarkdown(note) {
  return [
    `## Research note — ${note.topic}`,
    "",
    `- Date: ${note.date}`,
    `- Sources:`,
    ...note.sources.map((s) => `  - [${s.title}](${s.url})`),
    "",
    `**Summary:** ${note.summary}`,
    "",
    note.applicability.length ? `**Where it applies:**\n${note.applicability.map((a) => `- ${a}`).join("\n")}` : "",
    "",
    note.proposedActions.length ? `**Proposed actions (recommendations only):**\n${note.proposedActions.map((a) => `- [${a.area}] ${a.action}`).join("\n")}` : "",
    "",
  ].filter((l) => l !== "").join("\n");
}
