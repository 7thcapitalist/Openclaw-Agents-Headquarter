// Adapted from Paperclip's Agent Companies draft at pinned commit
// 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT).
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, relative, resolve } from "path";
import { isSecretFilename, scrubText } from "../common/redact.mjs";

const ENTRY_FILES = new Set(["COMPANY.md", "TEAM.md", "AGENTS.md", "PROJECT.md", "TASK.md", "SKILL.md"]);
const KIND = { "COMPANY.md": "company", "TEAM.md": "team", "AGENTS.md": "agent", "PROJECT.md": "project", "TASK.md": "task", "SKILL.md": "skill" };

export function lintAgentCompanyPackage(root) {
  const base = resolve(root); const findings = []; const files = [];
  if (!existsSync(base) || !statSync(base).isDirectory()) return result([{ level: "error", code: "package-missing", path: ".", message: "Package directory does not exist" }], files);
  for (const path of walk(base)) {
    const rel = relative(base, path).replaceAll("\\", "/");
    if (isSecretFilename(path)) { findings.push(finding("error", "private-file", rel, "Secret-shaped files are forbidden")); continue; }
    if (!ENTRY_FILES.has(basename(path))) continue;
    files.push(rel); const text = readFileSync(path, "utf8"); const { hits } = scrubText(text);
    if (hits.length) findings.push(finding("error", "secret-content", rel, `Secret-shaped content detected: ${hits.map((x) => x.name).join(", ")}`));
    let frontmatter; try { frontmatter = parseFrontmatter(text); } catch (error) { findings.push(finding("error", "frontmatter-invalid", rel, error.message)); continue; }
    if (!frontmatter.name) findings.push(finding("error", "name-missing", rel, "name is required"));
    const expected = KIND[basename(path)]; if (frontmatter.kind && frontmatter.kind !== expected) findings.push(finding("error", "kind-mismatch", rel, `kind must be ${expected}`));
    if (frontmatter.slug && !/^[a-z0-9][a-z0-9-]*$/.test(frontmatter.slug)) findings.push(finding("error", "slug-invalid", rel, "slug must be a lowercase URL-safe value"));
    for (const ref of list(frontmatter.includes)) checkReference(ref, rel, findings);
    for (const source of list(frontmatter.sources)) checkReference(source, rel, findings);
    if ([...list(frontmatter.includes), ...list(frontmatter.sources)].some((x) => /^https?:/.test(x)) && !frontmatter.license) findings.push(finding("warning", "license-missing", rel, "External material requires explicit license metadata"));
  }
  if (!files.some((x) => basename(x) === "COMPANY.md")) findings.push(finding("warning", "company-entry-missing", ".", "No COMPANY.md entrypoint found"));
  return result(findings, files);
}

export function parseFrontmatter(text) {
  const lines = String(text).split(/\r?\n/); if (lines[0] !== "---") return {};
  const end = lines.indexOf("---", 1); if (end < 0) throw new Error("Frontmatter is not closed");
  const out = {}; let active = null;
  for (const raw of lines.slice(1, end)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const item = raw.match(/^\s+-\s+(.+)$/); if (item) { if (!active || !Array.isArray(out[active])) throw new Error("List item has no parent key"); out[active].push(unquote(item[1])); continue; }
    const match = raw.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/); if (!match) throw new Error(`Unsupported frontmatter line: ${raw.trim()}`);
    active = match[1]; out[active] = match[2] ? unquote(match[2]) : [];
  }
  return out;
}

function checkReference(ref, path, findings) {
  if (typeof ref !== "string") return;
  if (/^https?:/.test(ref)) { if (!/\/blob\/[0-9a-f]{40}\//.test(ref)) findings.push(finding("error", "mutable-reference", path, `External reference is not pinned to a full commit: ${ref}`)); return; }
  if (ref.startsWith("/") || ref.split(/[\\/]/).includes("..")) findings.push(finding("error", "unsafe-reference", path, `Reference escapes package: ${ref}`));
}
function walk(dir) { const out = []; for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = resolve(dir, entry.name); if (entry.isDirectory()) out.push(...walk(path)); else if (entry.isFile()) out.push(path); } return out; }
function list(value) { return Array.isArray(value) ? value : value ? [value] : []; }
function unquote(value) { return String(value).trim().replace(/^(?:"(.*)"|'(.*)')$/, (_, a, b) => a ?? b); }
function finding(level, code, path, message) { return { level, code, path, message }; }
function result(findings, files) { return { version: 1, valid: !findings.some((x) => x.level === "error"), files: files.sort(), findings: findings.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)) }; }
