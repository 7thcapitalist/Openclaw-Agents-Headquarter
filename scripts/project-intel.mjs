#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { readRegistry, resolveProject, resolveRepoPath } from "../factory/lib/intel/registry.mjs";
import { assembleContextPack, CONTEXT_FILES } from "../factory/lib/intel/assemble.mjs";
import { classifyDecision, loadDecisionProtocol } from "../factory/lib/intel/classify.mjs";
import { isOwnershipShape } from "../factory/lib/intel/schema.mjs";
import { buildProjectBrief, listProjectBriefs } from "../factory/lib/intel/project-brief.mjs";
import { buildCompanyBriefing } from "../factory/lib/intel/founder-briefing.mjs";
import { readState } from "../factory/lib/task-workflow.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_DIR = join(hqRoot, "factory", "templates", "project-context");
const SCAFFOLD_FILES = [...CONTEXT_FILES, "ownership.json", "README.md"];
const DEFAULT_STALENESS_DAYS = 45;

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const request = await readRequest(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(handleRequest(request), null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ version: 1, status: "error", error: error.message || String(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

export function handleRequest(request) {
  if (!request || request.version !== 1) throw new Error("Unsupported or missing request version.");
  switch (request.action) {
    case "list": return listProjects();
    case "scaffold": return scaffold(requireProject(request));
    case "show": return show(requireProject(request), request.statePath || null);
    case "lint": return lint(requireProject(request), request.stalenessDays || DEFAULT_STALENESS_DAYS);
    case "classify": return classify(request);
    case "brief": return { version: 1, status: "ok", brief: buildProjectBrief({ hqRoot, key: requireProject(request) }) };
    case "briefing": return briefing();
    default: throw new Error(`Unsupported action: ${request.action}`);
  }
}

function listProjects() {
  const registry = readRegistry(hqRoot);
  const projects = registry.projects.map((entry) => {
    const repoPath = resolveRepoPath(hqRoot, entry);
    const contextDir = entry.contextDir || "context";
    const dir = join(repoPath, contextDir);
    const files = Object.fromEntries(SCAFFOLD_FILES.map((f) => [f, existsSync(join(dir, f))]));
    return { key: entry.key, name: entry.name || entry.key, repo: repoPath, contextDir, status: entry.status || "active", files };
  });
  return { version: 1, status: "ok", projects };
}

function scaffold(project) {
  const dir = contextDirFor(project);
  mkdirSync(dir, { recursive: true });
  const created = [];
  const skipped = [];
  for (const file of SCAFFOLD_FILES) {
    const dest = join(dir, file);
    const src = join(TEMPLATE_DIR, file);
    if (!existsSync(src)) continue;
    if (existsSync(dest)) { skipped.push(file); continue; }
    copyFileSync(src, dest);
    created.push(file);
  }
  return { version: 1, status: "ok", dir, created, skipped };
}

function show(project, statePath) {
  const state = statePath ? readState(resolve(statePath)) : syntheticState(project);
  const pack = assembleContextPack({ hqRoot, state });
  return { version: 1, status: "ok", text: pack.text, warnings: pack.warnings };
}

function lint(project, stalenessDays) {
  const entry = resolveProject(hqRoot, project);
  const findings = [];
  if (!entry) {
    return { version: 1, status: "ok", findings: [{ code: "project-unregistered", file: null, severity: "error", message: `${project} is not in factory/projects.json.` }] };
  }
  const dir = contextDirFor(project);
  if (!existsSync(dir)) {
    return { version: 1, status: "ok", findings: [{ code: "context-dir-missing", file: entry.contextDir || "context", severity: "error", message: "Context directory does not exist. Run scaffold." }] };
  }
  const cutoff = Date.now() - stalenessDays * 24 * 60 * 60 * 1000;
  for (const file of [...CONTEXT_FILES, "ownership.json"]) {
    const path = join(dir, file);
    if (!existsSync(path)) { findings.push({ code: "missing", file, severity: "warn", message: "File is not present." }); continue; }
    const raw = readFileSync(path, "utf8");
    const substantive = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/#.*$/gm, "").replace(/TODO/g, "").trim();
    if (substantive.length < 40) findings.push({ code: "thin", file, severity: "warn", message: "File has little content beyond the template." });
    if (statSync(path).mtimeMs < cutoff) findings.push({ code: "stale", file, severity: "info", message: `Not modified in ${stalenessDays} days.` });
    if (file === "ownership.json") {
      try {
        if (!isOwnershipShape(JSON.parse(raw))) findings.push({ code: "ownership-invalid", file, severity: "error", message: "ownership.json does not match the ownership schema." });
      } catch (error) {
        findings.push({ code: "ownership-invalid", file, severity: "error", message: `ownership.json is not valid JSON: ${error.message}` });
      }
    }
  }
  return { version: 1, status: "ok", findings };
}

function classify(request) {
  const protocol = request.protocol || loadDecisionProtocol(hqRoot);
  const result = classifyDecision({ text: request.text || "", fields: request.fields || {}, protocol });
  return { version: 1, status: "ok", ...result };
}

// Company-level view over every registered project. No task state — pure
// context-file signal. The dashboard adds live tasks on top of this.
function briefing() {
  const { briefs, error } = listProjectBriefs({ hqRoot });
  const projects = (briefs || []).map((b) => ({ id: b.key, name: b.name, tasks: [], status: b.status || "active" }));
  const company = buildCompanyBriefing({ briefs: briefs || [], projects, taskDecisions: [] });
  return { version: 1, status: "ok", registryError: error || null, company };
}

function contextDirFor(projectKey) {
  const entry = resolveProject(hqRoot, projectKey);
  if (!entry) throw new Error(`Project not registered: ${projectKey}`);
  return join(resolveRepoPath(hqRoot, entry), entry.contextDir || "context");
}

function syntheticState(projectKey) {
  const entry = resolveProject(hqRoot, projectKey);
  const repo = entry ? resolveRepoPath(hqRoot, entry) : resolve(hqRoot);
  return {
    repo,
    worktree: repo,
    task: { id: "preview", issue: "preview", project: projectKey, outcome: "(preview)", acceptanceCriteria: [], constraints: [] },
    assignments: { product: "openclaw" },
    currentStage: "product",
    stages: {},
    dispatches: [],
    founderDecisions: [],
  };
}

function requireProject(request) {
  if (!request.project || typeof request.project !== "string") throw new Error(`${request.action} requires "project".`);
  return request.project;
}

function requestFromFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { out[key] = true; }
      else { out[key] = next; i += 1; }
    } else if (!out.action) {
      out.action = arg;
    }
  }
  return out;
}

function readRequest(argv) {
  if (argv[0] === "--request" && argv[1]) return JSON.parse(readFileSync(resolve(argv[1]), "utf8"));
  if (argv[0] && argv[0].trim().startsWith("{")) return JSON.parse(argv[0]);
  if (argv[0] && !argv[0].startsWith("-")) return { version: 1, ...requestFromFlags(argv) };
  if (process.stdin.isTTY) return { version: 1, ...requestFromFlags(argv) };
  const chunks = [];
  process.stdin.setEncoding("utf8");
  return new Promise((resolveRequest, reject) => {
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const body = chunks.join("").trim();
      if (!body) return resolveRequest({ version: 1, ...requestFromFlags(argv) });
      try { resolveRequest(JSON.parse(body)); } catch (error) { reject(new Error(`Invalid JSON request: ${error.message}`)); }
    });
  });
}
