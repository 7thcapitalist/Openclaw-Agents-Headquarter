// AGENTS.md: "Reversible implementation details should be decided
// autonomously. Escalate only strategic, costly, privacy-sensitive,
// destructive, or hard-to-reverse decisions."
//
// That rule was enforced by nothing, so a stage could page the founder about a
// UI scope call. These hold the gate that enforces it — and, just as hard, hold
// that an unescalated decision is never a lost one.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCompletionReport } from "../lib/hq/completion-report.mjs";
import { FOUNDER_IMPACTS, escalationVerdict } from "../lib/hq/escalation-gate.mjs";
import { buildFounderOverview } from "../../dashboard/backend/lib/founderControlPlane.mjs";
import { completeStage, createState, writeState } from "../lib/task-workflow.mjs";

const REAL_QUESTION = {
  question: "Should the export include the user's raw health entries?",
  options: ["A. Aggregates only", "B. Raw entries"],
  recommendation: "A — raw entries widen the data we retain.",
};

// The question that started this: a reversible UI scope call, deferred to the
// founder by the architect, answered seven times because it never went away.
const REVERSIBLE_QUESTION = {
  question: "Should the Chapter screen support creating/editing chapters this milestone?",
  options: ["A. Read-only this milestone", "B. Read-write now"],
};

function taskState() {
  const root = mkdtempSync(join(tmpdir(), "escalation-"));
  const worktree = join(root, "worktree");
  mkdirSync(worktree, { recursive: true });
  return createState({
    task: { id: "task-gate", issue: "local:gate", outcome: "Ship the export", acceptanceCriteria: ["it exports"], project: "demo", workType: "backend", risk: "low" },
    repo: join(root, "repo"), branch: "factory/task-gate", worktree,
  });
}

// Every stage must carry evidence; that is unrelated to the gate, so the tests
// supply it the same way the workflow suite does.
function pass(stage, actor, extra = {}) {
  return { stage, actor, outcome: "pass", summary: `${stage} completed`, evidence: [{ path: `evidence/${stage}.md` }], ...extra };
}

test("the escalation vocabulary is the decision protocol's own, so the two cannot drift", () => {
  assert.deepEqual(
    [...FOUNDER_IMPACTS].sort(),
    ["irreversible", "legal", "privacy", "product-direction", "public", "scope", "security-posture", "spend"],
  );
});

test("a declared founder-owned impact escalates", () => {
  for (const impact of FOUNDER_IMPACTS) {
    const verdict = escalationVerdict({ ...REAL_QUESTION, impact });
    assert.equal(verdict.escalate, true, `${impact} is founder-owned`);
    assert.equal(verdict.impact, impact);
  }
  // Declared sloppily is still declared.
  assert.equal(escalationVerdict({ impact: "  Privacy  " }).escalate, true);
});

test("an undeclared decision is the agent's own call", () => {
  const verdict = escalationVerdict(REVERSIBLE_QUESTION);
  assert.equal(verdict.escalate, false);
  assert.equal(verdict.impact, null);
  assert.match(verdict.reason, /agent's own call/i);
});

test("an impact outside the protocol's vocabulary does not buy an escalation", () => {
  for (const impact of ["ui", "urgent", "important", "refactor", "founder", "high"]) {
    const verdict = escalationVerdict({ ...REVERSIBLE_QUESTION, impact });
    assert.equal(verdict.escalate, false, `"${impact}" is not a founder-owned impact`);
    assert.match(verdict.reason, /not a founder-owned impact/i);
  }
});

test("completeStage records the verdict on the decision and in the event log", () => {
  const escalated = completeStage(taskState(), pass("product", "openclaw", {
    deferredDecision: { ...REAL_QUESTION, impact: "privacy" },
    now: "2026-09-14T05:00:00.000Z",
  }));
  const decision = escalated.deferredDecisions[0];
  assert.equal(decision.escalate, true);
  assert.equal(decision.impact, "privacy");
  // `Other` is still appended, and the question is untouched.
  assert.equal(decision.options.length, 3);

  const event = escalated.events.find((e) => e.type === "stage-decision-deferred");
  assert.equal(event.escalated, true);
  assert.equal(event.impact, "privacy");

  const quiet = completeStage(taskState(), pass("product", "openclaw", {
    deferredDecision: REVERSIBLE_QUESTION,
    now: "2026-09-14T05:00:00.000Z",
  }));
  assert.equal(quiet.deferredDecisions[0].escalate, false);
  const quietEvent = quiet.events.find((e) => e.type === "stage-decision-deferred");
  assert.equal(quietEvent.escalated, false, "the stage still asked, and the log still says so");
  assert.match(quietEvent.reason, /own call/i);
});

test("only a founder-owned decision reaches the Founder Inbox", () => {
  const root = mkdtempSync(join(tmpdir(), "escalation-inbox-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });

  const write = (id, deferredDecision) => {
    const worktree = join(root, "tasks", id, "worktree");
    mkdirSync(worktree, { recursive: true });
    let state = createState({
      task: { id, issue: `local:${id}`, outcome: `Ship ${id}`, acceptanceCriteria: ["works"], project: "demo", workType: "backend", risk: "low" },
      repo, branch: `factory/${id}`, worktree,
    });
    state = completeStage(state, pass("product", "openclaw", { deferredDecision, now: "2026-09-14T05:00:00.000Z" }));
    state.status = "merge-ready";
    state.currentStage = null;
    writeState(join(root, "dashboard/backend/data/factory/demo/tasks", id, "state.json"), state);
  };

  write("task-privacy", { ...REAL_QUESTION, impact: "privacy" });
  write("task-ui-scope", REVERSIBLE_QUESTION);

  const inbox = buildFounderOverview(root, [{ id: "demo", name: "Demo" }]).inbox;
  assert.equal(inbox.length, 1, "the reversible UI scope call must not page the founder");
  assert.equal(inbox[0].taskId, "task-privacy");
  assert.match(inbox[0].title, /raw health entries/);
});

test("a decision the founder never saw is still written down for them", () => {
  let state = completeStage(taskState(), pass("product", "openclaw", { now: "2026-09-14T04:00:00.000Z" }));
  state = completeStage(state, pass("architect", state.assignments.architect, {
    deferredDecision: REVERSIBLE_QUESTION,
    now: "2026-09-14T05:00:00.000Z",
  }));
  state.status = "merge-ready";

  const report = buildCompletionReport(state, { now: Date.parse("2026-09-14T06:00:00.000Z") });
  assert.match(report, /## Choices made along the way/);
  assert.match(report, /Should the Chapter screen support creating\/editing chapters/);
  assert.match(report, /decided by architect/);
});

test("an escalated decision reads as waiting, and an answered one as answered", () => {
  let state = completeStage(taskState(), pass("product", "openclaw", {
    deferredDecision: { ...REAL_QUESTION, impact: "privacy" },
    now: "2026-09-14T05:00:00.000Z",
  }));
  state.status = "merge-ready";
  assert.match(buildCompletionReport(state, { now: Date.now() }), /waiting on the founder/);

  state.deferredDecisions[0].founderResponse = "A. Aggregates only";
  assert.match(buildCompletionReport(state, { now: Date.now() }), /founder chose: A\. Aggregates only/);
});

test("the gate changes who is asked, never what is validated", () => {
  // A decision still has to be a real question with real options, gate or no gate.
  assert.throws(() => completeStage(taskState(), pass("product", "openclaw", {
    deferredDecision: { question: "", options: ["A", "B"], impact: "privacy" },
  })), /plain-language question/);
  assert.throws(() => completeStage(taskState(), pass("product", "openclaw", {
    deferredDecision: { question: "Which?", options: ["A"], impact: "privacy" },
  })), /at least two options/);
});
