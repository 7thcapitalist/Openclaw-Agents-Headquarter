#!/usr/bin/env node
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  completeStage,
  readState,
  recordFounderApproval,
  resumeState,
  taskStatePath,
  verifyEvidence,
  writeState,
} from "../factory/lib/task-workflow.mjs";
import { writeHandoff } from "../factory/lib/handoff.mjs";
import { initializeTask } from "../factory/lib/task-initializer.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const hqRoot = resolve(scriptDir, "..");
const command = process.argv[2];
const options = parseArgs(process.argv.slice(3));

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    if (command === "init") initTask(options);
    else if (command === "handoff") showHandoff(options);
    else if (command === "complete") recordCompletion(options);
    else if (command === "resume") resumeTask(options);
    else if (command === "approve") approveTask(options);
    else if (command === "status") showStatus(options);
    else usage(1);
  } catch (error) {
    console.error(`factory-task: ${error.message || error}`);
    process.exitCode = 1;
  }
}

function initTask(args) {
  requireOptions(args, "contract", "repo");
  const result = createTaskFromArgs(args);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

export function createTaskFromArgs(args, initializer = initializeTask) {
  return initializer({
    hqRoot,
    contractPath: args.contract,
    repo: args.repo,
    branch: args.branch,
    worktree: args.worktree,
    stateRoot: args["state-root"],
  });
}

function showHandoff(args) {
  const { path, state } = loadTask(args);
  const handoff = writeHandoff({ hqRoot, statePath: path, state });
  process.stdout.write(readFileSync(handoff, "utf8"));
}

function recordCompletion(args) {
  requireOptions(args, "stage", "actor", "outcome", "summary", "evidence");
  const { path, state } = loadTask(args);
  const evidence = verifyEvidence(splitList(args.evidence), state.worktree);
  const next = completeStage(state, {
    stage: args.stage,
    actor: args.actor,
    outcome: args.outcome,
    summary: args.summary,
    evidence,
  });
  writeState(path, next);
  if (next.status === "active") writeHandoff({ hqRoot, statePath: path, state: next });
  console.log(JSON.stringify({ ok: true, task: next.task.id, status: next.status, next: next.currentStage, blocker: next.blocker || null }, null, 2));
  if (next.status === "blocked") process.exitCode = 2;
}

function resumeTask(args) {
  const { path, state } = loadTask(args);
  const next = resumeState(state);
  writeState(path, next);
  writeHandoff({ hqRoot, statePath: path, state: next });
  console.log(JSON.stringify({ ok: true, task: next.task.id, status: next.status, next: next.currentStage }, null, 2));
}

function approveTask(args) {
  requireOptions(args, "task", "repo", "assertion", "evidence");
  const { path, state } = loadTask(args);
  const [evidence] = verifyEvidence([args.evidence], state.worktree);
  const assertion = JSON.parse(readFileSync(resolve(args.assertion), "utf8"));
  const next = recordFounderApproval(state, { assertion, evidence });
  writeState(path, next);
  if (next.status === "active") writeHandoff({ hqRoot, statePath: path, state: next });
  console.log(JSON.stringify({ ok: true, task: next.task.id, status: next.status, founderApproval: next.founderApproval }, null, 2));
}

function showStatus(args) {
  const { state } = loadTask(args);
  console.log(JSON.stringify(state, null, 2));
}

function loadTask(args) {
  requireOptions(args, "task", "repo");
  const repo = gitRoot(args.repo);
  const stateRoot = resolve(args["state-root"] || defaultStateRoot(repo));
  const path = taskStatePath(stateRoot, args.task);
  if (!existsSync(path)) throw new Error(`Task state not found: ${path}`);
  return { path, state: readState(path) };
}

function gitRoot(input) {
  const dir = resolve(input);
  return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function defaultStateRoot(repo) {
  return join(hqRoot, "dashboard", "backend", "data", "factory", basename(repo));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || argv[i + 1] === undefined) usage(1);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

function requireOptions(args, ...names) {
  for (const name of names) if (!args[name]) throw new Error(`Missing --${name}.`);
}

function splitList(value) {
  return String(value).split(",").map((x) => x.trim()).filter(Boolean);
}

function usage(code = 0) {
  console.error(`Usage:
  node scripts/factory-task.mjs init --contract task.json --repo /path/to/repo [--branch factory/id] [--worktree /path]
  node scripts/factory-task.mjs handoff --task id --repo /path/to/repo
  node scripts/factory-task.mjs complete --task id --repo /path/to/repo --stage product --actor openclaw --outcome pass --summary text --evidence path[,path]
  node scripts/factory-task.mjs resume --task id --repo /path/to/repo
  node scripts/factory-task.mjs approve --task id --repo /path/to/repo --assertion /path/to/signed-approval.json --evidence evidence/approval.md
  node scripts/factory-task.mjs status --task id --repo /path/to/repo`);
  process.exit(code);
}
