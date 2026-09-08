// Read-only reconciliation: a PR may exist before the release gate passes.
// Observation must never be recorded as a successful publication or gate.
import { execFile } from "child_process";
import { promisify } from "util";
import { readState } from "../task-workflow.mjs";
import { resolveTaskGithubTarget } from "./github-publish.mjs";
const execute = promisify(execFile);

export async function observeObjectivePrs({ hqRoot, objective, run = execute, resolveTarget = resolveTaskGithubTarget }) {
  const prs = [];
  const errors = [];
  for (const node of [...Object.values(objective.nodes || {}), objective.integration].filter(Boolean)) {
    if (!node.statePath || !node.branch) continue;
    try {
      const state = readState(node.statePath);
      const { ownerRepo } = resolveTarget({ hqRoot, state });
      if (!ownerRepo) continue;
      const { stdout } = await run("gh", ["pr", "list", "--repo", ownerRepo, "--head", node.branch,
        "--state", "open", "--json", "url,headRefName,isCrossRepository"], { cwd: state.worktree, timeout: 15000, maxBuffer: 1024 * 1024 });
      for (const pr of JSON.parse(stdout)) {
        if (pr.headRefName === node.branch && pr.isCrossRepository === false
            && pr.url.startsWith(`https://github.com/${ownerRepo}/pull/`)) {
          prs.push({ node: node.id, url: pr.url, source: "github-observation" });
        }
      }
    } catch {
      errors.push({ node: node.id, reason: "PR lookup unavailable; publication count may be incomplete" });
    }
  }
  return { prs, errors };
}
