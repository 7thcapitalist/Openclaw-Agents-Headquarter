// Read-only import preview for an Agent Companies package.
//
// Adapted from Paperclip's `company-portability` and `company-import-transfers`
// services at pinned commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
// Issue #124.
//
//   package -> lint -> parse -> normalize -> sanitized preview -> proposed diff
//
// EVERY STEP IS READ-ONLY. This module opens files under the package directory
// and reads HQ's registries. It writes nothing — not a registry, not a prompt,
// not configuration, not runtime state — and exports no function that could.
// A test asserts the export surface, because an import module that can apply is
// an import module that will, eventually, apply something nobody reviewed.
//
// What comes out is a PROPOSAL: what would be added, what would change, and
// what conflicts. Turning a proposal into reality is an ordinary pull request
// against factory/agents.json and factory/projects.json, reviewed and merged by
// a human like any other change. That is the whole point of keeping HQ's
// registries in Git.

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join, relative, resolve } from "path";
import { isSecretFilename, scrubText } from "../common/redact.mjs";
import { lintAgentCompanyPackage, parseFrontmatter } from "./agent-company-linter.mjs";

const ENTRY_KIND = Object.freeze({
  "COMPANY.md": "company",
  "TEAM.md": "team",
  "AGENTS.md": "agent",
  "PROJECT.md": "project",
  "SKILL.md": "skill",
});

// Only these fields are ever read out of a package. A package is third-party
// content, so the parser takes what it understands and ignores the rest rather
// than carrying unknown keys into a diff a human is meant to trust.
const AGENT_FIELDS = ["name", "slug", "role", "responsibility", "reportsTo", "harness", "stages"];
const PROJECT_FIELDS = ["name", "slug", "mission", "repo", "status"];
const SKILL_FIELDS = ["name", "slug", "summary"];

const MAX_TEXT = 500;
const MAX_ENTRIES = 200;

export function previewAgentCompanyImport({ packageDir, hqRoot, lint = lintAgentCompanyPackage }) {
  const base = resolve(packageDir);
  const lintResult = lint(base);

  // A package that fails linting is not parsed at all. Producing a diff from
  // content already known to be malformed or secret-bearing would put exactly
  // the wrong thing in front of a reviewer.
  if (!lintResult.valid) {
    return {
      version: 1,
      applied: false,
      readOnly: true,
      status: "rejected",
      reason: "The package did not pass linting, so no diff was produced.",
      lint: lintResult,
      entries: [],
      diff: emptyDiff(),
    };
  }

  const parsed = parsePackage(base);
  const registries = readRegistries(hqRoot);

  return {
    version: 1,
    // Restated in the payload so no consumer can mistake this for an apply.
    applied: false,
    readOnly: true,
    status: "preview",
    lint: lintResult,
    entries: parsed.entries,
    warnings: parsed.warnings,
    diff: diffAgainstHq(parsed.entries, registries),
    // Named explicitly: this is what a human would have to change, by hand,
    // through a reviewed pull request.
    appliesTo: ["factory/agents.json", "factory/projects.json"],
  };
}

// ------------------------------------------------------------------ internals

function parsePackage(base) {
  const entries = [];
  const warnings = [];

  for (const path of walk(base)) {
    const rel = relative(base, path).replaceAll("\\", "/");
    // Belt and braces: the linter already rejects these, but a parser that
    // trusts an earlier pass is a parser that breaks when the passes are
    // reordered.
    if (isSecretFilename(path)) continue;
    const kind = ENTRY_KIND[basename(path)];
    if (!kind) continue;
    if (entries.length >= MAX_ENTRIES) {
      warnings.push(`package contains more than ${MAX_ENTRIES} entries; the rest were not parsed`);
      break;
    }

    let frontmatter;
    try {
      frontmatter = parseFrontmatter(readFileSync(path, "utf8"));
    } catch (error) {
      warnings.push(`${rel}: ${error.message}`);
      continue;
    }

    const fields = kind === "agent" ? AGENT_FIELDS : kind === "project" ? PROJECT_FIELDS : SKILL_FIELDS;
    const record = { kind, path: rel, id: slugOf(frontmatter) };
    for (const field of fields) {
      if (frontmatter[field] == null) continue;
      record[field] = Array.isArray(frontmatter[field])
        ? frontmatter[field].map((value) => sanitize(value)).slice(0, 20)
        : sanitize(frontmatter[field]);
    }
    entries.push(record);
  }

  return { entries, warnings };
}

function diffAgainstHq(entries, registries) {
  const diff = emptyDiff();

  for (const entry of entries) {
    if (entry.kind === "agent") classify(entry, registries.agents, diff.agents, compareAgent);
    else if (entry.kind === "project") classify(entry, registries.projects, diff.projects, compareProject);
    else if (entry.kind === "skill") diff.skills.added.push({ id: entry.id, name: entry.name || null, path: entry.path });
    else diff.other.push({ kind: entry.kind, id: entry.id, path: entry.path });
  }

  // Reporting relationships are the part of a company package most likely to
  // conflict quietly, so a parent that exists in neither the package nor HQ is
  // called out rather than imported as a dangling reference.
  const known = new Set([
    "founder",
    ...registries.agents.map((agent) => agent.id),
    ...entries.filter((entry) => entry.kind === "agent").map((entry) => entry.id),
  ]);
  for (const entry of entries) {
    if (entry.kind !== "agent" || !entry.reportsTo || known.has(entry.reportsTo)) continue;
    diff.conflicts.push({
      kind: "agent", id: entry.id, field: "reportsTo",
      reason: `reports to '${entry.reportsTo}', which exists in neither the package nor HQ`,
    });
  }

  diff.summary = {
    added: diff.agents.added.length + diff.projects.added.length + diff.skills.added.length,
    changed: diff.agents.changed.length + diff.projects.changed.length,
    unchanged: diff.agents.unchanged.length + diff.projects.unchanged.length,
    conflicts: diff.conflicts.length,
  };
  return diff;
}

function classify(entry, existing, bucket, compare) {
  const match = existing.find((item) => item.id === entry.id || item.key === entry.id);
  if (!match) {
    bucket.added.push(entry);
    return;
  }
  const changes = compare(entry, match);
  if (changes.length) bucket.changed.push({ id: entry.id, path: entry.path, changes });
  else bucket.unchanged.push({ id: entry.id, path: entry.path });
}

function compareAgent(entry, existing) {
  return fieldChanges(entry, existing, [["name", "name"], ["role", "role"], ["responsibility", "responsibility"], ["reportsTo", "reportsTo"], ["harness", "harness"]]);
}

function compareProject(entry, existing) {
  return fieldChanges(entry, existing, [["name", "name"], ["mission", "mission"], ["repo", "repo"], ["status", "status"]]);
}

function fieldChanges(entry, existing, pairs) {
  const out = [];
  for (const [from, to] of pairs) {
    if (entry[from] == null) continue;
    const current = existing[to] == null ? null : sanitize(existing[to]);
    if (current !== entry[from]) out.push({ field: to, current, proposed: entry[from] });
  }
  return out;
}

function readRegistries(hqRoot) {
  return {
    agents: readList(join(resolve(hqRoot), "factory", "agents.json"), "agents"),
    projects: readList(join(resolve(hqRoot), "factory", "projects.json"), "projects"),
  };
}

function readList(path, key) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.[key]) ? parsed[key] : [];
  } catch {
    // A registry HQ cannot read means every package entry looks new. That is
    // the safe direction for a preview: it over-reports additions rather than
    // silently claiming something already exists.
    return [];
  }
}

function slugOf(frontmatter) {
  const raw = String(frontmatter.slug || frontmatter.name || "").trim().toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "unnamed";
}

// Package text is third-party content. Scrub it, strip anything that could be
// mistaken for markup by a consumer, and bound it.
function sanitize(value) {
  const { text } = scrubText(String(value ?? ""));
  return text.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

function emptyDiff() {
  return {
    agents: { added: [], changed: [], unchanged: [] },
    projects: { added: [], changed: [], unchanged: [] },
    skills: { added: [] },
    other: [],
    conflicts: [],
    summary: { added: 0, changed: 0, unchanged: 0, conflicts: 0 },
  };
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    // Never follow a link out of the package: a symlinked COMPANY.md pointing
    // at ~/.ssh would otherwise be read and diffed.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && safeSize(path)) out.push(path);
  }
  return out;
}

function safeSize(path) {
  try {
    return statSync(path).size <= 1_000_000;
  } catch {
    return false;
  }
}
