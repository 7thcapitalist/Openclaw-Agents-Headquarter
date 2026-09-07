import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveProjectRepo } from "../../dashboard/backend/lib/founderControlPlane.mjs";
import { buildObjectiveStateFromNodes } from "../lib/objective/decompose.mjs";
import { runObjective, readObjState } from "../lib/objective/orchestrator.mjs";

test("resolveProjectRepo maps the headquarters project (repo: '.') to the HQ repo root", () => {
  const root = mkdtempSync(join(tmpdir(), "hq-self-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "projects.json"), JSON.stringify({
    version: 1,
    projects: [{ key: "openclaw-factory", name: "HQ", kind: "headquarters", repo: ".", github: { owner: "o", repo: "r" } }],
  }));
  assert.equal(resolveProjectRepo(root, "openclaw-factory"), root);
});

test("a self-improvement objective runs through the normal pipeline and never pushes the repo's default branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "hq-self-e2e-"));
  const repo = join(root, "selfrepo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# self\n");
  const g = (args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  g(["init", "-b", "main"]); g(["config", "user.name", "T"]); g(["config", "user.email", "t@x.l"]);
  g(["add", "."]); g(["commit", "-m", "base"]);
  const mainBefore = execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim();

  const nodes = [
    { id: "tweak", role: "backend-builder", objective: "Small self-improvement", acceptanceCriteria: ["file exists"], workType: "ops", risk: "low", dependsOn: [] },
  ];
  const graph = buildObjectiveStateFromNodes({ objective: "Improve the factory", project: "openclaw-factory", repo, nodes });
  const dir = join(root, "factory-state", "objectives", graph.objectiveId);
  mkdirSync(dir, { recursive: true });
  const objectivePath = join(dir, "objective-state.json");
  writeFileSync(objectivePath, JSON.stringify(graph, null, 2));

  const pushCalls = [];
  const execute = async ({ dispatch }) => {
    mkdirSync(join(dispatch.cwd, "evidence"), { recursive: true });
    writeFileSync(join(dispatch.cwd, "evidence", `${dispatch.stage}.md`), `${dispatch.stage} ok\n`);
    if (dispatch.stage === "builder") {
      // git does not track empty dirs, so the worktree has no src/ until the builder makes it
      mkdirSync(join(dispatch.cwd, "src"), { recursive: true });
      writeFileSync(join(dispatch.cwd, "src", "improvement.mjs"), "export const improved = true;\n");
    }
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor,
      outcome: "pass", summary: `${dispatch.stage} pass`, evidence: [`evidence/${dispatch.stage}.md`],
    }));
  };
  // publish spy: assert it is only ever asked to push a factory/integration-* branch
  const publish = ({ state }) => {
    pushCalls.push(state.branch);
    assert.match(state.branch, /^factory\//, "publish only ever targets a factory/* branch");
    assert.notEqual(state.branch, "main");
    return { published: false, reason: "test — no remote" };
  };

  const res = await runObjective({ hqRoot: process.cwd(), objectivePath, maxConcurrent: 2, stateRoot: join(root, "factory-state"), execute, publish });
  assert.equal(res.status, "complete");

  const obj = readObjState(objectivePath);
  assert.equal(obj.integration.status, "gate-satisfied");
  assert.match(obj.integration.branch, /^factory\/integration-obj-/);
  assert.ok(pushCalls.every((b) => b !== "main" && b !== "master"), "never asked to publish the default branch");

  // the repo's default branch was not moved by the run
  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "main"], { encoding: "utf8" }).trim(), mainBefore);
  assert.ok(existsSync(join(obj.integration.worktree, "src", "improvement.mjs")), "the improvement is on the integration branch, awaiting a PR");
});
