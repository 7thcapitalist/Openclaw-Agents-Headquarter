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
// Node builtins only.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
 * @returns {Promise<{scanned:number, merged:Array, pending:Array, skipped:Array}>}
 */
export async function reconcileMergedTasks({
  stateRoot,
  lookup = lookupPullRequest,
  now = () => new Date().toISOString(),
  log = () => {},
}) {
  const files = existsSync(stateRoot) ? walkStateFiles(stateRoot) : [];
  const merged = [];
  const pending = [];
  const skipped = [];
  const cache = new Map();

  for (const statePath of files) {
    let state;
    try { state = readTransactionalState(statePath); } catch { continue; }
    if (state.status !== ELIGIBLE_STATUS) continue;

    const ref = pullRequestRef(state);
    if (!ref) {
      // A finished task with no pull request was delivered some other way (a
      // demo run, a local-only project). There is nothing to reconcile against.
      skipped.push({ taskId: state.task?.id, statePath, reason: "no pull request recorded" });
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
      // Recorded, not acted on. A closed-unmerged PR means the work did not
      // land, which is a different question from this one — deciding what that
      // does to the task is a workflow change, not a reconciliation.
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

  return { scanned: files.length, merged, pending, skipped };
}
