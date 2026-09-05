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

/**
 * @param {object}   input
 * @param {string}   input.hqRoot
 * @param {object}   input.state       the task's full state.json (must be status: "merge-ready")
 * @param {Function} [input.exec]      (cwd, args:string[]) => {ok, out} — git/gh runner, injected for tests
 * @param {Function} [input.ghAvailable]
 * @returns {{ published:boolean, pushed?:boolean, prUrl?:(string|null), reason?:string }}
 */
export function publishMergeReadyTask({ hqRoot, state, exec = defaultExec, ghAvailable = defaultGhAvailable }) {
  if (!state || state.status !== "merge-ready") {
    return { published: false, reason: "task is not merge-ready" };
  }

  const config = readHqConfig(hqRoot);
  if (config.github?.autoPublish === false) {
    return { published: false, reason: "github.autoPublish is disabled in factory/hq.config.json" };
  }

  const branch = state.branch;
  if (!branch || branch === "main" || branch === "master") {
    return { published: false, reason: `refusing to publish an empty or default branch ("${branch}")` };
  }

  const project = resolveCompanyProject(hqRoot, state.task.project, { withIntelligence: false });
  if (!project?.github?.owner || !project?.github?.repo) {
    return { published: false, reason: `project "${state.task.project}" has no github {owner, repo} configured` };
  }

  const worktree = state.worktree;
  const remotes = exec(worktree, ["git", "remote"]);
  if (!remotes.ok || !remotes.out.split("\n").includes("origin")) {
    return { published: false, reason: "task worktree has no 'origin' remote" };
  }

  const push = exec(worktree, ["git", "push", "-u", "origin", branch]);
  if (!push.ok) {
    return { published: false, pushed: false, reason: `git push failed: ${push.out}` };
  }

  if (!ghAvailable()) {
    return { published: true, pushed: true, prUrl: null, reason: "gh CLI unavailable; open the PR manually" };
  }

  const slug = `${project.github.owner}/${project.github.repo}`;
  const title = truncate(state.task.outcome || state.task.id, 120);
  const body = buildPrBody(state);
  try {
    const url = execFileSync(
      "gh",
      ["pr", "create", "--repo", slug, "--head", branch, "--title", title, "--body", body],
      { cwd: worktree, encoding: "utf8" }
    ).trim();
    return { published: true, pushed: true, prUrl: url || null };
  } catch (error) {
    return { published: true, pushed: true, prUrl: null, reason: `gh pr create failed: ${String(error.stderr || error.message).trim()}` };
  }
}

function truncate(text, n) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`;
}
