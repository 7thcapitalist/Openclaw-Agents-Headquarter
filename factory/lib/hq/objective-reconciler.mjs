// "An objective nobody is running is not an objective that is waiting."
//
// The orchestrator is a function, not a daemon. runObjective() schedules an
// objective's ready nodes and returns when there is nothing left it can drive;
// while it runs, it lives inside whichever process called it — in production,
// the dashboard's express process.
//
// So every dashboard restart abandons whatever was mid-flight. The nodes keep
// the status they held at the moment the process died — `pending`, or `running`
// with no runner — and nothing ever looks at them again. The objective sits at
// `active` forever, and the founder's view shows work that is not moving and
// does not say why.
//
// Nothing else covers this. `retryStuckTasks` scans for task state files that
// are `blocked` on an infra-class blocker; a node that was never dispatched has
// no state file at all, and a node abandoned mid-run is not `blocked`. On
// 2026-09-15 obj-2fbb6bcd sat decomposed-but-never-started for four hours, with
// two `pending` nodes, no task states, and no sweep that could see it.
//
// This runs once at boot, which is the only moment the question is easy: no
// objective can have a live runner in a process that has just started. A node
// found `pending` or `running` here is, by construction, owned by nobody.
//
// It schedules; it does not repair — with one exception it cannot delegate.
// runObjective is idempotent and self-healing for a node that is `blocked` or
// `failed`: it puts those back to `pending` when their task state went active,
// releases `blocked-by-dep` descendants, and re-asserts `active`. But it starts
// work only from `readyNodes`, which is `pending` alone, so a node abandoned at
// `running` matches neither path and runObjective cannot revive it — it finds
// nothing ready, calls the objective deadlocked, and writes it `incomplete`,
// telling the founder the work ended when a restart is all that happened.
//
// So an abandoned node goes through resumeObjectiveNodes FIRST, which is the
// machinery the founder's own recovery button already uses: it retires the
// stuck dispatch, re-arms the stage, and puts the node back to `pending`, where
// runObjective can see it. Its staleness guard earns its keep here too — see
// resumeStrandedObjectives.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { readObjState, resumeObjectiveNodes, settleSupersededObjective, CANCELLED } from "../objective/orchestrator.mjs";
import { runnerStatus } from "../objective/runner-lease.mjs";
import { readState } from "../task-workflow.mjs";
import { readyNodes, GATE_SATISFIED } from "../objective/graph.mjs";

// objectives live at <stateRoot>/<project>/objectives/<id>/objective-state.json
function findObjectiveStates(stateRoot, out = []) {
  let projects = [];
  try { projects = readdirSync(stateRoot, { withFileTypes: true }); } catch { return out; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(stateRoot, project.name, "objectives");
    let objectives = [];
    try { objectives = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const objective of objectives) {
      if (!objective.isDirectory()) continue;
      const path = join(dir, objective.name, "objective-state.json");
      if (existsSync(path)) out.push(path);
    }
  }
  return out;
}

// How many times the periodic sweep has resumed each objective in this process.
// In-memory by design: a restart is a fresh look, and boot has its own rules.
const periodicResumes = new Map();

const FINISHED_OBJECTIVE_STATES = new Set([CANCELLED, "complete", "completed", "superseded"]);

// What the node's own task state says about itself, or null when it has none.
// Injectable so strandedNodes stays testable without a filesystem.
function taskStatusOnDisk(node) {
  const path = node?.statePath;
  if (!path || !existsSync(path)) return null;
  try { return readState(path)?.status ?? null; } catch { return null; }
}

/**
 * Decide whether an objective has work that nobody is running.
 *
 * Exported because the decision is the interesting part and deserves to be
 * tested without a filesystem or a runner behind it.
 *
 * `ready` and `abandoned` are reported separately because they need different
 * handling: a ready node only needs a scheduler, an abandoned one needs its
 * dispatch retired first.
 *
 * @param {object} objective  parsed objective-state.json
 * @returns {{stranded:boolean, reason:string, nodeIds:string[], ready:string[], abandoned:string[]}}
 */
export function strandedNodes(objective, { taskStatusOf = taskStatusOnDisk } = {}) {
  const nothing = (reason) => ({ stranded: false, reason, nodeIds: [], ready: [], abandoned: [], revivable: [] });
  if (!objective || typeof objective !== "object") return nothing("unreadable");
  if (FINISHED_OBJECTIVE_STATES.has(objective.status)) {
    return nothing(`objective is ${objective.status}`);
  }

  const nodes = objective.nodes || {};
  // READY, not merely `pending`. A node whose dependencies are blocked or
  // failed is `pending` because it is correctly waiting its turn, and handing
  // that objective to runObjective would schedule nothing — but runObjective
  // re-asserts `status = "active"` unconditionally, so a genuinely blocked
  // objective would be relabelled as running work that does not exist.
  //
  // Eight of the ten objectives on this machine on 2026-09-15 were exactly
  // that shape: week-old, `blocked`, every build node blocked or failed, and an
  // integration node sitting `pending` behind them. Resuming those would have
  // corrupted the founder's view of what the company is doing.
  //
  // readyNodes is the orchestrator's own scheduling predicate, imported rather
  // than restated so the two can never disagree about what "ready" means.
  const ready = readyNodes(objective);

  // The integration node is a node too, and it strands the same way — but it
  // lives beside `nodes`, so readyNodes cannot see it.
  const integration = objective.integration;
  if (integration?.id && integration.status === "pending"
      && (integration.dependsOn || []).every((dep) => nodes[dep]?.status === GATE_SATISFIED)) {
    ready.push(integration.id);
  }

  // A node left `running` is owned by a process that no longer exists — at boot
  // nothing can be running. This is the one state readyNodes does not cover,
  // because mid-run is not a thing the scheduler ever needs to ask about.
  const abandoned = [...Object.values(nodes), ...(integration?.id ? [integration] : [])]
    .filter((node) => node?.status === "running")
    .map((node) => node.id);

  // A node recorded `blocked` or `failed` whose TASK state is back to `active`
  // is work the orchestrator would revive on sight — runObjective puts exactly
  // that shape back to `pending`. The header above already leans on that, but
  // the sweep never handed runObjective such an objective: readyNodes skips a
  // blocked node and the abandoned filter matches only `running`, so the whole
  // objective read as healthy and nothing ever called the healer.
  //
  // obj-47cf7355 sat in that gap on 2026-09-15. Its builder passed and handed
  // off to the reviewer; the dashboard restarted; the task stayed `active` at
  // the reviewer stage with no dispatch and no runner, while its node was still
  // recorded `blocked` from an earlier recovery. The sweep called it healthy and
  // walked past the one objective on the machine that was genuinely abandoned.
  //
  // These need no reviving of their own — runObjective repairs them — so they
  // are reported separately from `abandoned`, which does.
  const revivable = [...Object.values(nodes), ...(integration?.id ? [integration] : [])]
    .filter((node) => (node?.status === "blocked" || node?.status === "failed")
      && taskStatusOf(node) === "active")
    .map((node) => node.id);

  const nodeIds = [...new Set([...ready, ...abandoned, ...revivable])];
  if (!nodeIds.length) return nothing("no node is ready to run");
  return { stranded: true, reason: `${nodeIds.length} node(s) ready with no runner`, nodeIds, ready, abandoned, revivable };
}

/**
 * Hand every stranded objective back to the orchestrator.
 *
 * @param {object}   input
 * @param {string}   input.hqRoot
 * @param {string}   input.stateRoot          directory to scan for objective states
 * @param {Function} input.runObjective       injected orchestrator (required; tests pass a spy)
 * @param {number}  [input.max=10]            objectives started per sweep, so a boot after a long outage cannot start fifty runs at once
 * @param {Function}[input.resumeNodes]       injected node reviver (tests pass a spy)
 * @param {Function}[input.readConfig]
 * @param {Function}[input.log]
 * @returns {Promise<{scanned:number, resumed:Array, skipped:Array}>}
 */
export async function resumeStrandedObjectives({
  hqRoot,
  stateRoot,
  runObjective,
  resumeNodes = resumeObjectiveNodes,
  settle = settleSupersededObjective,
  ownerOf = runnerStatus,
  mode = "boot",
  history = periodicResumes,
  maxPeriodicResumes = 3,
  max = 10,
  readConfig = () => {
    try { return JSON.parse(readFileSync(join(hqRoot, "factory", "factory.config.json"), "utf8")); }
    catch { return {}; }
  },
  log = () => {},
}) {
  if (typeof runObjective !== "function") throw new Error("runObjective is required");

  const paths = findObjectiveStates(stateRoot);
  const cfg = readConfig();
  const resumed = [];
  const skipped = [];

  for (const objectivePath of paths) {
    if (resumed.length >= max) {
      skipped.push({ objectivePath, reason: `sweep limit of ${max} reached` });
      continue;
    }

    let objective;
    // One unreadable or half-written state file must never stop the sweep —
    // the objectives after it in the scan are the ones still worth starting.
    try { objective = readObjState(objectivePath); } catch (error) {
      skipped.push({ objectivePath, reason: `unreadable: ${String(error?.message || error).slice(0, 120)}` });
      continue;
    }

    // Work that is done but that nothing will ever mark done. Settled before
    // anything else, because an objective in this shape has no node to resume
    // and would otherwise be skipped as "nothing ready" every sweep, forever.
    try {
      if (settle(objectivePath)) {
        log(`[objective-reconcile] ${objective.objectiveId} is complete: every build node passed and its integration was superseded`);
        skipped.push({ objectivePath, objectiveId: objective.objectiveId, reason: "settled as complete" });
        continue;
      }
    } catch (error) {
      log(`[objective-reconcile] ${objective.objectiveId} could not be settled: ${String(error?.message || error).slice(0, 160)}`);
    }

    // A process is driving this objective right now — this one, or a terminal.
    // Leave it completely alone: resuming a ready node here would start a
    // second scheduler on the same graph. This is what makes it safe to run the
    // sweep on a timer and not only at boot.
    const owner = ownerOf(objective.runner, objectivePath);
    if (owner === "live") {
      skipped.push({ objectivePath, objectiveId: objective.objectiveId, reason: `run in progress (pid ${objective.runner?.pid})` });
      continue;
    }

    const verdict = strandedNodes(objective);
    if (!verdict.stranded) {
      skipped.push({ objectivePath, objectiveId: objective.objectiveId, reason: verdict.reason });
      continue;
    }

    // The timer is narrower than boot, on purpose. Boot adopts anything ready
    // with no runner, once. Repeating THAT every ten minutes would re-dispatch
    // an objective that genuinely finished blocked, fail, and do it again —
    // a paid agent run every ten minutes, indefinitely. So a periodic sweep
    // only takes a run whose owner is proven dead, or a node left mid-run
    // (still protected by the age guard when no owner was recorded), and it
    // gives each objective a small budget per process lifetime.
    if (mode === "periodic") {
      const orphaned = owner === "gone" || verdict.abandoned.length > 0;
      if (!orphaned) {
        skipped.push({ objectivePath, objectiveId: objective.objectiveId, reason: "left for boot: ready work with no dead runner" });
        continue;
      }
      const used = history.get(objectivePath) || 0;
      if (used >= maxPeriodicResumes) {
        skipped.push({ objectivePath, objectiveId: objective.objectiveId, reason: `periodic resume budget spent (${used}); needs a restart or the founder's Retry` });
        continue;
      }
    }

    // A node left `running` has to be revived before the scheduler can see it;
    // handing the objective straight to runObjective would relabel it
    // `incomplete` and leave the node exactly where it was.
    //
    // This is also where the sweep stops trusting its own premise. "Nothing can
    // be running in a process that has just started" is true of THIS process,
    // not of the machine: runObjective is called out of process by
    // scripts/factory-objective.mjs, scripts/factory-improve-loop.mjs and
    // scripts/objective-smoke.mjs, and no lock spans them. resumeObjectiveNodes
    // refuses a node whose task state is still being written, so an objective a
    // terminal is running right now is left to it rather than adopted.
    let revived = [];
    let live = [];
    if (verdict.abandoned.length) {
      try {
        // "gone" means the recorded runner is provably dead, so the 90-minute
        // age guard — a stand-in for exactly that knowledge — is not needed.
        const outcome = resumeNodes({ hqRoot, objectivePath, nodeIds: verdict.abandoned, by: "system", ownerGone: owner === "gone" });
        revived = (outcome?.resumed || []).map((entry) => entry.id);
        live = outcome?.skipped || [];
      } catch (error) {
        skipped.push({
          objectivePath,
          objectiveId: objective.objectiveId,
          reason: `cannot revive abandoned node(s): ${String(error?.message || error).slice(0, 120)}`,
        });
        continue;
      }
    }

    // Nothing to schedule: every ready node was imaginary and every abandoned
    // one belongs to somebody. Starting a run here is what wrote `incomplete`
    // over an objective that was merely interrupted.
    if (!verdict.ready.length && !revived.length && !verdict.revivable.length) {
      skipped.push({
        objectivePath,
        objectiveId: objective.objectiveId,
        reason: live.length
          ? `${live.length} node(s) still owned by a live runner: ${live.map((entry) => entry.reason).join("; ").slice(0, 120)}`
          : "nothing could be revived",
      });
      continue;
    }

    const detail = revived.length ? `${verdict.reason} (${revived.length} revived after a restart)` : verdict.reason;
    log(`[objective-reconcile] resuming ${objective.objectiveId}: ${detail}`);
    // `resumed` counts objectives actually handed to the orchestrator, which is
    // what `max` is meant to bound — an objective that could not be revived
    // must not spend a slot a startable one needs.
    resumed.push({ objectivePath, objectiveId: objective.objectiveId, nodeIds: verdict.nodeIds, revived });
    if (mode === "periodic") history.set(objectivePath, (history.get(objectivePath) || 0) + 1);

    // Detached, exactly like every other runObjective caller: an objective runs
    // for tens of minutes and boot must not wait for it. A failure is logged
    // against the objective it belongs to and never propagated — one objective
    // that cannot start is not a reason to leave the others unstarted.
    Promise.resolve()
      .then(() => runObjective({
        hqRoot,
        objectivePath,
        agentIds: cfg.openclawIntegration?.agentIds || {},
        maxAttemptsPerStage: cfg.openclawIntegration?.maxAttemptsPerStage || 3,
        maxInfraAttemptsPerStage: cfg.openclawIntegration?.maxInfraAttemptsPerStage || 6,
        concurrentGroups: cfg.openclawIntegration?.concurrentGroups,
        stateRoot: join(objectivePath, "..", "..", ".."),
      }))
      .catch((error) => log(`[objective-reconcile] ${objective.objectiveId} did not resume: ${String(error?.message || error).slice(0, 200)}`));
  }

  return { scanned: paths.length, resumed, skipped };
}
