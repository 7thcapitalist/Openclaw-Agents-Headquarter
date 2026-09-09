import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveObjectiveTitle, shortPhrase, titleCase, briefBlocker, normalizeNodeStatus,
  presentObjective, isSeedProject, statusMeta, STATUS, roleLabel, stageVerb,
} from "../lib/hq/presenter.mjs";

test("deriveObjectiveTitle: real founder prompts collapse to a short imperative", () => {
  assert.equal(
    deriveObjectiveTitle("Build a Cost & Limits view for Headquarters so the founder can see, per task/stage/day/project what it cost"),
    "Build Cost & Limits View",
  );
  assert.equal(
    deriveObjectiveTitle("Mission — make this software factory materially better at its job. Its job is: turn a founder objective into shipped work."),
    "Make Software Factory Materially Better",
  );
  assert.equal(
    deriveObjectiveTitle("Implement the three improvements from the read-only codebase analysis (task-81fca3b3 delivered them)"),
    "Implement Three Improvements From Read-only Codebase",
  );
  assert.equal(
    deriveObjectiveTitle("Add two dependency-free ES modules with node:test tests: src/greet.mjs exporting greet(name)"),
    "Add Two Dependency-free ES Modules",
  );
  assert.equal(
    deriveObjectiveTitle("Add a small dependency-free module factory/lib/format-duration.mjs that exports formatDuration"),
    "Add Dependency-free Module",
  );
});

test("deriveObjectiveTitle: degenerate inputs fall back", () => {
  assert.equal(deriveObjectiveTitle(""), "Untitled objective");
  assert.equal(deriveObjectiveTitle("   "), "Untitled objective");
  assert.equal(deriveObjectiveTitle("x"), "Untitled objective");
  assert.ok(deriveObjectiveTitle("the quick brown fox jumps over").length >= 3);
});

test("titleCase preserves acronyms and hyphenated compounds", () => {
  assert.equal(titleCase("build the hq ui and pr flow"), "Build The HQ UI And PR Flow");
  assert.equal(titleCase("dependency-free module"), "Dependency-free Module");
  assert.equal(titleCase("github pr checks"), "GitHub PR Checks");
});

test("shortPhrase trims a node contract outcome to a label", () => {
  const p = shortPhrase("Move decomposition and product work off the shared OpenAI seat and promote the fallback into a real path");
  assert.ok(p.split(" ").length <= 9);
  assert.match(p, /^Move decomposition/);
});

test("briefBlocker: infra 'could not start the CLI' reads as auto-recovering, never a founder ask", () => {
  const b = briefBlocker({
    stage: "builder", outcome: "decision-required",
    summary: "The builder for this task could not run (builder dispatch wrote no result file ... Reason: [openclaw] Could not start the CLI.). Retry the objective later.",
  });
  assert.equal(b.kind, "infra");
  assert.equal(b.autoRecovering, true);
  assert.ok(!b.needsFounder);
});

test("briefBlocker: release 'behind main' reads as a rebase, not a code failure", () => {
  const b = briefBlocker({
    stage: "release", outcome: "fail",
    summary: "NOT MERGE READY. All seven gates pass with independent evidence ... BLOCKING: PR #35 does not merge into main. merge-base is ff05e10 but origin/main advanced to 5af1be0 (#32); git merge-tree --write-tree origin/main HEAD exits 1 with CONFLICT (content) in factory/test/objective-orchestrator.test.mjs; gh reports mergeable=CONFLICTING",
  });
  assert.equal(b.kind, "rebase-needed");
  assert.match(b.headline, /rebase/i);
  assert.ok(b.raw.length > b.headline.length, "full text preserved for the drill-down");
});

test("briefBlocker: a real decision uses the parsed question", () => {
  const b = briefBlocker(
    { stage: "architect", outcome: "decision-required", summary: "long rationale text" },
    { decisionQuestion: "Store cost data in SQLite or JSON files?" },
  );
  assert.equal(b.kind, "decision");
  assert.equal(b.headline, "Store cost data in SQLite or JSON files?");
  assert.equal(b.needsFounder, true);
});

test("briefBlocker: a high-risk node blocked on the missing approval key is a founder ask, not a dead failure", () => {
  const b = briefBlocker({ stage: "init", outcome: "decision-required", founderAction: true, summary: "This objective was assessed high-risk ... FACTORY_FOUNDER_PUBLIC_KEY ..." });
  assert.equal(b.kind, "decision");
  assert.equal(b.needsFounder, true);
  assert.equal(b.headline, "This objective needs your approval before any work can start.");
  // Robust even if a catch-all forgot to set `outcome`.
  const b2 = briefBlocker({ summary: "High-risk task initialization requires the configured founder public key." });
  assert.equal(b2.needsFounder, true);
});

test("normalizeNodeStatus: a node blocked on the founder approval key → waiting for you", () => {
  const node = { status: "blocked", blocker: { outcome: "decision-required", founderAction: true, summary: "needs FACTORY_FOUNDER_PUBLIC_KEY" } };
  assert.equal(normalizeNodeStatus(node), STATUS.WAITING_FOR_FOUNDER);
});

test("presentObjective: a high-risk objective blocked at init shows WAITING_FOR_FOUNDER, not FAILED", () => {
  const p = presentObjective({
    objectiveId: "obj-dep", project: "openclaw-factory",
    objective: "Make deployment a first-class capability and fix LifeMax on Vercel.",
    status: "blocked",
    nodes: [
      { id: "obj-dep-a", role: "backend-builder", status: "blocked",
        blocker: { stage: "init", outcome: "decision-required", founderAction: true, summary: "needs FACTORY_FOUNDER_PUBLIC_KEY per SETUP.md" },
        contract: { outcome: "Implement the deployment contract and Vercel adapter" } },
      { id: "obj-dep-b", role: "frontend-builder", status: "blocked-by-dep", dependsOn: ["obj-dep-a"],
        contract: { outcome: "Add the deployment observability UI" } },
    ],
    integration: { id: "obj-dep-integration", role: "integration", status: "pending" },
  });
  assert.equal(p.status, STATUS.WAITING_FOR_FOUNDER);
  assert.equal(p.nextAction.kind, "resolve-decision");
  assert.match(p.headline, /approval/i);
});

test("normalizeNodeStatus maps every internal status to a founder word", () => {
  assert.equal(normalizeNodeStatus({ status: "gate-satisfied" }), STATUS.COMPLETE);
  assert.equal(normalizeNodeStatus({ status: "running" }), STATUS.RUNNING);
  assert.equal(normalizeNodeStatus({ status: "pending" }), STATUS.PENDING);
  assert.equal(normalizeNodeStatus({ status: "blocked-by-dep" }), STATUS.PENDING);
  assert.equal(normalizeNodeStatus({ status: "failed", blocker: { outcome: "fail", summary: "reviewer BLOCKING: real bug" } }), STATUS.FAILED);
  assert.equal(normalizeNodeStatus({ status: "blocked", blocker: { outcome: "decision-required", summary: "which option?" } }), STATUS.WAITING_FOR_FOUNDER);
  assert.equal(normalizeNodeStatus({ status: "failed", blocker: { outcome: "fail", summary: "Could not start the CLI" } }), STATUS.RECOVERING);
});

test("statusMeta gives a word + tone + icon for each status (colour is never the only signal)", () => {
  for (const s of Object.values(STATUS)) {
    const m = statusMeta(s);
    assert.ok(m.label && m.tone && m.icon, `${s} has label/tone/icon`);
  }
  assert.equal(statusMeta(STATUS.WAITING_FOR_FOUNDER).label, "Waiting for you");
});

test("isSeedProject flags demo/smoke fixtures", () => {
  assert.equal(isSeedProject("demo"), true);
  assert.equal(isSeedProject("lm-demo"), true);
  assert.equal(isSeedProject("hq-e2e-demo"), true);
  assert.equal(isSeedProject("openclaw-factory"), false);
  assert.equal(isSeedProject("lifemaxing"), false);
});

test("presentObjective: a blocked-on-rebase objective becomes FAILED with a Continue action and short title", () => {
  const obj = {
    objectiveId: "obj-test1", project: "openclaw-factory",
    objective: "Mission — make this software factory materially better at its job across many projects.",
    status: "blocked",
    nodes: [
      { id: "obj-test1-a", role: "backend-builder", status: "failed", elapsedMs: 1000,
        blocker: { stage: "release", outcome: "fail", summary: "NOT MERGE READY ... origin/main advanced to 5af1be0 ... mergeable=CONFLICTING" },
        contract: { outcome: "Move product work off the shared OpenAI seat" } },
      { id: "obj-test1-b", role: "frontend-builder", status: "blocked",
        blocker: { stage: "builder", outcome: "decision-required", summary: "builder could not run ... Could not start the CLI" },
        contract: { outcome: "Add a one-click recovery action" } },
    ],
    integration: { id: "obj-test1-integration", role: "integration", status: "pending" },
    prUrl: null, hasReport: true,
  };
  const p = presentObjective(obj);
  assert.equal(p.title, "Make Software Factory Materially Better");
  assert.equal(p.status, STATUS.FAILED); // one hard node failure; the other is infra (auto-recovering)
  assert.equal(p.progress.total, 3);
  assert.equal(p.progress.done, 0);
  assert.equal(p.nextAction.kind, "continue-objective");
  assert.equal(p.blockerBrief.kind, "rebase-needed");
  assert.equal(p.isSeed, false);
  assert.equal(p.nodeStatuses.length, 3);
  assert.equal(p.nodeStatuses[1].status, STATUS.RECOVERING, "infra node shows as recovering, not waiting");
});

test("presentObjective: an active objective with only an infra failure is recovering, not running", () => {
  const p = presentObjective({
    objectiveId: "obj-recovering", project: "app", objective: "Build the API", status: "active",
    nodes: [{ id: "obj-recovering-a", role: "backend-builder", status: "blocked",
      blocker: { outcome: "fail", summary: "Could not start the CLI" } }],
    integration: { id: "obj-recovering-integration", role: "integration", status: "pending" },
  });
  assert.equal(p.status, STATUS.RECOVERING);
  assert.equal(p.progress.running, 0);
  assert.match(p.headline, /recovering automatically/);
});

test("presentObjective: a complete objective with a PR offers Open PR", () => {
  const p = presentObjective({
    objectiveId: "obj-ok", project: "demo",
    objective: "Add two dependency-free ES modules with node:test tests",
    status: "complete",
    nodes: [{ id: "obj-ok-a", role: "backend-builder", status: "gate-satisfied" }],
    integration: { id: "obj-ok-integration", status: "gate-satisfied" },
    prUrl: "https://github.com/x/y/pull/1",
  });
  assert.equal(p.status, STATUS.COMPLETE);
  assert.equal(p.progress.label, "all parts done");
  assert.equal(p.nextAction.kind, "open-pr");
  assert.equal(p.isSeed, true);
});

test("roleLabel / stageVerb are human", () => {
  assert.equal(roleLabel("backend-builder"), "Backend Builder");
  assert.equal(roleLabel("qa"), "QA");
  assert.match(stageVerb("reviewer"), /review/i);
  assert.match(stageVerb("builder"), /code/i);
});
