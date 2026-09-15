// Publishing a completed task's branch to GitHub — the one place the factory
// writes to a real remote.
//
// This runs ONLY after a task has reached `merge-ready`: task-workflow.mjs's
// `assertReleaseReady` has already required evidence at every stage, an
// independent reviewer/QA harness, and no unresolved founder decision before
// allowing that transition. This module adds exactly two steps on top of
// that already-gated state — push the task's own branch, open a PR — and
// stops there. It never pushes to the project's default branch, never force
// pushes, and never merges; founder merge stays a manual, separate action
// (see factory/factory.config.json's prohibitedAutonomousActions).
//
// Every external step (config flag, github coordinates, git remote, gh CLI)
// is guarded and degrades to a clear, non-throwing reason — a GitHub hiccup
// must never break the workflow engine that got the task to merge-ready.

import { execFileSync } from "child_process";
import { resolveCompanyProject } from "./registry.mjs";
import { readHqConfig } from "./config.mjs";
import { checkCapability } from "./capability-check.mjs";

// Default git/gh runner. Injectable for tests — never talks to a real remote
// unless a caller supplies the real one explicitly.
function defaultExec(cwd, args) {
  try {
    const out = execFileSync(args[0], args.slice(1), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: String(error.stderr || error.message || error).trim() };
  }
}

function defaultGhAvailable() {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A short, human-readable PR body assembled entirely from evidence the
// workflow engine already recorded on this task's own state — nothing here
// is invented.
export function buildPrBody(state) {
  const lines = [`Outcome: ${state.task.outcome}`, ""];
  if (Array.isArray(state.task.acceptanceCriteria) && state.task.acceptanceCriteria.length) {
    lines.push("Acceptance criteria:");
    for (const c of state.task.acceptanceCriteria) lines.push(`- ${c}`);
    lines.push("");
  }
  lines.push("Stage verdicts:");
  for (const stage of ["product", "architect", "builder", "reviewer", "qa", "security", "release"]) {
    const s = state.stages?.[stage];
    if (!s || s.status === "pending") continue;
    lines.push(`- ${stage}: ${s.status}${s.actor ? ` (${s.actor})` : ""}${s.summary ? ` — ${truncate(s.summary, 160)}` : ""}`);
  }
  lines.push("", `Task id: ${state.task.id}`, "Opened automatically by the OpenClaw factory once every gate passed. Merge is always a manual, separate decision.");
  return lines.join("\n");
}

// Parse an owner/repo out of a GitHub remote URL. Handles both
// git@github.com:OWNER/REPO(.git) and https://github.com/OWNER/REPO(.git).
export function parseGithubRemote(url) {
  const s = String(url || "").trim();
  const m = s.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// Resolve where this task should be published: the registered project's
// github {owner, repo} if it has one; otherwise the task worktree's own
// `origin` remote URL; otherwise nothing (an authenticated `gh` account alone
// is not enough — a repo name is never invented). Read-only.
export function resolveTaskGithubTarget({ hqRoot, state, exec = defaultExec }) {
  const project = resolveCompanyProject(hqRoot, state.task.project, { withIntelligence: false });
  if (project?.github?.owner && project?.github?.repo) {
    return { owner: project.github.owner, repo: project.github.repo, ownerRepo: `${project.github.owner}/${project.github.repo}`, source: "registry" };
  }
  // The raw configured URL — `git config` does not apply `insteadOf` rewrites,
  // so a real GitHub remote is seen even when a local mirror is substituted.
  for (const args of [["git", "config", "--get", "remote.origin.url"], ["git", "remote", "get-url", "origin"]]) {
    const remote = exec(state.worktree, args);
    if (!remote.ok) continue;
    const parsed = parseGithubRemote(remote.out);
    if (parsed) return { ...parsed, ownerRepo: `${parsed.owner}/${parsed.repo}`, source: "git-remote" };
  }
  return {
    ownerRepo: null,
    reason: `project "${state.task.project}" has no github {owner, repo} configured and none could be derived from the task's origin remote`,
  };
}

function resolveBaseRef(worktree, exec) {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const r = exec(worktree, ["git", "rev-parse", "--verify", "--quiet", ref]);
    if (r.ok && String(r.out).trim()) {
      if (ref === "origin/HEAD") {
        const named = exec(worktree, ["git", "rev-parse", "--abbrev-ref", "origin/HEAD"]);
        return named.ok && named.out.trim() ? named.out.trim() : ref;
      }
      return ref;
    }
  }
  return null;
}

// Guarantee the task branch actually carries the work before it is pushed.
// The workflow engine records evidence but never commits, so an agent that
// wrote files without committing would otherwise publish an empty branch.
// Stages any uncommitted change and makes one audit commit; then refuses to
// publish a branch that is not ahead of its base.
export function ensureBranchHasCommit({ state, exec = defaultExec }) {
  const worktree = state.worktree;
  exec(worktree, ["git", "add", "-A"]);
  const dirty = exec(worktree, ["git", "status", "--porcelain"]);
  let committed = false;
  if (dirty.ok && String(dirty.out).trim()) {
    const message = `factory(${state.task.id}): ${truncate(state.task.outcome || state.task.id, 100)}`;
    const commit = exec(worktree, ["git", "commit", "-m", message, "-m", buildPrBody(state)]);
    if (!commit.ok) return { error: `git commit failed: ${commit.out}` };
    committed = true;
  }
  const head = exec(worktree, ["git", "rev-parse", "HEAD"]);
  if (!head.ok || !String(head.out).trim()) return { error: "task branch has no commit (git rev-parse HEAD failed)" };
  const headSha = head.out.trim();

  const base = state.baseSha || resolveBaseRef(worktree, exec);
  if (base) {
    const ahead = exec(worktree, ["git", "rev-list", "--count", `${base}..HEAD`]);
    if (ahead.ok && Number(ahead.out.trim()) === 0) return { empty: true };
  }
  return { committed, commitSha: headSha, commitRange: base ? `${base}..${headSha}` : null };
}

/**
 * @param {object}   input
 * @param {string}   input.hqRoot
 * @param {object}   input.state       the task's full state.json (must be status: "merge-ready")
 * @param {Function} [input.exec]      (cwd, args:string[]) => {ok, out} — git/gh runner, injected for tests
 * @param {Function} [input.ghAvailable]
 * @returns {{ published:boolean, pushed?:boolean, prUrl?:(string|null), reason?:string, ownerRepo?:(string|null), commitSha?:(string|null), commitRange?:(string|null), remote?:string }}
 */
export function publishMergeReadyTask({ hqRoot, state, exec = defaultExec, ghAvailable = defaultGhAvailable }) {
  if (!state || state.status !== "merge-ready") {
    return { published: false, reason: "task is not merge-ready" };
  }

  // Pushing a branch and opening a pull request is the factory's most outward
  // act, so it is where the `github.open-pr` capability is checked. Placed
  // after the merge-ready guard — a task that is not finished was never going
  // to publish, and auditing a decision about work that cannot happen would
  // fill the log with noise the founder has to read past.
  //
  // Under `report` this records and allows. Under `enforce` it throws, and
  // publishAndRecord turns that into `{ published: false, reason }` on the
  // task, so a refused publish is visible on the task rather than silent.
  checkCapability({
    hqRoot,
    capability: "github.open-pr",
    action: "open a pull request",
    actor: { type: "agent", id: state.assignments?.release || "openclaw-factory" },
    scope: { type: "task", id: state.task?.id, projectId: state.task?.project || null },
    founderApproval: state.founderApproval || null,
    correlation: {
      taskId: state.task?.id,
      ...(state.task?.project ? { projectId: state.task.project } : {}),
      branch: state.branch || null,
    },
  });

  const config = readHqConfig(hqRoot);
  if (config.github?.autoPublish === false) {
    return { published: false, reason: "github.autoPublish is disabled in factory/hq.config.json" };
  }

  const branch = state.branch;
  if (!branch || branch === "main" || branch === "master") {
    return { published: false, reason: `refusing to publish an empty or default branch ("${branch}")` };
  }

  const target = resolveTaskGithubTarget({ hqRoot, state, exec });
  if (!target.ownerRepo) {
    return { published: false, reason: target.reason };
  }

  const worktree = state.worktree;
  const remotes = exec(worktree, ["git", "remote"]);
  if (!remotes.ok || !remotes.out.split("\n").includes("origin")) {
    return { published: false, reason: "task worktree has no 'origin' remote" };
  }

  const ensured = ensureBranchHasCommit({ state, exec });
  if (ensured.error) {
    return { published: false, pushed: false, ownerRepo: target.ownerRepo, reason: ensured.error };
  }
  if (ensured.empty) {
    return { published: false, pushed: false, ownerRepo: target.ownerRepo, reason: "no changes to publish (task branch is not ahead of its base)" };
  }
  const audit = { ownerRepo: target.ownerRepo, remote: "origin", commitSha: ensured.commitSha, commitRange: ensured.commitRange };

  const push = exec(worktree, ["git", "push", "-u", "origin", branch]);
  if (!push.ok) {
    return { published: false, pushed: false, ...audit, reason: `git push failed: ${push.out}` };
  }

  if (!ghAvailable()) {
    return { published: true, pushed: true, prUrl: null, ...audit, reason: "gh CLI unavailable; open the PR manually" };
  }

  const slug = target.ownerRepo;
  // Builders can open a draft before release. Reuse that exact branch PR.
  const observed = exec(worktree, ["gh", "pr", "list", "--repo", slug, "--head", branch,
    "--state", "open", "--json", "url,headRefName,isCrossRepository"]);
  if (!observed.ok) return { published: false, pushed: true, ...audit, reason: "Could not check existing branch PRs; retry publication" };
  let existing;
  try { existing = JSON.parse(observed.out).find((pr) => pr.headRefName === branch && pr.isCrossRepository === false && pr.url?.startsWith(`https://github.com/${slug}/pull/`)); }
  catch { return { published: false, pushed: true, ...audit, reason: "Invalid existing PR response; retry publication" }; }
  if (existing) return { published: true, pushed: true, prUrl: existing.url, ...audit };

  const title = truncate(state.task.outcome || state.task.id, 120);
  const body = buildPrBody(state);
  // Through the injected `exec`, like every other command in this function.
  //
  // This one call used execFileSync directly, which made the publish path only
  // half-injectable: a caller could stub `gh pr list` and still shell out to the
  // real `gh` to create a pull request. That is why the hermetic objective smoke
  // had to declare gh unavailable altogether, which then classified a
  // successfully-pushed node as a publication failure and blocked the whole
  // objective. A test that cannot reach the success path stops testing it.
  const created = exec(worktree, ["gh", "pr", "create", "--repo", slug, "--head", branch, "--title", title, "--body", body]);
  if (created.ok) {
    const url = String(created.out || "").trim();
    return { published: true, pushed: true, prUrl: url || null, ...audit };
  }
  {
    const error = { stderr: created.out, message: created.out };
    // `gh pr create` refuses when a pull request for this branch already
    // exists — and names it in the refusal. That happens routinely: the
    // existence check above only looks at OPEN pull requests, so a release
    // re-run after a merge lands here. Dropping the URL it was just handed
    // left the task with no way to know which pull request carries its work,
    // so it could never learn that the work had shipped.
    const message = String(error.stderr || error.message).trim();
    const recovered = recoverExistingPrUrl(message, slug);
    return {
      published: true,
      pushed: true,
      prUrl: recovered,
      ...audit,
      reason: recovered ? `pull request already exists: ${recovered}` : `gh pr create failed: ${message}`,
    };
  }
}

// The pull request named inside a `gh pr create` "already exists" refusal.
//
// Narrow on purpose: it reads a URL out of an error string, so it accepts only
// the shape gh actually produces, and only a pull request in the repository the
// publish targeted. Anything else returns null and the raw message is kept.
//
// @param {string} message   stderr/message from the failed `gh pr create`
// @param {string} ownerRepo the repository the publish targeted ("owner/name")
// @returns {string|null}
export function recoverExistingPrUrl(message, ownerRepo) {
  const text = String(message || "");
  if (!/already exists/i.test(text)) return null;
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(ownerRepo || ""))) return null;
  const pattern = new RegExp(`https://github\\.com/${ownerRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/(\\d+)\\b`);
  const match = text.match(pattern);
  return match ? match[0] : null;
}

function truncate(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`;
}
