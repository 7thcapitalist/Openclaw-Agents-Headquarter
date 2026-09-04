import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { createState, taskStatePath, validateTaskContract, writeState } from "./task-workflow.mjs";
import { writeHandoff } from "./handoff.mjs";

export function initializeTask({ hqRoot, contractPath, repo: repoInput, branch: requestedBranch, worktree: requestedWorktree, stateRoot: requestedStateRoot, git = runGit }) {
  if (!contractPath || !repoInput) throw new Error("Initialization requires contractPath and repo.");
  const task = validateTaskContract(JSON.parse(readFileSync(resolve(contractPath), "utf8")));
  const repo = git(resolve(repoInput), ["rev-parse", "--show-toplevel"]).trim();
  const branch = requestedBranch || `factory/${task.id}`;
  if (!/^factory\/[a-z0-9][a-z0-9-]*$/.test(branch)) throw new Error("Branch must use factory/<task-id> format.");
  const stateRoot = resolve(requestedStateRoot || join(hqRoot, "dashboard", "backend", "data", "factory", basename(repo)));
  const statePath = taskStatePath(stateRoot, task.id);
  if (existsSync(statePath)) throw new Error(`Task state already exists: ${statePath}`);
  const worktree = resolve(requestedWorktree || join(dirname(repo), ".openclaw-worktrees", `${basename(repo)}-${task.id}`));
  if (existsSync(worktree)) throw new Error(`Worktree path already exists: ${worktree}`);
  const founderPublicKeyPath = process.env.FACTORY_FOUNDER_PUBLIC_KEY;
  const founderPublicKey = founderPublicKeyPath ? readFileSync(resolve(founderPublicKeyPath), "utf8") : null;
  const state = createState({ task, repo, branch, worktree, founderPublicKey });
  if (git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true }).ok) {
    throw new Error(`Branch already exists: ${branch}`);
  }
  mkdirSync(dirname(worktree), { recursive: true });
  git(repo, ["worktree", "add", "-b", branch, worktree]);
  writeState(statePath, state);
  writeHandoff({ hqRoot, statePath, state });
  return { task: task.id, state: statePath, branch, worktree, next: "product" };
}

export function runGit(repo, args, options = {}) {
  try {
    const stdout = execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: options.allowFailure ? "pipe" : ["ignore", "pipe", "pipe"] });
    return options.allowFailure ? { ok: true, stdout } : stdout;
  } catch (error) {
    if (options.allowFailure) return { ok: false, stdout: "" };
    throw new Error(`git ${args.join(" ")} failed: ${String(error.stderr || error.message).trim()}`);
  }
}
