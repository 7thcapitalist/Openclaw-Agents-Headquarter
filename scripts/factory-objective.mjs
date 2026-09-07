#!/usr/bin/env node
// Run ONE founder objective as a decomposed, dependency-aware task graph.
//
//   node scripts/factory-objective.mjs start \
//     --objective "Build the onboarding system for LifeMaxing" \
//     --project lifemaxing --repo ~/projects/lifemaxing [--max-concurrent 3] [--dry-run]
//
//   node scripts/factory-objective.mjs status --objective-id obj-xxxxxxxx --repo ~/projects/lifemaxing
//
// Chief of Staff decomposes; the orchestrator runs independent nodes concurrently
// (each a full 7-stage task in its own worktree), then merges the branches and
// runs review/QA/security/release on the combined tree, then opens one PR.

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { decomposeObjective } from "../factory/lib/objective/decompose.mjs";
import { runObjective, readObjState } from "../factory/lib/objective/orchestrator.mjs";
import { defaultStateRoot } from "../factory/lib/natural-language-intake.mjs";

const HQ_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) { out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
    else out._.push(a);
  }
  return out;
}

function objectivesDir(repo) {
  return join(defaultStateRoot(HQ_ROOT, repo), "objectives");
}

function printGraph(obj) {
  console.log(`\nOBJECTIVE ${obj.objectiveId}: ${obj.objective}`);
  console.log(`project ${obj.project}  ·  ${Object.keys(obj.nodes).length} build node(s) + integration\n`);
  for (const n of Object.values(obj.nodes)) {
    const deps = (n.dependsOn || []).map((d) => d.replace(`${obj.objectiveId}-`, "")).join(", ") || "—";
    console.log(`  ${n.id.replace(`${obj.objectiveId}-`, "").padEnd(20)} ${n.role.padEnd(16)} risk=${n.contract.risk.padEnd(6)} depends: ${deps}`);
    console.log(`     ${n.contract.outcome}`);
  }
  console.log(`  integration          (merge + review/qa/security/release)  depends: all\n`);
}

function report(result) {
  const obj = result.objective;
  console.log(`\n================ FOUNDER REPORT ================`);
  console.log(`Objective : ${obj.objective}`);
  console.log(`Id        : ${obj.objectiveId}   Status: ${result.status.toUpperCase()}`);
  console.log(`Project   : ${obj.project}`);
  const m = result.metrics;
  console.log(`Wall time : ${fmt(m.totalDurationMs)}   Max parallel nodes: ${m.maxParallelNodes}\n`);
  console.log(`Nodes:`);
  for (const nm of m.nodes) {
    console.log(`  ${short(nm.id).padEnd(20)} ${String(nm.role).padEnd(16)} ${nm.status.padEnd(16)} ${fmt(nm.durationMs).padEnd(8)} attempts=${nm.attempts}${nm.failedStages.length ? ` failed:[${nm.failedStages.join(",")}]` : ""}`);
    const node = obj.nodes[nm.id];
    if (node?.blocker) console.log(`     BLOCKED: ${node.blocker.summary}`);
  }
  const im = m.integration;
  console.log(`\n  integration          ops              ${im.status.padEnd(16)} ${fmt(im.durationMs)}`);
  if (obj.integration.blocker) console.log(`     BLOCKED: ${obj.integration.blocker.summary}`);
  const gp = obj.integration.githubPublish;
  if (gp) {
    console.log(`\nGitHub: ${gp.published ? (gp.prUrl ? `PR ${gp.prUrl}` : "branch pushed, open PR manually") : `not published (${gp.reason || "?"})`}`);
    if (gp.commitSha) console.log(`        commit ${gp.commitSha} on ${obj.integration.branch}`);
  }
  console.log(`\nDetails  : ${obj.objectiveId} (objective-state.json + metrics.json next to it)`);
  console.log(`===============================================\n`);
}

const fmt = (ms) => (ms == null ? "—" : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);
const short = (id) => id.replace(/^obj-[0-9a-f]{8}-/, "");

async function start(args) {
  const objective = String(args.objective || "").trim();
  const project = String(args.project || "").trim();
  const repo = args.repo ? resolve(String(args.repo)) : "";
  if (!objective || !project || !repo) { console.error("start needs --objective, --project and --repo"); process.exit(1); }
  if (!existsSync(join(repo, ".git"))) { console.error(`${repo} is not a git working tree`); process.exit(1); }

  console.log("Decomposing objective (Chief of Staff)...");
  const obj = await decomposeObjective({ hqRoot: HQ_ROOT, objective, project, repo });
  printGraph(obj);

  const dir = join(objectivesDir(repo), obj.objectiveId);
  mkdirSync(dir, { recursive: true });
  const objectivePath = join(dir, "objective-state.json");
  writeFileSync(objectivePath, `${JSON.stringify(obj, null, 2)}\n`);

  if (args["dry-run"]) { console.log(`--dry-run: graph written to ${objectivePath}, not executed.`); return; }

  const cfg = JSON.parse(readFileSync(join(HQ_ROOT, "factory", "factory.config.json"), "utf8"));
  const result = await runObjective({
    hqRoot: HQ_ROOT,
    objectivePath,
    maxConcurrent: Number(args["max-concurrent"]) || Number(process.env.FACTORY_MAX_CONCURRENT) || 3,
    agentIds: cfg.openclawIntegration?.agentIds || {},
    maxAttemptsPerStage: cfg.openclawIntegration?.maxAttemptsPerStage || 3,
    concurrentGroups: cfg.openclawIntegration?.concurrentGroups,
    stateRoot: defaultStateRoot(HQ_ROOT, repo),
  });
  report(result);
  process.exitCode = result.status === "complete" ? 0 : 2;
}

function status(args) {
  const repo = args.repo ? resolve(String(args.repo)) : "";
  const id = String(args["objective-id"] || "").trim();
  if (!repo || !id) { console.error("status needs --repo and --objective-id"); process.exit(1); }
  const path = join(objectivesDir(repo), id, "objective-state.json");
  if (!existsSync(path)) { console.error(`no such objective: ${path}`); process.exit(1); }
  process.stdout.write(`${readFileSync(path, "utf8")}\n`);
}

function list(args) {
  const repo = args.repo ? resolve(String(args.repo)) : "";
  if (!repo) { console.error("list needs --repo"); process.exit(1); }
  const dir = objectivesDir(repo);
  if (!existsSync(dir)) { console.log("(no objectives)"); return; }
  for (const name of readdirSync(dir)) {
    const p = join(dir, name, "objective-state.json");
    if (!existsSync(p)) continue;
    const o = readObjState(p);
    console.log(`${o.objectiveId}  ${o.status.padEnd(20)} ${o.objective.slice(0, 70)}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === "start") start(args).catch((e) => { console.error(e.message || e); process.exitCode = 1; });
else if (cmd === "status") status(args);
else if (cmd === "list") list(args);
else { console.error("usage: factory-objective start|status|list [--options]"); process.exitCode = 1; }
