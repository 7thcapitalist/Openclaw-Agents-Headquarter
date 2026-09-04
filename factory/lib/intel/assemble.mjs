import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { resolveProjectForState } from "./registry.mjs";
import { validateOwnership } from "./schema.mjs";
import { assertInsideDir, isSecretFilename, scrubText } from "./redact.mjs";

// Character caps per rendered section. Long files contribute a digest, never
// their whole body; the full files are in the agent's worktree.
export const SECTION_BUDGETS = {
  factory: 1400,
  ownership: 1800,
  vision: 700,
  mission: 500,
  roadmap: 700,
  techContext: 1000,
  users: 700,
  competitive: 700,
  memory: 1000,
  decisions: 900,
};

export const CONTEXT_FILES = [
  "PROJECT.md",
  "VISION.md",
  "MISSION.md",
  "ROADMAP.md",
  "DECISIONS.md",
  "MEMORY.md",
  "TECH_CONTEXT.md",
  "USERS.md",
  "COMPETITIVE_CONTEXT.md",
];

const DECISION_PROTOCOL_SUMMARY =
  "continue reversible in-scope work; strategic / irreversible / privacy / spend / " +
  "public / scope changes -> Decision Request; blocking clarification only as a last resort. " +
  "Full protocol: factory/context/DECISION_PROTOCOL.md";

/**
 * Build the Context Pack for one task state. Reads only under
 * hqRoot/factory/context and state.worktree/<contextDir>. Never throws for a
 * missing file, an unregistered project, or unreadable context — it degrades and
 * records a warning. It MAY throw only for a structurally broken
 * factory/projects.json; writeHandoff() catches that.
 *
 * @returns {{ text: string, sections: Record<string,string>, warnings: Array<{code:string,message:string}> }}
 */
export function assembleContextPack({ hqRoot, state, now = new Date() }) {
  const warnings = [];
  const sections = {};

  sections.factory = buildFactorySection(hqRoot, warnings);
  sections.project = buildProjectSection(hqRoot, state, warnings, now);

  const text = `${sections.factory}\n\n${sections.project}`;
  return { text, sections, warnings };
}

function buildFactorySection(hqRoot, warnings) {
  const lines = ["## Factory context (global)", ""];
  let intro = "";
  try {
    const factoryMd = join(resolve(hqRoot), "factory", "context", "FACTORY.md");
    if (existsSync(factoryMd)) intro = firstParagraph(stripComments(readFileSync(factoryMd, "utf8")));
  } catch (error) {
    warnings.push({ code: "factory-context-unreadable", message: error.message });
  }
  if (intro) lines.push(`- ${truncate(intro, 400)}`);

  try {
    const config = JSON.parse(readFileSync(join(resolve(hqRoot), "factory", "factory.config.json"), "utf8"));
    lines.push(`- Operating mode: ${config.mode || "unknown"}.`);
    if (Array.isArray(config.prohibitedAutonomousActions)) {
      lines.push(`- Prohibited autonomous actions: ${config.prohibitedAutonomousActions.join(", ")}.`);
    }
    if (Array.isArray(config.requiredGates)) {
      lines.push(`- Required gates: ${config.requiredGates.join(", ")}.`);
    }
  } catch (error) {
    warnings.push({ code: "factory-config-unreadable", message: error.message });
  }
  lines.push(`- Decision protocol: ${DECISION_PROTOCOL_SUMMARY}`);
  return clampSection(lines.join("\n"), SECTION_BUDGETS.factory, "factory/context/FACTORY.md");
}

function buildProjectSection(hqRoot, state, warnings, now) {
  const entry = resolveProjectForState(hqRoot, state);
  const header = `## Project context: ${entry.name} (key: ${entry.key})`;

  if (!entry.contextDir) {
    warnings.push({ code: "project-unregistered", message: `Project "${entry.key}" is not in factory/projects.json.` });
    return [
      header,
      "",
      `- Project "${entry.key}" is not registered in factory/projects.json — running with factory + task context only.`,
      "- Register it there (key, repo, contextDir) to give this project a durable intelligence layer.",
    ].join("\n");
  }

  const worktree = state?.worktree ? resolve(state.worktree) : null;
  const lines = [header, ""];
  if (!worktree || !existsSync(worktree)) {
    warnings.push({ code: "worktree-missing", message: `Worktree not found: ${worktree}` });
    lines.push(`- Context directory expected at: ${entry.contextDir}/ (worktree not available at assembly time).`);
    return lines.join("\n");
  }

  let base;
  try {
    base = assertInsideDir(worktree, join(worktree, entry.contextDir));
  } catch (error) {
    warnings.push({ code: "context-dir-invalid", message: error.message });
    lines.push(`- context directory path is invalid: ${error.message}`);
    return lines.join("\n");
  }

  const read = (file) => readContextFile(base, file, warnings);

  // ownership.json — the machine mirror
  const ownershipRaw = read("ownership.json");
  if (ownershipRaw == null) {
    warnings.push({ code: "ownership-missing", message: "ownership.json not present or unreadable." });
    lines.push("- ownership.json: not present (raise with the founder / run project-intel scaffold).");
  } else {
    let ownership;
    try {
      ownership = validateOwnership(JSON.parse(ownershipRaw));
    } catch (error) {
      warnings.push({ code: "ownership-invalid", message: error.message });
      lines.push(`- ownership.json: invalid (${error.message}).`);
    }
    if (ownership) lines.push(...renderOwnership(ownership));
  }

  lines.push(...digestLine("Vision", read("VISION.md"), (md) => firstParagraph(md), SECTION_BUDGETS.vision, `${entry.contextDir}/VISION.md`, warnings));
  lines.push(...digestLine("Mission detail", read("MISSION.md"), (md) => firstParagraph(md), SECTION_BUDGETS.mission, `${entry.contextDir}/MISSION.md`, warnings));
  lines.push(...digestLine("Current milestone", read("ROADMAP.md"), (md) => sectionByHeading(md, /current|now|in progress/i) || firstSection(md), SECTION_BUDGETS.roadmap, `${entry.contextDir}/ROADMAP.md`, warnings));
  lines.push(...digestLine("Tech constraints", read("TECH_CONTEXT.md"), (md) => sectionByHeading(md, /constraints|do not|guardrails/i) || firstParagraph(md), SECTION_BUDGETS.techContext, `${entry.contextDir}/TECH_CONTEXT.md`, warnings));
  lines.push(...digestLine("Users", read("USERS.md"), (md) => usersDigest(md), SECTION_BUDGETS.users, `${entry.contextDir}/USERS.md`, warnings));
  lines.push(...digestLine("Competitive wedge", read("COMPETITIVE_CONTEXT.md"), (md) => sectionByHeading(md, /wedge|positioning|differentiat/i) || firstParagraph(md), SECTION_BUDGETS.competitive, `${entry.contextDir}/COMPETITIVE_CONTEXT.md`, warnings));
  lines.push(...digestLine("Recent durable facts", read("MEMORY.md"), (md) => lastBullets(md, 6), SECTION_BUDGETS.memory, `${entry.contextDir}/MEMORY.md`, warnings));
  lines.push(...digestLine("Last accepted decisions", read("DECISIONS.md"), (md) => lastHeadings(md, 5), SECTION_BUDGETS.decisions, `${entry.contextDir}/DECISIONS.md`, warnings));

  lines.push(`- Full context files are in your worktree at: ${entry.contextDir}/`);
  return lines.join("\n");
}

function renderOwnership(ownership) {
  const out = [];
  out.push(`- Mission: ${oneLine(ownership.mission)}`);
  const metrics = (ownership.successMetrics || []).slice(0, 4)
    .map((m) => `${m.name}: ${m.current} -> ${m.target}${m.asOf ? ` (asOf ${m.asOf})` : ""}`);
  if (metrics.length) out.push(`- Success metrics: ${metrics.join("; ")}`);
  const priorities = (ownership.currentPriorities || []).slice(0, 4).map((p) => p.title);
  if (priorities.length) out.push(`- Current priorities: ${priorities.join(", ")}`);
  const risks = (ownership.risks || []).slice(0, 4)
    .map((r) => `${r.title}${r.severity ? ` [${r.severity}]` : ""}${r.mitigation ? "" : " (no mitigation)"}`);
  if (risks.length) out.push(`- Active risks: ${risks.join("; ")}`);
  const open = (ownership.openDecisions || []).slice(0, 6);
  if (open.length) out.push(`- Open decisions blocking work: ${open.join(", ")}`);
  const agents = Object.entries(ownership.responsibleAgents || {}).map(([role, who]) => `${role}=${who}`);
  if (agents.length) out.push(`- Responsible agents: ${agents.join(", ")}`);
  return out;
}

function digestLine(label, raw, transform, budget, pointer, warnings) {
  if (raw == null) return [`- ${label}: not present.`];
  let digest = "";
  try {
    digest = transform(stripComments(raw)) || "";
  } catch (error) {
    warnings.push({ code: `digest-failed:${pointer}`, message: error.message });
  }
  digest = oneLine(digest).replace(new RegExp(`^${escapeRegExp(label)}\\s*[—:-]\\s*`, "i"), "");
  if (!digest) return [`- ${label}: (file present but no usable content — see ${pointer}).`];
  const { text, hits } = scrubText(digest);
  if (hits.length) warnings.push({ code: `secret-redacted:${pointer}`, message: hits.map((h) => `${h.name}x${h.count}`).join(", ") });
  return [`- ${label}: ${truncate(text, budget, pointer)}`];
}

function readContextFile(base, file, warnings) {
  if (isSecretFilename(file)) {
    warnings.push({ code: `secret-filename-skipped:${file}`, message: "refused to read a secret-looking filename." });
    return null;
  }
  let path;
  try {
    path = assertInsideDir(base, file);
  } catch (error) {
    warnings.push({ code: `path-escape:${file}`, message: error.message });
    return null;
  }
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    warnings.push({ code: `context-file-unreadable:${file}`, message: error.message });
    return null;
  }
}

// ---- digest helpers (pure) ----

export function stripComments(md) {
  return String(md || "").replace(/<!--[\s\S]*?-->/g, "");
}

export function firstParagraph(md) {
  const blocks = String(md || "")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .filter((b) => !/^#{1,6}\s/.test(b));
  return blocks[0] || "";
}

export function firstSection(md) {
  const lines = String(md || "").split("\n");
  const start = lines.findIndex((l) => /^#{2,6}\s+/.test(l));
  if (start < 0) return firstParagraph(md);
  const level = lines[start].match(/^(#{2,6})\s+/)[1].length;
  const body = [lines[start].replace(/^#{2,6}\s+/, "")];
  for (let j = start + 1; j < lines.length; j += 1) {
    const next = lines[j].match(/^(#{1,6})\s+/);
    if (next && next[1].length <= level) break;
    body.push(lines[j]);
  }
  return oneLine(body.join(" "));
}

export function sectionByHeading(md, re) {
  const lines = String(md || "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const h = lines[i].match(/^(#{2,6})\s+(.*)$/);
    if (h && re.test(h[2])) {
      const level = h[1].length;
      const body = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j].match(/^(#{1,6})\s+/);
        if (next && next[1].length <= level) break;
        body.push(lines[j]);
      }
      return oneLine(body.join(" "));
    }
  }
  return "";
}

export function usersDigest(md) {
  const first = firstParagraph(md);
  const sensitivity = sectionByHeading(md, /sensitiv|privacy|consent|risk/i);
  return sensitivity ? `${first} Sensitivities: ${sensitivity}` : first;
}

export function lastBullets(md, n) {
  const bullets = String(md || "").split("\n").map((l) => l.trim()).filter((l) => /^[-*]\s+/.test(l));
  return bullets.slice(-n)
    .map((l) => truncate(oneLine(l.replace(/^[-*]\s+/, "")), 160))
    .join(" | ");
}

export function lastHeadings(md, n) {
  const heads = String(md || "").split("\n").map((l) => l.trim()).filter((l) => /^#{2,3}\s+/.test(l));
  return heads.slice(-n).map((l) => l.replace(/^#{2,3}\s+/, "")).join(" | ");
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(text, budget = 600, pointer = null) {
  const s = String(text || "");
  if (s.length <= budget) return s;
  const cut = s.slice(0, budget).replace(/\s+\S*$/, "");
  return `${cut} … (truncated${pointer ? ` — see ${pointer}` : ""})`;
}

function clampSection(text, budget, pointer) {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget).replace(/\s+\S*$/, "")}\n… (section truncated — see ${pointer})`;
}
