// "The factory should know when its own work landed."
//
// The release gate is the last thing the factory does: it pushes the branch,
// opens a pull request, and sets the task `merge-ready`. The founder then
// merges on GitHub — `mode: "human-merge"` — and nothing ever told the factory.
// `"merged"` was read in ten places and written in none, so a task that shipped
// days ago still presented itself as work waiting on the founder. Fourteen of
// twenty-two live tasks sat that way, including four whose PRs were long merged.
//
// This closes that loop. It asks GitHub about the PR the release stage already
// recorded, and moves `merge-ready` -> `merged` when the answer is yes. It is a
// reconciler, not a workflow: it never advances a stage, never merges anything,
// never touches a task that is not already finished, and the only field it
// decides is the one GitHub is authoritative for.
//
// Some finished tasks can never have a pull request: a build node of an
// objective is carried by the integration branch, and an analysis task changes
// no files. Asking GitHub about them is meaningless, so they were skipped —
// and skipping is forever. They sat on the board as "Ready to merge" for
// 238-256 hours, and since every objective produces build nodes, the board
// could only fill up. `merge-ready` -> `complete` is the other half of the
// loop: see deliveredWithoutPullRequest for what does and does not qualify.
//
// Node builtins only.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { mutateTransactionalState, readTransactionalState } from "../store/transactional-json.mjs";
import { recoverExistingPrUrl } from "./github-publish.mjs";

const execFileAsync = promisify(execFile);

// Only a finished task is eligible. An active or blocked task has a live
// workflow that owns its status, and a reconciler must never race it.
const ELIGIBLE_STATUS = "merge-ready";

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

/**
 * The pull request the release stage recorded, or null when it recorded none.
 *
 * `githubPublish.prUrl` is written by publishAndRecord in openclaw-runner.mjs;
 * `ownerRepo` rides along with it. The URL is parsed rather than trusted
 * wholesale so a task pointing at some other host is simply skipped.
 *
 * @param {object} state task state
 * @returns {{ownerRepo: string, number: number, url: string}|null}
 */
export function pullRequestRef(state) {
  const publish = state?.githubPublish;
  // `prUrl` is the record. When it is missing, the publish may still have been
  // told which pull request carries this work and kept it only in `reason` —
  // that is what a `gh pr create` "already exists" refusal looks like, and it
  // is how several already-shipped tasks came to have no pull request at all.
  // Reading it here heals those records without a migration; new publishes
  // record `prUrl` properly (see recoverExistingPrUrl's caller).
  const url = String(publish?.prUrl || recoverExistingPrUrl(publish?.reason, publish?.ownerRepo) || "").trim();
  if (!url) return null;
  const match = url.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (!match) return null;
  const ownerRepo = String(publish.ownerRepo || match[1]).trim();
  // The recorded ownerRepo and the URL must agree. They are written together,
  // so a mismatch means the record was edited or merged from another task, and
  // querying the wrong repository is worse than skipping.
  if (ownerRepo !== match[1]) return null;
  return { ownerRepo, number: Number(match[2]), url };
}

/**
 * Why a finished task legitimately carries no pull request — or null when the
 * absence is unexplained and the task must be left alone.
 *
 * `merge-ready` means all seven gates passed and the release stage ran. Most
 * such tasks carry a pull request and this reconciler settles them against
 * GitHub. Some never can, by design:
 *
 *   * a build node of an objective — its commits are carried by the
 *     integration branch, which opens the one pull request for the whole
 *     objective. Every objective the factory runs produces N of these.
 *   * a task that changed no files — an analysis or advisory task. There is
 *     no diff, so there is nothing to open a pull request for.
 *
 * Both are finished work. Left unsettled they sit on the founder's board as
 * "Ready to merge" forever, waiting for a merge that can never happen: on
 * 2026-09-17 four tasks had been doing so for 238-256 hours, and because the
 * first class recurs on every objective, the board could only get worse.
 *
 * What this deliberately does NOT cover is a publish that was attempted and
 * failed — `published: true` with no URL, or a `gh pr create failed:` reason.
 * That work did not land, and settling it would hide exactly the failure the
 * founder needs to see. Anything not positively recognised here stays put.
 *
 * @param {object} state task state
 * @returns {string|null} the reason, phrased for the event record
 */
export function deliveredWithoutPullRequest(state) {
  const publish = state?.githubPublish;
  // Nothing recorded at all: the release stage never said what happened, so
  // there is no evidence either way. Not ours to settle.
  if (!publish) return null;
  // A publish that ran is answerable by GitHub, and pullRequestRef has already
  // failed to find a URL by the time we are called. That is a failure to
  // publish, not a delivery without one.
  if (publish.published) return null;
  const reason = String(publish.reason || "");
  for (const { test: pattern, detail } of DELIVERED_WITHOUT_PR) {
    if (pattern.test(reason)) return detail;
  }
  return null;
}

// The reasons publishAndRecord writes when it correctly declines to open a
// pull request. Matched against the recorded reason rather than inferred from
// the task's shape, so only a reason the factory itself wrote can settle a
// task, and an unrecognised one is always left alone.
const DELIVERED_WITHOUT_PR = Object.freeze([
  {
    pattern: /^objective build node\b/i,
    detail: "delivered via the objective's integration branch",
  },
  {
    pattern: /^no changes to publish\b/i,
    detail: "the task changed no files, so there was nothing to merge",
  },
].map(({ pattern, detail }) => ({ test: pattern, detail })));

/**
 * Whether an objective build node landed through its objective's integration
 * pull request — or null when that is not proven.
 *
 * Every objective publishes each build node as its own pull request and then
 * an integration branch that merges them all. Merging the integration PR
 * makes the node PRs redundant, and closing them left their tasks reading
 * "Ready to merge" forever: obj-e8209a43's two nodes, 2026-09-18, after #308
 * carried both and #305/#307 were closed as superseded. This recurs on every
 * objective.
 *
 * Both of these must be on record, or nothing is settled:
 *   * the objective's integration merge log shows THIS node's branch merged
 *     cleanly into the integration branch, and
 *   * the integration task itself is `merged` — GitHub confirmed its PR, via
 *     this same reconciler.
 * A node whose branch never entered the integration, or an integration that
 * has not merged, is left exactly as it was.
 *
 * @returns {string|null} the reason, phrased for the event record
 */
export function deliveredByIntegration(statePath, state) {
  const taskId = String(state?.task?.id || basename(dirname(statePath)));
  const match = taskId.match(/^(obj-[0-9a-f]{8})-/);
  if (!match || taskId === `${match[1]}-integration`) return null;
  const projectRoot = dirname(dirname(dirname(statePath)));
  const objectivePath = join(projectRoot, "objectives", match[1], "objective-state.json");
  if (!existsSync(objectivePath)) return null;
  let objective;
  try { objective = readTransactionalState(objectivePath, { format: "objective-state" }); } catch { return null; }
  const integration = objective?.integration;
  const branch = state?.branch || objective?.nodes?.[taskId]?.branch;
  if (!integration?.id || !branch) return null;
  const mergedIn = (integration.mergeLog || []).some((entry) => entry?.branch === branch && entry.ok === true);
  if (!mergedIn) return null;
  const integrationPath = join(projectRoot, "tasks", integration.id, "state.json");
  if (!existsSync(integrationPath)) return null;
  let integrationState;
  try { integrationState = readTransactionalState(integrationPath); } catch { return null; }
  if (integrationState?.status !== "merged") return null;
  const pr = integrationState.githubPublish?.prUrl?.match(/\/pull\/(\d+)/)?.[1];
  return `delivered via the objective's integration pull request${pr ? ` #${pr}` : ""}`;
}

/**
 * Ask GitHub what happened to one pull request. Default implementation; tests
 * and callers inject their own.
 *
 * Returns `null` when the answer cannot be established — an unauthenticated
 * `gh`, a deleted PR, a network failure. A task is never transitioned on a
 * lookup that did not clearly succeed.
 *
 * @returns {Promise<{merged: boolean, state: string, mergedAt: string|null, mergeCommitSha: string|null}|null>}
 */
export async function lookupPullRequest({ ownerRepo, number, timeoutMs = 20_000 }) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "gh",
      ["pr", "view", String(number), "--repo", ownerRepo, "--json", "state,mergedAt,mergeCommit"],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    ));
  } catch {
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const prState = String(parsed?.state || "");
  if (!prState) return null;
  return {
    merged: prState === "MERGED",
    state: prState,
    mergedAt: parsed?.mergedAt || null,
    mergeCommitSha: parsed?.mergeCommit?.oid || null,
  };
}

/**
 * Apply one confirmed merge to one task state file, atomically.
 *
 * Re-reads inside the transaction: the status is checked against the state as
 * it is at write time, not as it was when the sweep started, so a task that
 * moved while GitHub was being asked is left alone.
 */
function recordMerge(statePath, lookup, at) {
  return mutateTransactionalState(statePath, {
    commandId: `merge-reconcile:${statePath}:${lookup.mergeCommitSha || lookup.mergedAt || at}`,
    // Stable key — re-running the sweep must not double-apply — so the stored
    // response is what a replay returns. The caller reads only the status.
    toResponse: (state) => ({ status: state?.status ?? null }),
    mutate: (state) => {
      if (state.status !== ELIGIBLE_STATUS) return state;
      const next = structuredClone(state);
      next.status = "merged";
      next.githubPublish = {
        ...(next.githubPublish || {}),
        merged: true,
        mergedAt: lookup.mergedAt,
        mergeCommitSha: lookup.mergeCommitSha,
      };
      next.updatedAt = at;
      next.events.push({
        at,
        type: "pr-merged",
        stage: "release",
        actor: "system",
        prUrl: next.githubPublish.prUrl || null,
        mergedAt: lookup.mergedAt,
      });
      return next;
    },
  });
}

/**
 * Settle one finished task that was delivered without a pull request.
 *
 * Same discipline as recordMerge: re-reads inside the transaction, so a task
 * that moved while the sweep was elsewhere is left exactly as it moved. The
 * status is `complete` and not `merged` — `merged` asserts a pull request was
 * merged, and none was. `complete` already reads as "Done" in the founder's
 * vocabulary (control-plane/public/stage-vocabulary.mjs), so this needs no
 * change on either console.
 */
function recordDelivered(statePath, detail, at) {
  return mutateTransactionalState(statePath, {
    // Stable key: re-running the sweep must not append a second event.
    commandId: `merge-reconcile:delivered:${statePath}`,
    toResponse: (state) => ({ status: state?.status ?? null }),
    mutate: (state) => {
      if (state.status !== ELIGIBLE_STATUS) return state;
      const next = structuredClone(state);
      next.status = "complete";
      next.githubPublish = {
        ...(next.githubPublish || {}),
        // Not `merged` — nothing was merged. This records that the delivery
        // question has been answered and needs no pull request.
        deliveredWithoutPullRequest: true,
        settledAt: at,
      };
      next.updatedAt = at;
      next.events.push({
        at,
        type: "delivered-without-pr",
        stage: "release",
        actor: "system",
        detail,
      });
      return next;
    },
  });
}

/**
 * Scan the factory state tree and settle every finished task whose pull request
 * GitHub says is merged.
 *
 * Bounded and guarded: one unreadable state file, one failed lookup, or one
 * repository the caller cannot see never stops the sweep. Lookups are cached
 * per sweep, so several tasks delivered by one pull request cost one call.
 *
 * @param {object}    input
 * @param {string}    input.stateRoot  directory to scan for state.json files
 * @param {Function} [input.lookup]    injected PR lookup (tests)
 * @param {Function} [input.now]
 * @param {Function} [input.log]
 * @returns {Promise<{scanned:number, merged:Array, settled:Array, pending:Array, skipped:Array}>}
 */
export async function reconcileMergedTasks({
  stateRoot,
  lookup = lookupPullRequest,
  now = () => new Date().toISOString(),
  log = () => {},
}) {
  const files = existsSync(stateRoot) ? walkStateFiles(stateRoot) : [];
  const merged = [];
  const settled = [];
  const pending = [];
  const skipped = [];
  const cache = new Map();

  for (const statePath of files) {
    let state;
    try { state = readTransactionalState(statePath); } catch { continue; }
    if (state.status !== ELIGIBLE_STATUS) continue;

    const ref = pullRequestRef(state);
    if (!ref) {
      // A finished task with no pull request. When the release stage recorded
      // why — a build node carried by the integration branch, or a task with
      // no diff — that is a delivery, and this is the only thing that will
      // ever settle it. Anything else (including a failed publish) is left.
      const delivered = deliveredWithoutPullRequest(state);
      if (!delivered) {
        skipped.push({ taskId: state.task?.id, statePath, reason: "no pull request recorded" });
        continue;
      }
      const at = now();
      try {
        const next = recordDelivered(statePath, delivered, at);
        if (next.status !== "complete") {
          skipped.push({ taskId: state.task?.id, statePath, reason: `moved to ${next.status} during the sweep` });
          continue;
        }
        settled.push({ taskId: state.task?.id, statePath, reason: delivered });
        log(`[merge-reconcile] ${state.task?.id}: ${delivered}, task settled`);
      } catch (error) {
        skipped.push({ taskId: state.task?.id, statePath, reason: `could not settle: ${error?.message || error}` });
      }
      continue;
    }

    const key = `${ref.ownerRepo}#${ref.number}`;
    if (!cache.has(key)) cache.set(key, await lookup({ ownerRepo: ref.ownerRepo, number: ref.number }));
    const answer = cache.get(key);

    if (!answer) {
      skipped.push({ taskId: state.task?.id, statePath, reason: `could not read ${key}` });
      continue;
    }
    if (!answer.merged) {
      // A build node opens its own pull request, and the objective's
      // integration branch then merges that node and opens the one that
      // lands. When the integration PR merges, the node's own PR is redundant
      // and gets closed — so "not merged" here does not mean the work did not
      // land. deliveredByIntegration settles it only on recorded proof.
      const viaIntegration = deliveredByIntegration(statePath, state);
      if (viaIntegration) {
        const at = now();
        try {
          const next = recordDelivered(statePath, viaIntegration, at);
          if (next.status === "complete") {
            settled.push({ taskId: state.task?.id, statePath, reason: viaIntegration });
            log(`[merge-reconcile] ${state.task?.id}: ${viaIntegration}, task settled`);
          } else {
            skipped.push({ taskId: state.task?.id, statePath, reason: `moved to ${next.status} during the sweep` });
          }
        } catch (error) {
          skipped.push({ taskId: state.task?.id, statePath, reason: `could not settle: ${error?.message || error}` });
        }
        continue;
      }
      // Otherwise recorded, not acted on. A closed-unmerged PR with no
      // integration that carried it means the work did not land — deciding
      // what that does to the task is a workflow change, not a reconciliation.
      pending.push({ taskId: state.task?.id, statePath, pr: key, state: answer.state });
      continue;
    }

    const at = now();
    try {
      const next = recordMerge(statePath, answer, at);
      if (next.status !== "merged") {
        skipped.push({ taskId: state.task?.id, statePath, reason: `moved to ${next.status} during the sweep` });
        continue;
      }
      merged.push({ taskId: state.task?.id, statePath, pr: key, mergedAt: answer.mergedAt });
      log(`[merge-reconcile] ${state.task?.id}: ${key} merged, task settled`);
    } catch (error) {
      skipped.push({ taskId: state.task?.id, statePath, reason: `could not record: ${error?.message || error}` });
    }
  }

  return { scanned: files.length, merged, settled, pending, skipped };
}
