#!/usr/bin/env node
// Overnight self-improvement loop.
//
//   node scripts/factory-improve-loop.mjs [--hours 8] [--max-rounds 20]
//        [--gap-min 5] [--project openclaw-factory] [--dry-run]
//        [--objective-path /path/to/objective-state.json] [--not-before ISO_TIME]
// FACTORY_HQ_ROOT may target the canonical HQ while running a repair checkout.
//
// Each round decomposes the standing self-improvement directive
// (factory/prompts/self-improvement-objective.md) into <=4 build nodes and runs
// it to a terminal state, producing PRs the founder reviews. It NEVER merges,
// pushes main, or deploys — the underlying orchestrator forbids that.
//
// Between rounds it watches for provider-credit exhaustion (a barren round plus
// infra/exhaustion blockers, or a recent "auth profile temporarily unavailable"
// on the OpenClaw crons) and backs off — 20m, 45m, 90m, then 180m capped —
// instead of burning the night retrying into a wall. A productive round resets
// the backoff. The loop stops at the wall-clock budget or the round cap.
//
// Runs fine detached (systemd --user / nohup); it only touches the factory
// state tree and git branches.

import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { setTimeout as delay } from "timers/promises";
import { fileURLToPath } from "url";
import { decomposeObjective } from "../factory/lib/objective/decompose.mjs";
import { runObjective, readObjState } from "../factory/lib/objective/orchestrator.mjs";
import { defaultStateRoot } from "../factory/lib/natural-language-intake.mjs";
import { readState, writeState, resumeState } from "../factory/lib/task-workflow.mjs";
import { observeObjectivePrs } from "../factory/lib/hq/pr-observation.mjs";
import { classifyBlocker } from "../factory/lib/hq/blocker-class.mjs";

const execFileAsync = promisify(execFile);
const HQ_ROOT = resolve(process.env.FACTORY_HQ_ROOT || join(dirname(fileURLToPath(import.meta.url)), ".."));
const DIRECTIVE_PATH = join(HQ_ROOT, "factory", "prompts", "self-improvement-objective.md");
const LOG_PATH = join(HQ_ROOT, "dashboard", "backend", "data", "factory", "improve-loop.jsonl");
const BACKOFF_MIN = [20, 45, 90, 180]; // escalating; last value repeats

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

export async function waitForNextRound(ms, signal) {
  try { await delay(ms, undefined, { signal }); }
  catch (error) { if (error.name !== "AbortError") throw error; }
}
const nowIso = () => new Date().toISOString();

function logRound(entry) {
  const line = JSON.stringify({ at: nowIso(), ...entry });
  console.log(line);
  try { mkdirSync(dirname(LOG_PATH), { recursive: true }); appendFileSync(LOG_PATH, `${line}\n`); } catch { /* best effort */ }
}

// Cheap, provider-agnostic credit-pressure read: a recent OpenClaw cron failure
// that names an exhaustion/cooldown, OR the caller says the last round was
// barren. Returns { pressured, reason }.
async function providerPressure({ barrenRound }) {
  const reasons = [];
  if (barrenRound) reasons.push("last round produced no PRs and hit infra/exhaustion blockers");
  try {
    const { stdout } = await execFileAsync("openclaw", ["cron", "list", "--json"], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(stdout || "{}");
    const jobs = Array.isArray(parsed) ? parsed : parsed.jobs || [];
    const rx = /temporarily unavailable|auth profile|rate.?limit|\b429\b|quota|overloaded|cooldown/i;
    for (const j of jobs) {
      const st = j.state || {};
      const lastMs = st.lastRunAtMs || 0;
      if (rx.test(String(st.lastError || "")) && Date.now() - lastMs < 3 * 60 * 60 * 1000) {
        reasons.push(`cron "${j.displayName || j.declarationKey}" hit: ${String(st.lastError).slice(0, 120)}`);
      }
    }
  } catch { /* cron unavailable — rely on the round signal */ }
  return { pressured: reasons.length > 0, reason: reasons.join(" | ") };
}

// A round is "barren" if it shipped nothing and at least one node is stuck on
// an infra/exhaustion-class blocker — the signature of running out of credits
// rather than hitting a real design wall.
export function assessRound(result, observedPrs = []) {
  const obj = result?.objective || {};
  const nodes = Object.values(obj.nodes || {});
  const prs = [];
  for (const n of nodes) {
    const url = n.githubPublish?.prUrl || n.prUrl;
    if (url) prs.push({ node: n.id, url });
  }
  const integPr = obj.integration?.githubPublish?.prUrl;
  if (integPr) prs.push({ node: "integration", url: integPr });
  for (const pr of observedPrs) if (!prs.some((p) => p.url === pr.url)) prs.push(pr);
  const infraBlocked = nodes.filter((n) => n.blocker && classifyBlocker(n.blocker) === "infra").map((n) => n.id);
  const barren = prs.length === 0 && (infraBlocked.length > 0 || classifyBlocker(obj.integration?.blocker) === "infra");
  return { prs, infraBlocked, barren, status: result?.status || "unknown" };
}

// Only the task engine's original infrastructure FAIL may be retried. A node's
// presentation-level decision card is not authority to bypass a real decision.
export function retryableObjective(objectivePath, { resume = false } = {}) {
  const obj = readObjState(objectivePath);
  const failed = [...Object.values(obj.nodes), obj.integration]
    .filter((n) => n && ["blocked", "failed"].includes(n.status));
  if (!failed.length || Object.values(obj.nodes).some((n) => n.status === "running")) return false;
  const tasks = [];
  for (const node of failed) {
    if (!node.statePath) return false;
    const state = readState(node.statePath);
    if (state.status !== "blocked" || classifyBlocker(state.blocker) !== "infra") return false;
    // Integration initialization/merge recovery is separate; don't recreate it.
    if (node.id === obj.integration?.id) return false;
    tasks.push({ path: node.statePath, state });
  }
  if (resume) for (const task of tasks) {
    const revived = resumeState(task.state);
    revived.events.push({ at: new Date().toISOString(), type: "overnight-infra-retry", actor: "system", reason: task.state.blocker.summary });
    writeState(task.path, revived);
  }
  return true;
}

export function assertResumableObjective(obj) {
  if (Object.values(obj.nodes).some((n) => n.status === "running")) {
    throw new Error("Resume objective still has running nodes; verify ownership and recover interrupted dispatches first");
  }
  if (obj.integration?.statePath || obj.integration?.status !== "pending") {
    throw new Error("Integration already started; integration recovery is not supported by the overnight loop");
  }
}

async function runRound({ project, repo, dryRun, resumePath }) {
  const objective = readFileSync(DIRECTIVE_PATH, "utf8").trim();
  const obj = resumePath ? readObjState(resumePath) : await decomposeObjective({ hqRoot: HQ_ROOT, objective, project, repo });
  if (obj.repo !== resolve(repo) || obj.project !== project) throw new Error("Resume objective does not match the selected project/repository");
  if (resumePath) assertResumableObjective(obj);
  const dir = join(defaultStateRoot(HQ_ROOT, repo), "objectives", obj.objectiveId);
  mkdirSync(dir, { recursive: true });
  const objectivePath = resumePath || join(dir, "objective-state.json");
  if (!resumePath) writeFileSync(objectivePath, `${JSON.stringify(obj, null, 2)}\n`);
  logRound({ event: resumePath ? "objective-resumed" : "objective-created", objectiveId: obj.objectiveId, objectivePath });
  if (dryRun) return { objectiveId: obj.objectiveId, status: "dry-run", nodeCount: Object.keys(obj.nodes).length };

  const cfg = JSON.parse(readFileSync(join(HQ_ROOT, "factory", "factory.config.json"), "utf8"));
  const result = await runObjective({
    hqRoot: HQ_ROOT,
    objectivePath,
    maxConcurrent: Number(process.env.FACTORY_MAX_CONCURRENT) || 3,
    agentIds: cfg.openclawIntegration?.agentIds || {},
    maxAttemptsPerStage: cfg.openclawIntegration?.maxAttemptsPerStage || 3,
    concurrentGroups: cfg.openclawIntegration?.concurrentGroups,
    stateRoot: defaultStateRoot(HQ_ROOT, repo),
  });
  const observation = await observeObjectivePrs({ hqRoot: HQ_ROOT, objective: result.objective });
  return { objectiveId: obj.objectiveId, objectivePath, ...assessRound(result, observation.prs), prLookupErrors: observation.errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = String(args.project || "openclaw-factory");
  const repo = HQ_ROOT; // self-improvement always targets this repo
  const hours = Number(args.hours) || 8;
  const maxRounds = Number(args["max-rounds"]) || 20;
  const gapMs = Math.max(0, (Number(args["gap-min"]) || 5)) * 60_000;
  const dryRun = Boolean(args["dry-run"]);
  const deadline = Date.now() + hours * 3_600_000;
  const notBefore = args["not-before"] ? Date.parse(String(args["not-before"])) : Date.now();
  if (!Number.isFinite(notBefore)) throw new Error("--not-before must be an ISO timestamp");

  if (!existsSync(DIRECTIVE_PATH)) { console.error(`missing directive: ${DIRECTIVE_PATH}`); process.exit(1); }
  if (!existsSync(join(repo, ".git"))) { console.error(`${repo} is not a git working tree`); process.exit(1); }

  let resumePath = args["objective-path"] ? resolve(String(args["objective-path"])) : null;
  const idleWait = new AbortController();
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop = true; idleWait.abort(); logRound({ round: null, event: `${sig} — stopping after this round` }); });

  logRound({ event: "loop-start", project, hours, maxRounds, dryRun });
  if (notBefore > Date.now()) {
    logRound({ event: "waiting-for-reset", resumeAfter: new Date(notBefore).toISOString(), deadline: new Date(deadline).toISOString() });
    await waitForNextRound(Math.min(notBefore, deadline) - Date.now(), idleWait.signal);
  }
  let round = 0;
  let backoffIdx = 0;
  let endReason = null;
  const shippedPrs = new Set();

  while (!stop && round < maxRounds && Date.now() < deadline) {
    round += 1;
    const roundStart = Date.now();
    let r;
    try {
      r = await runRound({ project, repo, dryRun, resumePath });
      resumePath = null;
    } catch (error) {
      r = { objectiveId: null, status: "threw", barren: error?.transient === true, infraBlocked: [], prs: [], error: String(error?.message || error) };
    }
    (r.prs || []).forEach((p) => shippedPrs.add(p.url));
    logRound({ round, ...r, elapsedMin: Math.round((Date.now() - roundStart) / 60000) });

    if (dryRun || stop) break;
    if (["blocked", "integration-blocked", "incomplete"].includes(r.status)) {
      if (r.objectivePath && retryableObjective(r.objectivePath)) {
        resumePath = r.objectivePath;
        r.barren = true;
      } else {
        endReason = "recovery-required";
        logRound({ round, event: "stopped-for-recovery", objectiveId: r.objectiveId, reason: "Preserve existing work; recover this objective before starting another round" });
        break;
      }
    }
    if (r.status === "threw" && !r.barren) {
      endReason = "recovery-required";
      logRound({ round, event: "stopped-for-recovery", reason: r.error });
      break;
    }

    const pressure = await providerPressure({ barrenRound: r.barren });
    if (pressure.pressured) {
      const waitMin = BACKOFF_MIN[Math.min(backoffIdx, BACKOFF_MIN.length - 1)];
      backoffIdx += 1;
      const waitMs = Math.min(waitMin * 60_000, Math.max(0, deadline - Date.now()));
      if (waitMs <= 60_000) { logRound({ round, event: "budget-exhausted-during-backoff" }); break; }
      logRound({ round, event: "credit-backoff", reason: pressure.reason, waitMin: Math.round(waitMs / 60000) });
      await waitForNextRound(waitMs, idleWait.signal);
      if (!stop && Date.now() < deadline && resumePath && !retryableObjective(resumePath, { resume: true })) {
        endReason = "recovery-required";
        logRound({ round, event: "stopped-for-recovery", reason: "Objective changed during backoff" });
        break;
      }
    } else {
      backoffIdx = 0; // productive round — reset
      const gap = Math.min(gapMs, Math.max(0, deadline - Date.now()));
      if (gap > 0) await waitForNextRound(gap, idleWait.signal);
    }
  }

  logRound({ event: "loop-end", rounds: round, totalPrs: shippedPrs.size, prs: [...shippedPrs], reason: stop ? "signal" : endReason || (dryRun ? "dry-run" : round >= maxRounds ? "max-rounds" : "budget") });
}

// Run only when invoked directly, not when imported by a test.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e?.stack || e?.message || e); process.exit(1); });
}
