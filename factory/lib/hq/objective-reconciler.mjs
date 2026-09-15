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
// It schedules; it does not repair. runObjective is already idempotent and
// self-healing — it resumes nodes whose task state went active, releases
// `blocked-by-dep` descendants, and re-asserts `active` — so the whole job here
// is deciding WHICH objectives to hand it, and standing well back.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { readObjState, CANCELLED } from "../objective/orchestrator.mjs";

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

// A node in one of these states is being driven by a runner — and at boot there
// are no runners. `blocked` and `failed` are deliberately absent: those are
// decisions, not interruptions, and re-running them is the founder's call.
const STRANDED_NODE_STATES = new Set(["pending", "running"]);

const FINISHED_OBJECTIVE_STATES = new Set([CANCELLED, "complete", "completed", "superseded"]);

/**
 * Decide whether an objective has work that nobody is running.
 *
 * Exported because the decision is the interesting part and deserves to be
 * tested without a filesystem or a runner behind it.
 *
 * @param {object} objective  parsed objective-state.json
 * @returns {{stranded:boolean, reason:string, nodeIds:string[]}}
 */
export function strandedNodes(objective) {
  if (!objective || typeof objective !== "object") return { stranded: false, reason: "unreadable", nodeIds: [] };
  if (FINISHED_OBJECTIVE_STATES.has(objective.status)) {
    return { stranded: false, reason: `objective is ${objective.status}`, nodeIds: [] };
  }

  const nodes = Object.values(objective.nodes || {});
  // The integration node is a node too, and it strands exactly the same way.
  if (objective.integration?.id) nodes.push(objective.integration);

  const nodeIds = nodes.filter((node) => STRANDED_NODE_STATES.has(node?.status)).map((node) => node.id);
  if (!nodeIds.length) return { stranded: false, reason: "no node is waiting for a runner", nodeIds: [] };
  return { stranded: true, reason: `${nodeIds.length} node(s) with no runner`, nodeIds };
}

/**
 * Hand every stranded objective back to the orchestrator.
 *
 * @param {object}   input
 * @param {string}   input.hqRoot
 * @param {string}   input.stateRoot          directory to scan for objective states
 * @param {Function} input.runObjective       injected orchestrator (required; tests pass a spy)
 * @param {number}  [input.max=10]            objectives started per sweep, so a boot after a long outage cannot start fifty runs at once
 * @param {Function}[input.readConfig]
 * @param {Function}[input.log]
 * @returns {Promise<{scanned:number, resumed:Array, skipped:Array}>}
 */
export async function resumeStrandedObjectives({
  hqRoot,
  stateRoot,
  runObjective,
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

    const verdict = strandedNodes(objective);
    if (!verdict.stranded) {
      skipped.push({ objectivePath, objectiveId: objective.objectiveId, reason: verdict.reason });
      continue;
    }

    log(`[objective-reconcile] resuming ${objective.objectiveId}: ${verdict.reason}`);
    resumed.push({ objectivePath, objectiveId: objective.objectiveId, nodeIds: verdict.nodeIds });

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
