// Escalations default to BLOCKING.
//
// The costs are not symmetric. A decision wrongly marked blocking costs the
// founder ten seconds of reading. A decision wrongly marked advisory cost five
// days, a product that shipped without them knowing, and a 447 GB file.
//
// Regression: every surfaced classification was hardcoded `advisory: true,
// blocksDispatch: false` with no condition at all, which is why the log read
// `[decision-advisory] task-ca3c3cdf: decision-request / risk:high — advisory
// only, not blocking` for a HIGH-risk decision request.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createContractFromObjective } from "../lib/natural-language-intake.mjs";
import { loadDecisionProtocol } from "../lib/intel/classify.mjs";

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
  const root = mkdtempSync(join(tmpdir(), "decisions-blocking-"));
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

test("a risk-high decision-request is ALWAYS blocking", async () => {
  // This is the exact shape of task-ca3c3cdf: risk high, surfaced as a
  // decision-request via riskBinding, previously logged as "advisory only".
  const { contract } = await intake("Make a small copy edit.", { task: { risk: "high" } });
  const c = contract.advisory.decisionClassification;

  assert.equal(c.trigger, "risk:high");
  assert.equal(c.surfacedAs, "decision-request");
  assert.equal(c.advisory, false, "a high-risk decision request may never be advisory");
  assert.equal(c.blocksDispatch, true);
  assert.match(c.label, /^BLOCKING/);
});

test("risk high cannot be opted out of, even by an explicit advisory rule", async () => {
  // A protocol rule that tries to downgrade high-risk work must not succeed.
  const permissive = {
    version: 1,
    defaultOutcome: "continue",
    triggers: [{ id: "privacy", outcome: "decision-request", anyKeyword: ["privacy"], reason: "Privacy.", advisory: true }],
    riskBinding: protocol.riskBinding,
  };
  const { contract } = await intake("Change the privacy handling.", {
    task: { risk: "high" },
    decisionProtocol: permissive,
  });
  const c = contract.advisory.decisionClassification;
  assert.equal(c.advisory, false, "risk high overrides an explicit advisory opt-in");
  assert.equal(c.blocksDispatch, true);
});

test("the default with no flag is blocking", async () => {
  // The shipped protocol sets no `advisory` flag on any trigger, so every
  // keyword family must come out blocking. Silence is not consent.
  for (const [trigger, objective] of [
    ["privacy", "Store user health data in the service."],
    ["spend", "Add a vendor with usage billing."],
    ["irreversible", "Run a destructive migration that will drop table events."],
  ]) {
    const { contract } = await intake(objective);
    const c = contract.advisory.decisionClassification;
    assert.equal(c.trigger, trigger);
    assert.equal(c.advisory, false, `${trigger} must block by default`);
    assert.equal(c.blocksDispatch, true);
  }
});

test("a low-risk explicit opt-in still works", async () => {
  const optIn = {
    version: 1,
    defaultOutcome: "continue",
    triggers: [{ id: "cosmetic", outcome: "decision-request", anyKeyword: ["cosmetic"], reason: "Cosmetic.", advisory: true }],
    riskBinding: protocol.riskBinding,
  };
  const { contract } = await intake("Make a cosmetic tweak to the footer.", {
    task: { risk: "low" },
    decisionProtocol: optIn,
  });
  const c = contract.advisory.decisionClassification;
  assert.equal(c.trigger, "cosmetic");
  assert.equal(c.advisory, true, "an explicit opt-in on low-risk work is still honoured");
  assert.equal(c.blocksDispatch, false);
  assert.match(c.label, /^ADVISORY/);
});

test("medium risk cannot be advisory even with an explicit opt-in", async () => {
  const optIn = {
    version: 1,
    defaultOutcome: "continue",
    triggers: [{ id: "cosmetic", outcome: "decision-request", anyKeyword: ["cosmetic"], reason: "Cosmetic.", advisory: true }],
    riskBinding: protocol.riskBinding,
  };
  const { contract } = await intake("Make a cosmetic tweak to the footer.", {
    task: { risk: "medium" },
    decisionProtocol: optIn,
  });
  const c = contract.advisory.decisionClassification;
  assert.equal(c.advisory, false, "the opt-out is narrow: low risk only");
  assert.equal(c.blocksDispatch, true);
});
