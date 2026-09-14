import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createContractFromObjective } from "../lib/natural-language-intake.mjs";
import { loadDecisionProtocol } from "../lib/intel/classify.mjs";
import { createState } from "../lib/task-workflow.mjs";
import { writeHandoff } from "../lib/handoff.mjs";

const hqRoot = process.cwd();
const protocol = loadDecisionProtocol(hqRoot);

function taskJson(id, overrides = {}) {
  return JSON.stringify({
    id,
    issue: `local:${id}`,
    outcome: "Complete the requested work.",
    acceptanceCriteria: ["The requested behavior is verified."],
    project: "project",
    workType: "backend",
    risk: "low",
    preferredBuilder: "auto",
    constraints: [],
    ...overrides,
  });
}

async function intake(objective, { task = {}, decisionProtocol = protocol } = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-intake-advisory-"));
  const repo = join(root, "project");
  mkdirSync(repo);
  return createContractFromObjective({
    objective,
    repo,
    stateRoot: join(root, "state"),
    hqRoot,
    protocol: decisionProtocol,
    execute: async ({ id }) => taskJson(id, task),
  });
}

test("natural-language intake surfaces every keyword trigger family with its matched protocol rule", async () => {
  const cases = [
    ["privacy", "Store user health data in the service."],
    ["spend", "Add a vendor with usage billing."],
    ["public", "Publish a launch announcement."],
    ["product-direction", "Change the target user for the product."],
    ["irreversible", "Run a destructive migration that will drop table events."],
    ["security-posture", "Change the authentication model."],
    ["legal", "Update the terms of service after legal review."],
  ];

  for (const [trigger, objective] of cases) {
    const { contract } = await intake(objective);
    const classification = contract.advisory.decisionClassification;
    // Blocking is the default. None of the shipped triggers sets `advisory: true`,
    // and silence is not consent.
    assert.equal(classification.advisory, false);
    assert.equal(classification.blocksDispatch, true);
    assert.equal(classification.outcome, "decision-request");
    assert.equal(classification.surfacedAs, "decision-request");
    assert.equal(classification.trigger, trigger);
    assert.equal(classification.matchedRule.id, trigger);
    assert.equal(classification.matchedRule.source, "trigger");
  }
});

test("intake passes contract risk and workType into classification", async () => {
  const workTypeProtocol = {
    version: 1,
    defaultOutcome: "continue",
    triggers: [{ id: "backend-work", outcome: "decision-request", anyField: { workType: "backend" }, reason: "Backend rule." }],
    riskBinding: protocol.riskBinding,
  };
  const workType = await intake("Implement a bounded endpoint.", { decisionProtocol: workTypeProtocol });
  assert.equal(workType.contract.advisory.decisionClassification.trigger, "backend-work");

  const highRisk = await intake("Make a small copy edit.", { task: { risk: "high" } });
  const classification = highRisk.contract.advisory.decisionClassification;
  assert.equal(classification.trigger, "risk:high");
  assert.equal(classification.matchedRule.source, "riskBinding");
});

test("scope remains covered by the classifier's structured-field test", () => {
  const scopeRule = protocol.triggers.find((rule) => rule.id === "scope");
  assert.deepEqual(scopeRule.anyField, { changesMilestonePriority: true });
  // Natural-language intake intentionally passes only validated contract risk
  // and workType. The classifier unit suite exercises this structured signal.
});

test("ask and block outcomes are surfaced as blocking decisions", async () => {
  for (const outcome of ["ask", "block"]) {
    const customProtocol = {
      version: 1,
      defaultOutcome: "continue",
      triggers: [{ id: `${outcome}-rule`, outcome, anyKeyword: [outcome], reason: `${outcome} reason.` }],
    };
    const { contract } = await intake(`Please ${outcome} before proceeding.`, { decisionProtocol: customProtocol });
    const classification = contract.advisory.decisionClassification;
    assert.equal(classification.outcome, outcome);
    assert.equal(classification.surfacedAs, outcome === "block" ? "decision-request" : "ask");
    assert.equal(classification.blocksDispatch, true);
    assert.equal(classification.matchedRule.id, `${outcome}-rule`);
  }
});

test("ordinary reversible work remains unflagged and keeps the written contract shape", async () => {
  const result = await intake("Rename a helper and add a unit test.");
  assert.equal(Object.hasOwn(result, "advisory"), true);
  assert.equal(result.advisory, undefined);
  assert.equal(Object.hasOwn(result.contract, "advisory"), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(result.contractPath, "utf8")), "advisory"), false);
});

test("chief of staff can ask one material intake question without starting work", async () => {
  const result = await intake("Launch this for customers.", {
    task: { questions: [{ question: "Which customer group is this for?", options: ["A: families", "B: clinicians"], why: "This changes the product promise." }] },
  });
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].question, "Which customer group is this for?");
  assert.equal(result.contractPath, null);
});

test("intake model output cannot forge the classifier-owned advisory namespace", async () => {
  const forged = { decisionClassification: { advisory: true, blocksDispatch: true, outcome: "block" } };
  const result = await intake("Rename a helper and add a unit test.", { task: { advisory: forged } });
  assert.equal(result.advisory, undefined);
  assert.equal(Object.hasOwn(result.contract, "advisory"), false);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(result.contractPath, "utf8")), "advisory"), false);
});

test("advisory survives state creation and is visibly rendered before the outcome", async () => {
  const secretMarker = "do-not-copy-objective-marker";
  const { contract } = await intake(`Store health data for ${secretMarker}.`);
  const root = mkdtempSync(join(tmpdir(), "factory-advisory-handoff-"));
  const state = createState({
    task: contract,
    repo: join(root, "repo"),
    branch: `factory/${contract.id}`,
    worktree: join(root, "worktree"),
  });
  const statePath = join(root, "state", "state.json");
  mkdirSync(join(root, "state"));
  const handoffPath = writeHandoff({ hqRoot, statePath, state });
  const handoff = readFileSync(handoffPath, "utf8");

  assert.deepEqual(state.task.advisory, contract.advisory);
  assert.match(handoff, /## Advisory decision classification/);
  assert.match(handoff, /Blocks dispatch: yes/);
  assert.ok(handoff.indexOf("## Advisory decision classification") < handoff.indexOf("## Outcome"));
  assert.equal(JSON.stringify(contract.advisory).includes(secretMarker), false);
  assert.equal(handoff.includes(secretMarker), false);
});

test("ordinary handoffs do not render the guarded advisory section", async () => {
  const { contract } = await intake("Rename a helper and add a unit test.");
  const root = mkdtempSync(join(tmpdir(), "factory-ordinary-handoff-"));
  const state = createState({ task: contract, repo: join(root, "repo"), branch: `factory/${contract.id}`, worktree: join(root, "worktree") });
  const statePath = join(root, "state", "state.json");
  mkdirSync(join(root, "state"));
  const handoff = readFileSync(writeHandoff({ hqRoot, statePath, state }), "utf8");
  assert.doesNotMatch(handoff, /Advisory decision classification/);
});
