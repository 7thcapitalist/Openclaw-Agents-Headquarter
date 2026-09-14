import { execFileSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { createState, taskStatePath, validateTaskContract, writeState } from "./task-workflow.mjs";
import { writeHandoff } from "./handoff.mjs";
import { checkCapability } from "./hq/capability-check.mjs";

// The public half of the founder approval authority embedded into every
// high-risk task at creation. Prefer the key the founder enrolled from
// Headquarters (data/factory/founder-approval-key.pem); fall back to the
// FACTORY_FOUNDER_PUBLIC_KEY env path for the pre-enrollment / CLI setup.
export function resolveFounderPublicKey(hqRoot) {
  const enrolled = join(hqRoot, "dashboard", "backend", "data", "factory", "founder-approval-key.pem");
  if (existsSync(enrolled)) return readFileSync(enrolled, "utf8");
  const envPath = process.env.FACTORY_FOUNDER_PUBLIC_KEY;
  return envPath && existsSync(resolve(envPath)) ? readFileSync(resolve(envPath), "utf8") : null;
}

export function initializeTask({ hqRoot, contractPath, repo: repoInput, branch: requestedBranch, worktree: requestedWorktree, stateRoot: requestedStateRoot, git = runGit, actor = null }) {
  if (!contractPath || !repoInput) throw new Error("Initialization requires contractPath and repo.");
  const task = validateTaskContract(JSON.parse(readFileSync(resolve(contractPath), "utf8")));

  // Creating a branch and a worktree is the first irreversible thing a task
  // does, so it is where the capability check belongs. With no
  // factory/permissions.json this is a no-op — see hq/permissions.mjs.
  checkInitializePermission({ hqRoot, task, actor });
  const repo = git(resolve(repoInput), ["rev-parse", "--show-toplevel"]).trim();
  const branch = requestedBranch || `factory/${task.id}`;
  if (!/^factory\/[a-z0-9][a-z0-9-]*$/.test(branch)) throw new Error("Branch must use factory/<task-id> format.");
  const stateRoot = resolve(requestedStateRoot || join(hqRoot, "dashboard", "backend", "data", "factory", basename(repo)));
  const statePath = taskStatePath(stateRoot, task.id);
  if (existsSync(statePath)) throw new Error(`Task state already exists: ${statePath}`);
  const worktree = resolve(requestedWorktree || join(dirname(repo), ".openclaw-worktrees", `${basename(repo)}-${task.id}`));
  if (existsSync(worktree)) throw new Error(`Worktree path already exists: ${worktree}`);
  let maxRecoveryAttempts = 3;
  try { maxRecoveryAttempts = JSON.parse(readFileSync(join(hqRoot, "factory", "factory.config.json"), "utf8")).openclawIntegration?.maxRecoveryAttempts || 3; } catch { /* safe default */ }
  const state = createState({ task, repo, branch, worktree, founderPublicKey: resolveFounderPublicKey(hqRoot), maxRecoveryAttempts });
  if (git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true }).ok) {
    throw new Error(`Branch already exists: ${branch}`);
  }
  // The commit the task branch is cut from — recorded so the GitHub publish
  // step can prove the branch is ahead of its base before pushing.
  const baseShaResult = git(repo, ["rev-parse", "HEAD"], { allowFailure: true });
  state.baseSha = baseShaResult.ok ? String(baseShaResult.stdout).trim() || null : null;
  mkdirSync(dirname(worktree), { recursive: true });
  git(repo, ["worktree", "add", "-b", branch, worktree]);
  ensureEvidenceIgnored({ worktree, branch, git });
  writeState(statePath, state);
  writeHandoff({ hqRoot, statePath, state });
  return { task: task.id, state: statePath, branch, worktree, next: "product" };
}

// Every stage handoff tells agents to write their gate proof to `evidence/` and
// promises that directory is git-ignored. Nothing guaranteed it: in a project
// that does not already ignore it, the factory's own evidence files show up as
// untracked and — because Prettier and ESLint honour .gitignore — break the
// project's `verify` gate with warnings about factory markdown rather than
// product code. Establish the promise once, on the task branch, before any
// agent runs, as an isolated commit that never mixes into the deliverable.
// Best-effort by construction: this is a convenience that keeps the factory's
// own proof artifacts out of the deliverable, never a precondition for running
// the task. A read-only tree, a detached index, or a commit hook that rejects
// the change must leave initialization intact, so every failure path returns
// false instead of propagating.
export function ensureEvidenceIgnored({ worktree, branch, git = runGit }) {
  try {
    const gitignore = join(worktree, ".gitignore");
    const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
    if (/^\s*\/?evidence\/?\s*$/m.test(current)) return false;
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    appendFileSync(gitignore, `${prefix}\n# Factory gate evidence (per-task proof artifacts, never product files).\n# Anchored: a run writes evidence to the worktree root, and an unanchored\n# pattern would also swallow product source in any nested directory of that\n# name — which is how factory/lib/evidence/ was silently dropped from every\n# \`git add -A\` in this repository until #167.\n/evidence/\n`, "utf8");
    const paths = [".gitignore", ...ensureEvidenceLintIgnored(worktree)];
    const staged = git(worktree, ["add", ...paths], { allowFailure: true });
    if (!staged?.ok) return false;
    const committed = git(worktree, ["commit", "-m", `chore(factory): ignore evidence/ on ${branch}`, "--no-verify"], { allowFailure: true });
    return Boolean(committed?.ok);
  } catch {
    return false;
  }
}

// Prettier reads .gitignore, so ignoring evidence/ there is enough for it.
// ESLint 9's flat config does not: it dropped .eslintignore and honours only
// its own `ignores`, so a QA agent's scratch .ts under evidence/ still fails
// `eslint . --max-warnings=0` on a file that is not product code. Add the entry
// to the project's existing top-level ignores list when we can do it safely;
// anything unrecognised is left untouched rather than rewritten.
export function ensureEvidenceLintIgnored(worktree) {
  for (const name of ["eslint.config.mjs", "eslint.config.js", "eslint.config.cjs"]) {
    const configPath = join(worktree, name);
    if (!existsSync(configPath)) continue;
    const current = readFileSync(configPath, "utf8");
    if (/["'`]evidence\/\*\*["'`]/.test(current)) return [];
    const ignores = current.match(/(\n\s*)ignores:\s*\[/);
    if (!ignores) return [];
    const insertAt = current.indexOf(ignores[0]) + ignores[0].length;
    const indent = `${ignores[1].replace(/\n/, "")}  `;
    const entry = `\n${indent}// Factory gate evidence, not product code.\n${indent}"evidence/**",`;
    writeFileSync(configPath, current.slice(0, insertAt) + entry + current.slice(insertAt), "utf8");
    return [name];
  }
  return [];
}

// Denials are audited into the task's own log where one exists; before
// initialization there is no task directory yet, so the decision is recorded
// against the objective/company log at the state root instead. A registry that
// cannot be read is a denial, not a bypass: a broken permissions file must not
// silently disable the control it configures.
function checkInitializePermission({ hqRoot, task, actor }) {
  checkCapability({
    hqRoot,
    capability: "task.initialize",
    action: "initialize",
    actor,
    scope: { type: "task", id: task.id, projectId: task.project || null },
    founderApproval: task.founderApproval || null,
    correlation: { taskId: task.id, ...(task.project ? { projectId: task.project } : {}) },
  });
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
