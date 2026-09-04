// Organizational knowledge files for the Company Learning System.
//
// The three global knowledge files live in the HQ repo under factory/knowledge/
// and are committed. This module renders finding-derived entries, appends them
// idempotently, parses them back, and renders the founder digest.
//
// Entries are append-mostly and human-reviewed: synthesize() drafts them, the
// founder promotes them onto a learning/* branch as a PR. Nothing here mutates a
// role prompt or factory.config.json — those changes go through a normal
// low-risk factory task.
//
// Pure over strings; fs only in append/read helpers. Node builtins only.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { sanitizeExcerpt } from "../common/redact.mjs";

export const KNOWLEDGE_DIR = "factory/knowledge";

export const KNOWLEDGE_FILES = {
  lessons: { file: "LESSONS_LEARNED.md", idPrefix: "LL", title: "Lessons Learned" },
  engineering: { file: "ENGINEERING_IMPROVEMENTS.md", idPrefix: "EI", title: "Engineering Improvements" },
  process: { file: "PROCESS_IMPROVEMENTS.md", idPrefix: "PI", title: "Process Improvements" },
};

const ENGINEERING_CAUSES = /build-or-compile-error|missing-or-failing-tests|regression|security-or-privacy|clean-delivery/;
const PROCESS_FINGERPRINTS = /^(decision-friction|retry-exhaustion|fast-cycle)/;

// Which knowledge file a finding belongs in.
export function targetFileForFinding(finding) {
  if (finding.kind === "agent-improvement") return "process";
  if (PROCESS_FINGERPRINTS.test(finding.fingerprint || "")) return "process";
  if (ENGINEERING_CAUSES.test(finding.fingerprint || "")) return "engineering";
  if (finding.kind === "success") return "engineering";
  return "lessons";
}

export function knowledgeFilePath(hqRoot, key) {
  const meta = KNOWLEDGE_FILES[key];
  if (!meta) throw new Error(`Unknown knowledge file key: ${key}`);
  return join(resolve(hqRoot), KNOWLEDGE_DIR, meta.file);
}

// Parse "## <ID> — <title>" headings out of a knowledge file body.
export function readEntries(text) {
  const haystack = `\n${String(text)}`;
  const re = /\n## ([A-Z]{2}-\d{4}-\d{3,}) — ([^\n]+)\n([\s\S]*?)(?=\n## [A-Z]{2}-\d{4}-\d{3,} — |\n<!-- end -->|$)/g;
  const entries = [];
  let m;
  while ((m = re.exec(haystack)) !== null) {
    entries.push({ id: m[1], title: m[2].trim(), body: m[3].trim() });
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return entries;
}

export function nextEntryId(text, idPrefix, year) {
  const ids = [...String(text).matchAll(new RegExp(`## ${idPrefix}-${year}-(\\d{3,})`, "g"))].map((m) => Number(m[1]));
  const max = ids.length ? Math.max(...ids) : 0;
  return `${idPrefix}-${year}-${String(max + 1).padStart(3, "0")}`;
}

// Build an entry object from a finding.
export function entryFromFinding(finding, { now = new Date().toISOString() } = {}) {
  const key = targetFileForFinding(finding);
  const year = (now.match(/^(\d{4})/) || [])[1] || String(new Date().getFullYear());
  const scope = finding.scope === "project" && finding.project
    ? `project:${finding.project}`
    : finding.scope === "agent" && finding.targetRole
      ? `agent:${finding.targetRole}`
      : "global";
  return {
    fileKey: key,
    year,
    title: sanitizeExcerpt(finding.title, { maxLength: 120 }).text,
    date: now.slice(0, 10),
    scope,
    sourceFindings: [finding.id, ...(finding.mergedFrom || [])].filter(Boolean),
    confidence: finding.confidence || "medium",
    evidenceTasks: [...(finding.taskIds || [])],
    observation: sanitizeExcerpt(finding.observation, { maxLength: 800 }).text,
    recommendation: sanitizeExcerpt(finding.recommendation || "(none proposed)", { maxLength: 800 }).text,
    status: "proposed",
  };
}

export function renderEntry(entry, id) {
  return [
    `## ${id} — ${entry.title}`,
    "",
    `- Date: ${entry.date}`,
    `- Scope: ${entry.scope}`,
    `- Source findings: ${entry.sourceFindings.join(", ") || "n/a"}`,
    `- Confidence: ${entry.confidence}`,
    `- Evidence tasks: ${entry.evidenceTasks.join(", ") || "n/a"}`,
    `- Status: ${entry.status}`,
    "",
    `**Observation:** ${entry.observation}`,
    "",
    `**Recommendation:** ${entry.recommendation}`,
    "",
  ].join("\n");
}

// Append an entry to a knowledge file body. Idempotent by (title + sourceFindings):
// if an entry with the same title and overlapping source findings already
// exists, returns the body unchanged.
export function appendEntryToBody(body, entry, { now = new Date().toISOString() } = {}) {
  const text = String(body);
  const existing = readEntries(text);
  const dup = existing.find((e) =>
    e.title.toLowerCase() === entry.title.toLowerCase() &&
    entry.sourceFindings.some((sf) => e.body.includes(sf)));
  if (dup) return { body: text, id: dup.id, appended: false };
  const id = nextEntryId(text, KNOWLEDGE_FILES[entry.fileKey].idPrefix, entry.year);
  const trimmed = text.replace(/\s*$/, "");
  const next = `${trimmed}\n\n${renderEntry(entry, id)}`;
  return { body: `${next.replace(/\s*$/, "")}\n`, id, appended: true };
}

export function appendEntryToFile(filePath, entry, { now } = {}) {
  const path = resolve(filePath);
  const body = existsSync(path) ? readFileSync(path, "utf8") : `# ${KNOWLEDGE_FILES[entry.fileKey].title}\n`;
  const result = appendEntryToBody(body, entry, { now });
  if (result.appended) writeFileSync(path, result.body, "utf8");
  return result;
}

// ---- Founder digest ------------------------------------------------------

function bullet(f) {
  return `- **${f.id}** (${f.confidence}, ${f.occurrences}×) ${f.title} — ${f.recommendation || f.observation}`;
}

export function renderDigest({ store, analysis = {}, now = new Date().toISOString() }) {
  const open = store.findings.filter((f) => f.status === "open");
  const byKind = (k) => open.filter((f) => f.kind === k).sort((a, b) => b.occurrences - a.occurrences);
  const recurred = store.findings.filter((f) => f.recurredAfter);
  const sections = [];

  sections.push(`# Learning digest — ${now.slice(0, 10)}`);
  sections.push("");
  sections.push(`Analyzed ${analysis.analyzedTasks ?? "?"} terminal task(s). ${open.length} open finding(s), ${recurred.length} recurred after a founder decision.`);
  sections.push("");

  const patterns = byKind("pattern");
  sections.push("## Top recurring patterns");
  sections.push(patterns.length ? patterns.slice(0, 8).map(bullet).join("\n") : "- none");
  sections.push("");

  const agentImp = byKind("agent-improvement");
  sections.push("## Agent-improvement recommendations");
  sections.push(agentImp.length ? agentImp.slice(0, 8).map(bullet).join("\n") : "- none");
  sections.push("");

  const failures = byKind("failure");
  sections.push("## New / active failure findings");
  sections.push(failures.length ? failures.slice(0, 10).map(bullet).join("\n") : "- none");
  sections.push("");

  const successes = byKind("success");
  sections.push("## Successes to bank");
  sections.push(successes.length ? successes.slice(0, 8).map(bullet).join("\n") : "- none");
  sections.push("");

  if (recurred.length) {
    sections.push("## Recurred after a founder decision");
    sections.push(recurred.map((f) => `- **${f.id}** recurred after \`${f.recurredAfter}\`: ${f.title}`).join("\n"));
    sections.push("");
  }

  sections.push("## How to act");
  sections.push("- `npm run factory:learn -- promote --id <L-id>` to draft a knowledge-file PR.");
  sections.push("- `npm run factory:learn -- dismiss --id <L-id> --reason \"...\"` to close one.");
  sections.push("- Prompt / routing / gate changes are scaffolded as a normal low-risk factory task.");
  sections.push("");

  return sections.join("\n");
}
