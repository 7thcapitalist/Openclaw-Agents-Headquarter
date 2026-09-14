// The delivery loop has to close where it actually ends: on GitHub.
//
// These hold the reconciler to what it is allowed to be — a reader of merge
// state and nothing else. It settles finished work, it never touches live work,
// it never invents an answer it could not get, and it merges nothing itself.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recoverExistingPrUrl } from "../lib/hq/github-publish.mjs";
import { pullRequestRef, reconcileMergedTasks } from "../lib/hq/merge-reconciler.mjs";
import { createState, writeState } from "../lib/task-workflow.mjs";

const MERGED = { merged: true, state: "MERGED", mergedAt: "2026-09-12T06:40:00.000Z", mergeCommitSha: "abc123" };
const OPEN = { merged: false, state: "OPEN", mergedAt: null, mergeCommitSha: null };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "merge-reconcile-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  return { root, repo, stateRoot: join(root, "factory-state") };
}

// A task as the release gate leaves it: finished, pushed, PR opened.
function writeTask({ stateRoot, repo, id, status = "merge-ready", githubPublish = undefined }) {
  const worktree = join(stateRoot, "tasks", id, "worktree");
  mkdirSync(worktree, { recursive: true });
  const state = createState({
    task: { id, issue: `local:${id}`, outcome: `Ship ${id}`, acceptanceCriteria: ["it works"], project: "demo", workType: "backend", risk: "low" },
    repo, branch: `factory/${id}`, worktree,
  });
  state.status = status;
  state.currentStage = status === "merge-ready" ? null : "builder";
  if (githubPublish !== undefined) state.githubPublish = githubPublish;
  else {
    state.githubPublish = {
      published: true, pushed: true,
      prUrl: "https://github.com/acme/widget/pull/5",
      ownerRepo: "acme/widget",
      remote: "origin",
      commitSha: "07c7fa5",
    };
  }
  const statePath = join(stateRoot, "tasks", id, "state.json");
  writeState(statePath, state);
  return statePath;
}

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

test("pullRequestRef reads the pull request the release stage recorded", () => {
  assert.deepEqual(
    pullRequestRef({ githubPublish: { prUrl: "https://github.com/acme/widget/pull/5", ownerRepo: "acme/widget" } }),
    { ownerRepo: "acme/widget", number: 5, url: "https://github.com/acme/widget/pull/5" },
  );
});

test("pullRequestRef refuses anything it cannot be sure of", () => {
  // Nothing published — a task delivered some other way.
  assert.equal(pullRequestRef({}), null);
  assert.equal(pullRequestRef({ githubPublish: { published: true } }), null);
  // Not a github.com pull request URL.
  assert.equal(pullRequestRef({ githubPublish: { prUrl: "https://git.example.com/acme/widget/pull/5" } }), null);
  assert.equal(pullRequestRef({ githubPublish: { prUrl: "https://github.com/acme/widget/issues/5" } }), null);
  // The recorded repo disagrees with the URL: querying either one is a guess.
  assert.equal(pullRequestRef({ githubPublish: { prUrl: "https://github.com/acme/widget/pull/5", ownerRepo: "other/repo" } }), null);
});

test("a finished task whose pull request is merged is settled as merged", async () => {
  const { repo, stateRoot } = fixture();
  const statePath = writeTask({ stateRoot, repo, id: "task-shipped" });

  const out = await reconcileMergedTasks({ stateRoot, lookup: async () => MERGED, now: () => "2026-09-14T04:00:00.000Z" });

  assert.equal(out.merged.length, 1);
  assert.equal(out.merged[0].taskId, "task-shipped");

  const state = read(statePath);
  assert.equal(state.status, "merged");
  assert.equal(state.githubPublish.merged, true);
  assert.equal(state.githubPublish.mergedAt, MERGED.mergedAt);
  assert.equal(state.githubPublish.mergeCommitSha, "abc123");
  // The PR url it was reconciled against stays on the record.
  assert.equal(state.githubPublish.prUrl, "https://github.com/acme/widget/pull/5");

  const event = state.events.filter((e) => e.type === "pr-merged");
  assert.equal(event.length, 1);
  assert.equal(event[0].stage, "release");
  assert.equal(event[0].actor, "system");
});

test("an open pull request is reported, never transitioned", async () => {
  const { repo, stateRoot } = fixture();
  const statePath = writeTask({ stateRoot, repo, id: "task-waiting" });

  const out = await reconcileMergedTasks({ stateRoot, lookup: async () => OPEN });

  assert.equal(out.merged.length, 0);
  assert.equal(out.pending.length, 1);
  assert.equal(out.pending[0].state, "OPEN");
  assert.equal(read(statePath).status, "merge-ready");
});

test("a closed-unmerged pull request does not settle the task as merged", async () => {
  const { repo, stateRoot } = fixture();
  const statePath = writeTask({ stateRoot, repo, id: "task-abandoned" });

  const out = await reconcileMergedTasks({ stateRoot, lookup: async () => ({ merged: false, state: "CLOSED", mergedAt: null, mergeCommitSha: null }) });

  assert.equal(out.merged.length, 0);
  assert.equal(out.pending[0].state, "CLOSED");
  assert.equal(read(statePath).status, "merge-ready", "work that did not land must never read as merged");
});

test("live work is never looked up, let alone transitioned", async () => {
  const { repo, stateRoot } = fixture();
  const active = writeTask({ stateRoot, repo, id: "task-active", status: "active" });
  const blocked = writeTask({ stateRoot, repo, id: "task-blocked", status: "blocked" });

  let lookups = 0;
  const out = await reconcileMergedTasks({ stateRoot, lookup: async () => { lookups += 1; return MERGED; } });

  assert.equal(lookups, 0, "a task with a live workflow owns its own status");
  assert.equal(out.merged.length, 0);
  assert.equal(read(active).status, "active");
  assert.equal(read(blocked).status, "blocked");
});

test("a finished task with no pull request is skipped with a reason, not failed", async () => {
  const { repo, stateRoot } = fixture();
  const statePath = writeTask({ stateRoot, repo, id: "task-local", githubPublish: null });

  const out = await reconcileMergedTasks({ stateRoot, lookup: async () => MERGED });

  assert.equal(out.merged.length, 0);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /no pull request/i);
  assert.equal(read(statePath).status, "merge-ready");
});

test("a lookup that could not answer leaves the task exactly as it was", async () => {
  const { repo, stateRoot } = fixture();
  const statePath = writeTask({ stateRoot, repo, id: "task-unknown" });

  // `gh` unauthenticated, offline, or the repo invisible to this machine.
  const out = await reconcileMergedTasks({ stateRoot, lookup: async () => null });

  assert.equal(out.merged.length, 0);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /could not read acme\/widget#5/);
  assert.equal(read(statePath).status, "merge-ready");
});

test("reconciling twice records the merge once", async () => {
  const { repo, stateRoot } = fixture();
  const statePath = writeTask({ stateRoot, repo, id: "task-twice" });

  await reconcileMergedTasks({ stateRoot, lookup: async () => MERGED });
  const second = await reconcileMergedTasks({ stateRoot, lookup: async () => MERGED });

  assert.equal(second.merged.length, 0, "an already-merged task is not eligible a second time");
  assert.equal(read(statePath).events.filter((e) => e.type === "pr-merged").length, 1);
});

test("several tasks delivered by one pull request cost one lookup", async () => {
  const { repo, stateRoot } = fixture();
  const a = writeTask({ stateRoot, repo, id: "task-part-a" });
  const b = writeTask({ stateRoot, repo, id: "task-part-b" });

  const asked = [];
  const out = await reconcileMergedTasks({ stateRoot, lookup: async (ref) => { asked.push(ref); return MERGED; } });

  assert.equal(asked.length, 1, "the same pull request is asked about once per sweep");
  assert.equal(out.merged.length, 2);
  assert.equal(read(a).status, "merged");
  assert.equal(read(b).status, "merged");
});

test("one unreadable state file never stops the sweep", async () => {
  const { repo, stateRoot } = fixture();
  mkdirSync(join(stateRoot, "tasks", "task-corrupt"), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(stateRoot, "tasks", "task-corrupt", "state.json"), "{ not json", "utf8");
  const good = writeTask({ stateRoot, repo, id: "task-good" });

  const out = await reconcileMergedTasks({ stateRoot, lookup: async () => MERGED });

  assert.equal(out.merged.length, 1);
  assert.equal(read(good).status, "merged");
});

test("a missing state root is an empty sweep, not a crash", async () => {
  const { root } = fixture();
  const out = await reconcileMergedTasks({ stateRoot: join(root, "nothing-here"), lookup: async () => MERGED });
  assert.deepEqual(out, { scanned: 0, merged: [], pending: [], skipped: [] });
});

// `gh pr create` refuses when the branch already has a pull request and names
// it in the refusal. The publisher used to drop that URL, which is how four
// already-shipped tasks ended up with no pull request recorded at all.
const ALREADY_EXISTS = 'gh pr create failed: a pull request for branch "factory/x" into branch "main" already exists:\nhttps://github.com/acme/widget/pull/27';

test("recoverExistingPrUrl reads the pull request named in an already-exists refusal", () => {
  assert.equal(recoverExistingPrUrl(ALREADY_EXISTS, "acme/widget"), "https://github.com/acme/widget/pull/27");
});

test("recoverExistingPrUrl refuses a URL it cannot tie to the repository that was published to", () => {
  // A URL for a different repository is not this task's pull request.
  assert.equal(recoverExistingPrUrl(ALREADY_EXISTS, "other/repo"), null);
  // A failure that is not "already exists" carries no pull request to recover.
  assert.equal(recoverExistingPrUrl("gh pr create failed: could not reach github.com", "acme/widget"), null);
  assert.equal(recoverExistingPrUrl("", "acme/widget"), null);
  assert.equal(recoverExistingPrUrl(ALREADY_EXISTS, ""), null);
  assert.equal(recoverExistingPrUrl(ALREADY_EXISTS, null), null);
});

test("a task whose pull request survived only in the failure reason is still reconciled", async () => {
  const { repo, stateRoot } = fixture();
  const statePath = writeTask({
    stateRoot, repo, id: "task-url-lost",
    githubPublish: {
      published: true, pushed: true, prUrl: null,
      ownerRepo: "acme/widget",
      remote: "origin", commitSha: "59caaef",
      reason: ALREADY_EXISTS,
    },
  });

  assert.deepEqual(pullRequestRef(read(statePath)), {
    ownerRepo: "acme/widget", number: 27, url: "https://github.com/acme/widget/pull/27",
  });

  const out = await reconcileMergedTasks({ stateRoot, lookup: async () => MERGED });

  assert.equal(out.merged.length, 1);
  assert.equal(read(statePath).status, "merged");
});
