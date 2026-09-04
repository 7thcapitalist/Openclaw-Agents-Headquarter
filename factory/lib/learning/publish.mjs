// Publish learning proposals as a dedicated branch + PR.
//
// Founder-chosen path: each synthesis run that has proposals writes the drafted
// knowledge-file entries onto a fresh `learning/<date>-<slug>` branch and opens a
// PR, so review happens in GitHub. Isolation is via `git worktree add` — the
// same mechanism the factory already uses for tasks — so the operator's working
// tree is never touched and only files under factory/knowledge/ are staged.
//
// Every external step (remote, gh) is guarded: missing tooling degrades to a
// local commit with a clear note, never an error.

import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    if (allowFailure) return { ok: false, out: String(error.stderr || error.message).trim() };
    throw new Error(`git ${args.join(" ")} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

function hasGh() {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function branchName(now = new Date().toISOString(), slug = "proposals") {
  return `learning/${now.slice(0, 10)}-${slug}`.replace(/[^a-zA-Z0-9/_-]/g, "-");
}

// files: [{ path: "factory/knowledge/LESSONS_LEARNED.md", content: "<full file>" }]
// `applyFiles` receives the checkout dir and must write the final file contents
// (the caller has already merged proposed entries into the existing bodies).
export function publishProposals({
  hqRoot,
  branch,
  files,
  commitTitle,
  commitBody = "",
  prTitle,
  prBody = "",
  now = new Date().toISOString(),
  runGit = git,
  ghAvailable = hasGh,
}) {
  if (!files?.length) return { published: false, reason: "no files to publish" };
  const repo = resolve(hqRoot);
  const top = runGit(repo, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!top.ok) return { published: false, reason: "hqRoot is not a git repository" };

  const exists = runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
  if (exists.ok) return { published: false, reason: `branch already exists: ${branch}` };

  const checkout = mkdtempSync(join(tmpdir(), "learning-publish-"));
  const notes = [];
  try {
    runGit(repo, ["worktree", "add", "-b", branch, checkout, "HEAD"]);
    for (const f of files) {
      const abs = join(checkout, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content, "utf8");
    }
    runGit(checkout, ["add", "--", ...files.map((f) => f.path)]);
    const staged = runGit(checkout, ["diff", "--cached", "--name-only"], { allowFailure: true });
    if (!staged.ok || !staged.out) {
      return { published: false, reason: "proposals produced no file changes", branch: null };
    }
    const message = commitBody ? `${commitTitle}\n\n${commitBody}` : commitTitle;
    runGit(checkout, ["-c", "user.name=OpenClaw Learning Agent", "-c", "user.email=learning@openclaw.local", "commit", "-m", message]);

    const hasRemote = runGit(checkout, ["remote"], { allowFailure: true });
    let pushed = false;
    let prUrl = null;
    if (hasRemote.ok && hasRemote.out.split("\n").includes("origin")) {
      const push = runGit(checkout, ["push", "-u", "origin", branch], { allowFailure: true });
      pushed = push.ok;
      if (!pushed) notes.push(`push failed: ${push.out}`);
      if (pushed && ghAvailable()) {
        try {
          const url = execFileSync("gh", [
            "pr", "create", "--head", branch, "--title", prTitle || commitTitle,
            "--body", prBody || commitBody || "Automated learning proposals.",
          ], { cwd: checkout, encoding: "utf8" }).trim();
          prUrl = url || null;
        } catch (error) {
          notes.push(`gh pr create failed: ${String(error.stderr || error.message).trim()}`);
        }
      } else if (pushed) {
        notes.push("gh CLI not available; open the PR manually.");
      }
    } else {
      notes.push("no 'origin' remote; branch committed locally only.");
    }

    return { published: true, branch, committed: true, pushed, prUrl, notes, files: files.map((f) => f.path) };
  } finally {
    runGit(repo, ["worktree", "remove", "--force", checkout], { allowFailure: true });
    rmSync(checkout, { recursive: true, force: true });
  }
}
