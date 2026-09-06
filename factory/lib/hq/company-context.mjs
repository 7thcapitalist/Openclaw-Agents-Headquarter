// Feature 6 — connect the company layer to the intelligence layer.
//
// intel/assemble.mjs builds `factory context + project context` for a stage
// handoff. This EXTENDS that (it does not replace it) with a leading
// "Company context" section so an agent working on a project also knows:
//   - the company it is inside and how HQ relates to projects
//   - this project's current priority, risks, and any founder decision it is
//     waiting on
//
// Project isolation is preserved: the company section only ever contains the
// company mission plus signals for THE PROJECT the agent is working on. It never
// mentions another project (see founder/FOUNDER_OPERATING_SYSTEM.md §4).

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { assembleContextPack, firstParagraph, stripComments } from "../intel/assemble.mjs";
import { resolveProjectForState } from "../intel/registry.mjs";
import { scrubText } from "../common/redact.mjs";

const COMPANY_BUDGET = 1200;

/**
 * Build only the leading company section for one task state.
 * @returns {{ text: string, warnings: Array }}
 */
export function buildCompanyContextSection({ hqRoot, state, companyState = null, now = new Date() }) {
  const warnings = [];
  const lines = ["## Company context", ""];

  // Company mission, from HQ's own context directory.
  const mission = readCompanyMission(hqRoot, warnings);
  if (mission) lines.push(`- Company: ${clip(mission, 400)}`);
  lines.push(
    "- Headquarters owns infrastructure (agents, workflows, memory, quality). Projects own mission, users, roadmap, product decisions."
  );
  lines.push("- Project contexts are isolated. Do not carry knowledge between projects unless the founder transferred it.");

  // This project's live signals — project-scoped only.
  const entry = resolveProjectForState(hqRoot, state);
  const projectKey = entry?.key || state?.task?.project || null;
  if (companyState && projectKey) {
    const row = (companyState.projects || []).find((p) => p.key === projectKey);
    if (row) {
      if (row.health?.level) lines.push(`- Project health: ${row.health.level} (${row.health.score}/100).`);
      const priorities = row.intelligencePriorities || [];
      if (priorities.length) lines.push(`- Current priority: ${priorities.slice(0, 2).join("; ")}`);
      const openRisks = (row.risks || []).filter((r) => r.unmitigated).slice(0, 3).map((r) => r.title);
      if (openRisks.length) lines.push(`- Current risks: ${openRisks.join("; ")}`);
    }
    const projectDecisions = (companyState.decisions || []).filter((d) => d.project === projectKey);
    if (projectDecisions.length) {
      lines.push(`- Founder decisions pending on this project: ${projectDecisions.map((d) => clip(d.question, 120)).join(" | ")}`);
    }
  }

  const { text: scrubbed } = scrubText(lines.join("\n"));
  return { text: clampSection(scrubbed, COMPANY_BUDGET), warnings };
}

/**
 * The full agent context pack: company context + factory context + project
 * context. Delegates the factory/project sections to intel/assemble.mjs
 * unchanged, so the proven assembler stays the single owner of that logic.
 *
 * @returns {{ text: string, sections: Record<string,string>, warnings: Array }}
 */
export function assembleAgentContext({ hqRoot, state, companyState = null, now = new Date() }) {
  const base = assembleContextPack({ hqRoot, state, now });
  const company = buildCompanyContextSection({ hqRoot, state, companyState, now });
  const sections = { company: company.text, ...base.sections };
  return {
    text: `${company.text}\n\n${base.text}`,
    sections,
    warnings: [...company.warnings, ...base.warnings],
  };
}

// ---- helpers ----

function readCompanyMission(hqRoot, warnings) {
  const ownership = join(resolve(hqRoot), "context", "ownership.json");
  try {
    if (existsSync(ownership)) {
      const parsed = JSON.parse(readFileSync(ownership, "utf8"));
      if (parsed && typeof parsed.mission === "string" && parsed.mission.trim()) return parsed.mission.trim();
    }
  } catch (error) {
    warnings.push({ code: "company-ownership-unreadable", message: error.message });
  }
  const missionMd = join(resolve(hqRoot), "context", "MISSION.md");
  try {
    if (existsSync(missionMd)) {
      const para = firstParagraph(stripComments(readFileSync(missionMd, "utf8")));
      if (para) return para;
    }
  } catch (error) {
    warnings.push({ code: "company-mission-unreadable", message: error.message });
  }
  return null;
}

function clip(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")} …`;
}

function clampSection(text, budget) {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget).replace(/\s+\S*$/, "")}\n… (company section truncated)`;
}
