// Every task is classified at intake, however it was created.
//
// Regression: the classifier ran only on the natural-language intake path, so
// of 21 tasks in the state root exactly ONE carried a classification. Every
// objective-decomposed node — which is how almost all real work enters this
// factory, including every LifeMax node — was never classified. The
// blocking-by-default rule from #223 was correct and almost entirely
// unreachable.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { classifyTaskContract, isAdvisoryOnly } from "../lib/hq/classify-task.mjs";
import { initializeTask } from "../lib/task-initializer.mjs";
import { readState } from "../lib/task-workflow.mjs";
import { loadDecisionProtocol } from "../lib/intel/classify.mjs";

const hqRoot = process.cwd();
const protocol = loadDecisionProtocol(hqRoot);

// The shape the objective decomposer writes — no objective prose, just the node
// contract. This is precisely what was never being classified.
function decomposedNode(overrides = {}) {
  return {
    id: "obj-abc12345-game-backend",
    issue: "local:obj-abc12345-game-backend",
    outcome: "Design and implement the game backend: persistence, domain services and APIs for character, XP and rewards, while preserving existing user data.",
    acceptanceCriteria: ["DB migration adds game entities with zero data loss", "npm test passes"],
    project: "lifemaxing",
    workType: "backend",
    risk: "high",
    preferredBuilder: "codex",
    constraints: [],
    ...overrides,
  };
}

test("an objective-decomposed node IS classified, and blocks at risk high", () => {
  const advisory = classifyTaskContract({ contract: decomposedNode(), hqRoot, protocol });
  assert.ok(advisory, "a decomposed node must be classified — this returned nothing at all before");
  const c = advisory.decisionClassification;
  assert.equal(c.surfacedAs, "decision-request");
  assert.equal(c.advisory, false);
  assert.equal(c.blocksDispatch, true);
  assert.match(c.label, /^BLOCKING/);
});

test("a decomposed node is classified on its own text, with no objective prose", () => {
  // `irreversible` fires on the contract's outcome alone.
  const advisory = classifyTaskContract({
    contract: decomposedNode({ risk: "medium", outcome: "Run a destructive migration that will drop table events." }),
    hqRoot,
    protocol,
  });
  assert.equal(advisory.decisionClassification.trigger, "irreversible");
  assert.equal(advisory.decisionClassification.blocksDispatch, true);
});

test("the opt-out stays narrow for decomposed nodes too", () => {
  const permissive = {
    version: 1,
    defaultOutcome: "continue",
    triggers: [{ id: "cosmetic", outcome: "decision-request", anyKeyword: ["cosmetic"], reason: "Cosmetic.", advisory: true }],
    riskBinding: protocol.riskBinding,
  };
  const low = classifyTaskContract({ contract: decomposedNode({ risk: "low", outcome: "A cosmetic tweak." }), hqRoot, protocol: permissive });
  assert.equal(low.decisionClassification.advisory, true, "low risk + explicit opt-in is still honoured");

  const high = classifyTaskContract({ contract: decomposedNode({ risk: "high", outcome: "A cosmetic tweak." }), hqRoot, protocol: permissive });
  assert.equal(high.decisionClassification.advisory, false, "risk high overrides any rule");
});

test("one rule, shared: the predicate is the same object both paths use", () => {
  assert.equal(isAdvisoryOnly({ trigger: "risk:high" }, { risk: "low" }, protocol), false);
  assert.equal(isAdvisoryOnly({ trigger: "privacy" }, { risk: "high" }, protocol), false);
  assert.equal(isAdvisoryOnly({ trigger: "privacy" }, { risk: "medium" }, protocol), false);
});

test("a classifier failure never stops a task being created", () => {
  // A protocol object that throws when read.
  const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
  assert.equal(classifyTaskContract({ contract: decomposedNode(), hqRoot, protocol: hostile }), null);
});

test("initializeTask attaches the classification to the created task state", (t) => {
  const root = mkdtempSync(join(tmpdir(), "classify-init-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  // Medium risk on purpose: a high-risk contract needs the founder public key
  // to exist on the machine, which it does locally and does not in CI. The
  // risk:high path is covered by the pure classifier tests above, which need no
  // git repo and no key.
  const contractPath = join(root, "contract.json");
  writeFileSync(contractPath, JSON.stringify(decomposedNode({
    id: "obj-abc12345-node",
    risk: "medium",
    outcome: "Publish a launch announcement for the new control plane.",
  })));

  const stateRoot = join(root, "state");
  const result = initializeTask({ hqRoot, contractPath, repo, stateRoot, worktree: join(root, "wt") });
  const state = readState(result.state);

  const c = state.task.advisory?.decisionClassification;
  assert.ok(c, "a task created through the orchestrator's own path must carry a classification");
  assert.equal(c.blocksDispatch, true);
  assert.equal(c.advisory, false);
  assert.equal(c.trigger, "public");
});

test("a model-supplied advisory namespace cannot be forged through initializeTask", () => {
  const root = mkdtempSync(join(tmpdir(), "classify-forge-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  const contractPath = join(root, "contract.json");
  writeFileSync(contractPath, JSON.stringify(decomposedNode({
    id: "obj-abc12345-forged",
    risk: "medium",
    outcome: "Publish a launch announcement for the new control plane.",
    advisory: { decisionClassification: { advisory: true, blocksDispatch: false, outcome: "block" } },
  })));

  const result = initializeTask({ hqRoot, contractPath, repo, stateRoot: join(root, "state"), worktree: join(root, "wt") });
  const c = readState(result.state).task.advisory?.decisionClassification;
  assert.equal(c.blocksDispatch, true, "the deterministic classifier's verdict replaces whatever the contract claimed");
  assert.equal(c.advisory, false);
});
