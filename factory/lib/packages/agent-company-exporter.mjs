// Adapts Paperclip Agent Companies export format at pinned commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { scrubText } from "../common/redact.mjs";
import { lintAgentCompanyPackage } from "./agent-company-linter.mjs";

const PRIVATE_KEYS = new Set(["token", "secret", "password", "privateKey", "memory", "logs", "outputs", "runtimeState"]);

export function exportAgentCompany({ outputDir, company, projects = [], agents = [], skills = [], lint = lintAgentCompanyPackage }) {
  if (!outputDir) throw new Error("outputDir is required"); const root = resolve(outputDir);
  if (existsSync(root) && readdirSync(root).length) throw new Error("outputDir must be empty");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const manifest = { version: 1, format: "agentcompanies/v1-draft", source: "openclaw-startup-hq", generatedFiles: [], omissions: [], transformations: [], provenance: [] };
  const cleanCompany = sanitizeRecord(company || {}, "company", manifest); const companySlug = slug(cleanCompany.slug || cleanCompany.name || "company");
  emit(root, "COMPANY.md", doc({ schema: "agentcompanies/v1", kind: "company", slug: companySlug, name: cleanCompany.name || "OpenClaw Company", description: cleanCompany.description || "", license: cleanCompany.license || "UNLICENSED", includes: [...projects.map((p) => `projects/${slug(p.slug || p.key || p.name)}/PROJECT.md`), ...agents.map((a) => `agents/${slug(a.id || a.name)}/AGENTS.md`)] }, cleanCompany.body || ""), manifest);
  for (const project of projects) { const clean = sanitizeRecord(project, `project:${project.key || project.name}`, manifest); const id = slug(clean.slug || clean.key || clean.name); emit(root, `projects/${id}/PROJECT.md`, doc({ kind: "project", slug: id, name: clean.name || id, description: clean.description || "" }, clean.body || clean.mission || ""), manifest); }
  for (const agent of agents) { const clean = sanitizeRecord(agent, `agent:${agent.id || agent.name}`, manifest); const id = slug(clean.id || clean.name); emit(root, `agents/${id}/AGENTS.md`, doc({ kind: "agent", slug: id, name: clean.name || id, description: clean.responsibility || clean.role || "", reportsTo: clean.reportsTo || null, includes: (clean.skills || []).map((x) => `../../skills/${slug(x)}/SKILL.md`) }, "Org metadata is routing context and does not grant authority."), manifest); }
  for (const skill of skills) { const clean = sanitizeRecord(skill, `skill:${skill.slug || skill.name}`, manifest); const id = slug(clean.slug || clean.name); emit(root, `skills/${id}/SKILL.md`, doc({ kind: "skill", slug: id, name: clean.name || id, license: clean.license || "UNLICENSED" }, clean.body || clean.description || ""), manifest); }
  manifest.generatedFiles.sort((a, b) => a.path.localeCompare(b.path));
  emit(root, "company-export-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, manifest, false);
  const lintResult = lint(root); if (!lintResult?.valid) throw new Error(`Exported package failed lint: ${JSON.stringify(lintResult?.findings || [])}`);
  return { root, manifest, linted: true, lintResult };
}

function sanitizeRecord(value, label, manifest) {
  const out = {}; for (const [key, raw] of Object.entries(value || {})) {
    if (PRIVATE_KEYS.has(key) || /(?:credential|session|absolutePath)/i.test(key)) { manifest.omissions.push({ source: label, field: key, reason: "private-or-runtime-field" }); continue; }
    if (typeof raw === "string") { const scrubbed = scrubText(raw); if (scrubbed.hits.length) { manifest.omissions.push({ source: label, field: key, reason: "secret-shaped-content" }); continue; } out[key] = raw; }
    else if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) out[key] = [...raw];
    else if (raw === null || typeof raw === "boolean" || typeof raw === "number") out[key] = raw;
    else manifest.omissions.push({ source: label, field: key, reason: "unsupported-structured-field" });
  } return out;
}
function emit(root, path, content, manifest, record = true) { const target = resolve(root, path); if (!target.startsWith(`${root}/`)) throw new Error("Export path escapes outputDir"); mkdirSync(resolve(target, ".."), { recursive: true }); writeFileSync(target, content, { mode: 0o600 }); if (record) manifest.generatedFiles.push({ path, sha256: createHash("sha256").update(content).digest("hex") }); }
function doc(fields, body) { const lines = ["---"]; for (const [key, value] of Object.entries(fields)) { if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue; if (Array.isArray(value)) { lines.push(`${key}:`); value.forEach((x) => lines.push(`  - ${scalar(x)}`)); } else lines.push(`${key}: ${scalar(value)}`); } lines.push("---", "", String(body).trim(), ""); return lines.join("\n"); }
function scalar(value) { return JSON.stringify(String(value)); }
function slug(value) { const out = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); if (!out) throw new Error("Cannot derive package slug"); return out; }
