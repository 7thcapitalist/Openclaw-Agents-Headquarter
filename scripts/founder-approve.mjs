#!/usr/bin/env node
// Founder-side approval for high-risk factory work.
//
//   npm run approve                # review every pending high-risk build, approve interactively
//   npm run approve -- --list      # just show what is waiting, change nothing
//   npm run approve -- --task <id> # act on one task only
//   npm run approve -- --yes --reason "ship it"   # non-interactive
//
// This is the ONLY place the founder private key is read. It runs in your shell,
// never in the dashboard or an agent. It scans the factory state tree for tasks
// parked at the high-risk gate, shows what each one is asking permission to do,
// and — on your approval — writes the approval evidence, signs the task's
// one-time challenge with your key, and records the verified assertion so the
// factory continues. The dashboard only ever sees the already-verified result.
//
// Private key resolution (first that exists):
//   --key <path>  ·  $FACTORY_FOUNDER_PRIVATE_KEY  ·  ~/.secrets/factory-founder.key

import { createInterface } from "readline";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import {
  createFounderApprovalAssertion,
  isAwaitingFounderApproval,
  readState,
  recordFounderApproval,
  verifyEvidence,
  writeState,
} from "../factory/lib/task-workflow.mjs";
import { writeHandoff } from "../factory/lib/handoff.mjs";

const hqRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_KEY = join(homedir(), ".secrets", "factory-founder.key");
const EVIDENCE_REL = "evidence/founder-approval.md";
const NEXT_STAGES = "builder → reviewer → QA → security → release, then a pull request you merge";

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`founder-approve: ${error.message || error}`);
    process.exitCode = 1;
  });
}

async function main(args) {
  const stateRoot = args["state-root"]
    ? resolve(args["state-root"])
    : join(hqRoot, "dashboard", "backend", "data", "factory");
  let pending = findPending(stateRoot);
  if (args.task) pending = pending.filter((p) => p.state.task.id === args.task);

  if (!pending.length) {
    console.log(args.task
      ? `Nothing to approve: ${args.task} is not waiting for a high-risk approval.`
      : "Nothing is waiting for your approval.");
    return;
  }

  console.log(`${pending.length} high-risk ${pending.length === 1 ? "task is" : "tasks are"} waiting for you:\n`);
  for (const p of pending) printCard(p);

  if (args.list) return;

  const rl = args.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const p of pending) {
      const ok = args.yes || /^y(es)?$/i.test((await ask(rl, `Approve "${short(p.state.task.outcome)}" (${p.state.task.id})? [y/N] `)).trim());
      if (!ok) { console.log(`  skipped ${p.state.task.id}\n`); continue; }
      const reason = args.reason || (rl ? (await ask(rl, "  One-line reason (enter to skip): ")).trim() : "");
      approve(p, { reason, keyPath: resolveKeyPath(args.key) });
    }
  } finally {
    rl?.close();
  }
}

// ── discovery ────────────────────────────────────────────────────────────────

function findPending(stateRoot) {
  const out = [];
  for (const path of walkStateFiles(stateRoot)) {
    let state;
    try { state = readState(path); } catch { continue; }
    if (isAwaitingFounderApproval(state)) out.push({ path, state });
  }
  return out.sort((a, b) => String(a.state.updatedAt).localeCompare(String(b.state.updatedAt)));
}

// Task state files are `<stateRoot>/<project>/tasks/<task-id>/state.json`.
// Objective graphs are `objective-state.json`, so the name check excludes them.
function walkStateFiles(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkStateFiles(full, out);
    else if (entry.name === "state.json") out.push(full);
  }
  return out;
}

// ── presentation ─────────────────────────────────────────────────────────────

function printCard({ state }) {
  const t = state.task;
  console.log(`  ${t.id}`);
  console.log(`    project : ${t.project || basename(state.repo || "")}`);
  console.log(`    doing   : ${t.outcome}`);
  console.log(`    branch  : ${state.branch}`);
  console.log(`    why you : high-risk work is held here until you sign off — no code has been written yet`);
  console.log(`    after   : ${NEXT_STAGES}`);
  console.log("");
}

// ── the approval itself ──────────────────────────────────────────────────────

function approve({ path, state }, { reason, keyPath }) {
  const worktree = resolve(state.worktree);
  if (!existsSync(worktree)) throw new Error(`Task worktree is missing: ${worktree}`);
  const privateKey = readFileSync(keyPath, "utf8");

  const evidenceAbs = join(worktree, EVIDENCE_REL);
  mkdirSync(dirname(evidenceAbs), { recursive: true });
  const approvedAt = new Date().toISOString();
  writeFileSync(evidenceAbs, renderEvidence(state, { reason, approvedAt }), "utf8");

  const [evidence] = verifyEvidence([EVIDENCE_REL], worktree);
  const assertion = createFounderApprovalAssertion(state, { evidencePath: evidenceAbs, privateKey, approvedAt });
  const next = recordFounderApproval(state, { assertion, evidence });
  writeState(path, next);
  if (next.status === "active") writeHandoff({ hqRoot, statePath: path, state: next });

  console.log(`  ✓ approved ${next.task.id} — the factory continues at ${next.currentStage || "the next stage"}\n`);
}

function renderEvidence(state, { reason, approvedAt }) {
  return [
    "# Founder approval — high-risk build",
    "",
    `- Task: ${state.task.id}`,
    `- Project: ${state.task.project || basename(state.repo || "")}`,
    `- Objective: ${state.task.outcome}`,
    `- Challenge: ${state.founderApprovalRequest?.challenge || "(none)"}`,
    `- Approved at: ${approvedAt}`,
    `- Reason: ${reason || "(none given)"}`,
    "",
    "The founder authorised this high-risk build after reviewing what the factory",
    "is asking permission to do. This file is the approval evidence referenced by",
    "the signed assertion in the task state; the private signing key was never",
    "exposed to the factory, its agents, or the dashboard.",
    "",
  ].join("\n");
}

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveKeyPath(explicit) {
  const candidates = [explicit, process.env.FACTORY_FOUNDER_PRIVATE_KEY, DEFAULT_KEY].filter(Boolean);
  for (const c of candidates) if (existsSync(resolve(c))) return resolve(c);
  throw new Error(
    `Founder private key not found. Looked at: ${candidates.map((c) => resolve(c)).join(", ")}. `
    + "Pass --key <path> or set FACTORY_FOUNDER_PRIVATE_KEY.",
  );
}

function ask(rl, prompt) {
  if (!rl) return Promise.resolve("");
  return new Promise((res) => rl.question(prompt, res));
}

function short(text, max = 60) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-y") { out.yes = true; continue; }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const flags = new Set(["list", "yes"]);
      if (flags.has(key)) out[key] = true;
      else { out[key] = argv[i + 1]; i += 1; }
    } else out._.push(a);
  }
  return out;
}

export { findPending, resolveKeyPath, renderEvidence };
