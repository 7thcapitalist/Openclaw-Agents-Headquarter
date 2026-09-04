// Structured project brief for the Founder Control Plane.
//
// assemble.mjs turns a project's context files into a prose pack for agent
// handoffs. This module turns the SAME files into structured JSON so the founder
// dashboard can *understand* a project: mission, vision, roadmap, decisions,
// memory, ownership, and risks.
//
// It reads a project's committed context directory (in its own repo working
// tree, not a task worktree). Pure aside from fs reads. Never throws — every
// failure becomes a warning and the brief degrades.

import { existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { readRegistry, resolveProject, resolveRepoPath } from "./registry.mjs";
import { isOwnershipShape, validateOwnership } from "./schema.mjs";
import { firstParagraph, lastBullets, sectionByHeading, stripComments } from "./assemble.mjs";
import { assertInsideDir, scrubText } from "../common/redact.mjs";

export const CRITICAL_FILES = ["PROJECT.md", "MISSION.md", "ROADMAP.md", "ownership.json"];
export const BRIEF_FILES = [
  "PROJECT.md", "VISION.md", "MISSION.md", "ROADMAP.md", "DECISIONS.md",
  "MEMORY.md", "TECH_CONTEXT.md", "USERS.md", "COMPETITIVE_CONTEXT.md", "ownership.json",
];
const DEFAULT_STALENESS_DAYS = 45;
const PROSE_CAP = 900;

// All registered projects, each as a brief.
export function listProjectBriefs({ hqRoot, now = new Date() } = {}) {
  let registry;
  try {
    registry = readRegistry(hqRoot);
  } catch (error) {
    return { briefs: [], error: error.message };
  }
  return { briefs: registry.projects.map((entry) => buildProjectBrief({ hqRoot, entry, now })) };
}

// One brief. Resolve by explicit `entry`, or by `key`, or by `repoPath` match.
export function buildProjectBrief({ hqRoot, key = null, entry = null, repoPath = null, now = new Date() }) {
  const warnings = [];
  let resolved = entry;
  if (!resolved && key) {
    try { resolved = resolveProject(hqRoot, key); } catch (error) { warnings.push(warn("registry-error", error.message)); }
  }
  if (!resolved && repoPath) {
    try {
      const target = resolve(repoPath);
      resolved = readRegistry(hqRoot).projects.find((p) => resolveRepoPath(hqRoot, p) === target) || null;
    } catch (error) { warnings.push(warn("registry-error", error.message)); }
  }

  if (!resolved) {
    return {
      key: key || null, name: key || null, registered: false,
      mission: null, vision: null, roadmap: null, decisions: [], memory: [],
      ownership: null, risks: [], contextFindings: [], warnings,
    };
  }

  const contextDir = resolved.contextDir || "context";
  let dir = null;
  try {
    dir = assertInsideDir(resolveRepoPath(hqRoot, resolved), contextDir);
  } catch (error) {
    warnings.push(warn("context-dir-invalid", error.message));
  }

  const readFile = (name) => {
    if (!dir) return null;
    let path;
    try { path = assertInsideDir(dir, name); } catch (error) { warnings.push(warn(`path-escape:${name}`, error.message)); return null; }
    if (!existsSync(path)) return null;
    try { return { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs }; }
    catch (error) { warnings.push(warn(`unreadable:${name}`, error.message)); return null; }
  };

  const clean = (text) => {
    const { text: scrubbed, hits } = scrubText(String(text || ""));
    if (hits.length) warnings.push(warn("secret-redacted", hits.map((h) => `${h.name}x${h.count}`).join(", ")));
    return scrubbed;
  };
  const digest = (name, transform) => {
    const file = readFile(name);
    if (!file) return null;
    try {
      const value = transform(stripComments(file.text));
      return value ? clean(cap(value, PROSE_CAP)) : null;
    } catch (error) {
      warnings.push(warn(`digest-failed:${name}`, error.message));
      return null;
    }
  };

  // ownership.json — the machine mirror
  let ownership = null;
  const ownershipFile = readFile("ownership.json");
  if (ownershipFile) {
    try {
      ownership = validateOwnership(JSON.parse(ownershipFile.text));
    } catch (error) {
      warnings.push(warn("ownership-invalid", error.message));
    }
  } else {
    warnings.push(warn("ownership-missing", "ownership.json not present"));
  }

  const visionFile = readFile("VISION.md");
  const vision = visionFile ? {
    statement: clean(cap(firstParagraph(stripComments(visionFile.text)), PROSE_CAP)),
    bet: nullableClean(clean, sectionByHeading(stripComments(visionFile.text), /bet|1.?2 year|long/i)),
    nonGoals: listUnder(stripComments(visionFile.text), /non-?goal|will not|out of scope/i).map(clean),
  } : null;

  const roadmapFile = readFile("ROADMAP.md");
  const roadmap = roadmapFile ? parseRoadmap(stripComments(roadmapFile.text), clean) : null;

  const decisionsFile = readFile("DECISIONS.md");
  const decisions = decisionsFile ? parseDecisions(stripComments(decisionsFile.text)).map((d) => ({ ...d, title: clean(d.title), summary: clean(d.summary) })) : [];

  const memoryFile = readFile("MEMORY.md");
  const memory = memoryFile
    ? (lastBullets(stripComments(memoryFile.text), 15) || "").split(" | ").map((s) => clean(cap(s, 240))).filter(Boolean)
    : [];

  const risks = normalizeRisks(ownership?.risks);
  const missionText = ownership?.mission || digest("MISSION.md", firstParagraph) || null;

  return {
    key: resolved.key,
    name: resolved.name || resolved.key,
    registered: true,
    status: resolved.status || "active",
    repo: resolveRepoPath(hqRoot, resolved),
    contextDir,
    mission: missionText ? clean(cap(missionText, PROSE_CAP)) : null,
    missionDetail: digest("MISSION.md", firstParagraph),
    vision,
    roadmap,
    decisions,
    memory,
    techContext: digest("TECH_CONTEXT.md", (md) => sectionByHeading(md, /constraints|do not|guardrail/i) || firstParagraph(md)),
    users: digest("USERS.md", (md) => firstParagraph(md)),
    userSensitivities: digest("USERS.md", (md) => sectionByHeading(md, /sensitiv|privacy|consent/i)),
    competitiveContext: digest("COMPETITIVE_CONTEXT.md", (md) => sectionByHeading(md, /wedge|positioning|differentiat/i) || firstParagraph(md)),
    ownership: ownership ? {
      mission: ownership.mission,
      successMetrics: ownership.successMetrics || [],
      currentPriorities: ownership.currentPriorities || [],
      risks: ownership.risks || [],
      openDecisions: ownership.openDecisions || [],
      responsibleAgents: ownership.responsibleAgents || {},
    } : null,
    risks,
    contextFindings: lintContext({ dir, readFile, now }),
    warnings,
  };
}

// ---- parsers ----

export function parseRoadmap(md, clean = (x) => x) {
  return {
    current: clean(sectionByHeading(md, /current|now|in progress/i) || ""),
    next: listUnder(md, /^next$|upcoming|shortlist/i).map(clean),
    later: listUnder(md, /^later$|future/i).map(clean),
    deferred: listUnder(md, /deferred|explicitly not|won'?t do|not doing/i).map(clean),
  };
}

export function parseDecisions(md) {
  const lines = String(md || "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const h = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!h) continue;
    const heading = h[1].trim();
    const idMatch = heading.match(/^([A-Z]{2,}-\d{4}-\d{2,})\s*[—:-]?\s*(.*)$/);
    const body = [];
    for (let j = i + 1; j < lines.length && !/^##\s+/.test(lines[j]); j += 1) body.push(lines[j]);
    const bodyText = body.join("\n");
    const field = (name) => (bodyText.match(new RegExp(`^[-*]?\\s*${name}:\\s*(.+)$`, "im")) || [])[1]?.trim() || "";
    out.push({
      id: idMatch ? idMatch[1] : null,
      title: idMatch ? (idMatch[2] || idMatch[1]) : heading,
      date: field("Date"),
      status: field("Status") || "Accepted",
      summary: field("Decision"),
    });
  }
  return out.reverse().slice(0, 20);
}

function listUnder(md, re) {
  const lines = String(md || "").split("\n");
  const start = lines.findIndex((l) => { const m = l.match(/^(#{2,6})\s+(.*)$/); return m && re.test(m[2]); });
  if (start < 0) return [];
  const level = lines[start].match(/^(#{2,6})/)[1].length;
  const items = [];
  for (let j = start + 1; j < lines.length; j += 1) {
    const next = lines[j].match(/^(#{1,6})\s+/);
    if (next && next[1].length <= level) break;
    const item = lines[j].match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
    if (item && item[1].trim()) {
      items.push(item[1].trim());
    } else if (items.length && lines[j].trim() && /^\s{2,}\S/.test(lines[j])) {
      items[items.length - 1] = `${items[items.length - 1]} ${lines[j].trim()}`;
    }
  }
  return items.slice(0, 12).map((s) => (s.length > 240 ? `${s.slice(0, 240).replace(/\s+\S*$/, "")} …` : s));
}

function normalizeRisks(risks) {
  if (!Array.isArray(risks)) return [];
  return risks.map((r) => ({
    id: r.id || null,
    title: r.title || "",
    severity: r.severity || "unspecified",
    likelihood: r.likelihood || "unspecified",
    mitigation: r.mitigation || "",
    owner: r.owner || "",
    unmitigated: !r.mitigation || !r.owner,
  }));
}

function lintContext({ dir, readFile, now }) {
  if (!dir) return [{ code: "context-dir-missing", file: null, severity: "error", message: "Context directory not found." }];
  const cutoff = now.getTime() - DEFAULT_STALENESS_DAYS * 24 * 60 * 60 * 1000;
  const findings = [];
  for (const file of [...BRIEF_FILES]) {
    const f = readFile(file);
    if (!f) { findings.push({ code: "missing", file, severity: CRITICAL_FILES.includes(file) ? "error" : "warn", message: "File is not present." }); continue; }
    if (looksLikeUnfilledTemplate(f.text)) {
      findings.push({ code: "thin", file, severity: CRITICAL_FILES.includes(file) ? "warn" : "info", message: "Still looks like the unfilled template." });
    }
    if (f.mtimeMs < cutoff) findings.push({ code: "stale", file, severity: "info", message: `Not updated in ${DEFAULT_STALENESS_DAYS} days.` });
    if (file === "ownership.json") {
      try { if (!isOwnershipShape(JSON.parse(f.text))) findings.push({ code: "ownership-invalid", file, severity: "error", message: "Does not match the ownership schema." }); }
      catch (error) { findings.push({ code: "ownership-invalid", file, severity: "error", message: `Not valid JSON: ${error.message}` }); }
    }
  }
  return findings;
}

// A file is "thin" only when it still carries template scaffolding (a `fill:`
// marker or a bare TODO) or has almost no prose once headings/comments/list
// markers are removed. A short-but-real file is not flagged.
function looksLikeUnfilledTemplate(text) {
  const raw = String(text || "");
  if (/<!--\s*fill:/i.test(raw) || /\bTODO\b/.test(raw)) return true;
  const prose = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((l) => !/^\s*#{1,6}\s/.test(l))
    .join(" ")
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return prose.length < 15;
}

function cap(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")} …`;
}

function nullableClean(clean, value) {
  return value ? clean(cap(value, PROSE_CAP)) : null;
}

function warn(code, message) {
  return { code, message };
}
