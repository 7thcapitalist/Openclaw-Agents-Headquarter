import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildFounderOverview,
  buildObjectivesView,
  buildRecoveryPlan,
  discoverFactoryTasks,
  findObjectiveStatePath,
  listArchivedObjectives,
  listFounderJobs,
  objectiveLifecycle,
  resolveFounderDecision,
  saveFounderJob,
  setObjectiveArchived,
  setProjectPaused,
} from "../../dashboard/backend/lib/founderControlPlane.mjs";
import { createState, writeState } from "../lib/task-workflow.mjs";

function registerIntelligence(root, { key = "startup-ops", risks, openDecisions } = {}) {
  const repo = join(root, "repo");
  mkdirSync(join(root, "factory", "prompts"), { recursive: true });
  mkdirSync(join(root, "factory", "context"), { recursive: true });
  writeFileSync(join(root, "factory", "projects.json"), JSON.stringify({
    version: 1, projects: [{ key, name: "Startup Ops", repo, contextDir: "context" }],
  }));
  writeFileSync(join(root, "factory", "factory.config.json"), JSON.stringify({
    version: 1, mode: "human-merge", prohibitedAutonomousActions: ["push-to-main"], requiredGates: ["independent-review"],
  }));
  writeFileSync(join(root, "factory", "context", "FACTORY.md"), "# Factory context\n\nOperator-controlled software factory.\n");
  for (const stage of ["product", "architect", "builder", "reviewer", "qa", "security", "release"]) {
    writeFileSync(join(root, "factory", "prompts", `${stage}.md`), `# ${stage}\n\nDo the ${stage} work.\n`);
  }
  const ctx = join(repo, "context");
  mkdirSync(ctx, { recursive: true });
  writeFileSync(join(ctx, "PROJECT.md"), "# Startup Ops\n\nRuns the company.\n");
  writeFileSync(join(ctx, "VISION.md"), "# Vision\n\nAutonomous company OS.\n");
  writeFileSync(join(ctx, "MISSION.md"), "# Mission\n\nShip the founder dashboard.\n");
  writeFileSync(join(ctx, "ROADMAP.md"), "# Roadmap\n\n## Current milestone\n\nFounder dashboard. Blocker: none.\n\n## Next\n\n- Digest\n");
  writeFileSync(join(ctx, "DECISIONS.md"), "# Decisions\n\n## SO-2026-001 — Human merge\n\n- Status: Accepted\n- Decision: Founder merges.\n");
  writeFileSync(join(ctx, "MEMORY.md"), "# Project memory\n\n- The control plane is a projection, not a workflow engine.\n");
  writeFileSync(join(ctx, "TECH_CONTEXT.md"), "# Tech context\n\n## Constraints\n\n- Node builtins only.\n");
  writeFileSync(join(ctx, "USERS.md"), "# Users\n\nThe founder-operator.\n\n## Sensitivities\n\nOperator control is non-negotiable.\n");
  writeFileSync(join(ctx, "COMPETITIVE_CONTEXT.md"), "# Competitive context\n\n## Our wedge\n\nGates plus context.\n");
  writeFileSync(join(ctx, "ownership.json"), JSON.stringify({
    version: 1,
    mission: "Give the founder a company view, not a job monitor.",
    successMetrics: [{ id: "m1", name: "Decisions surfaced before block", target: "yes", current: "no", asOf: "2026-09-03" }],
    currentPriorities: [{ id: "p1", title: "Intelligence integration" }],
    risks: risks || [{ id: "r1", title: "Overview endpoint breaks on bad context", severity: "high", mitigation: "", owner: "" }],
    openDecisions: openDecisions || [],
    responsibleAgents: { architect: "claude" },
  }));
  return repo;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "founder-plane-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  mkdirSync(repo); mkdirSync(worktree);
  const state = createState({
    task: { id: "task-demo", issue: "local:demo", outcome: "Ship a founder dashboard", acceptanceCriteria: ["Dashboard works"], project: "startup-ops", workType: "ui", risk: "low" },
    repo, branch: "factory/task-demo", worktree,
  });
  const statePath = join(root, "dashboard/backend/data/factory/repo/tasks/task-demo/state.json");
  writeState(statePath, state);
  return { root, statePath };
}

test("discovers factory state and builds founder project status", () => {
  const { root } = fixture();
  const tasks = discoverFactoryTasks(root);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].stage, "product");
  assert.equal(tasks[0].agent, "openclaw");
  const overview = buildFounderOverview(root, [{ id: "startup-ops", name: "Startup Ops", status: "active" }]);
  assert.equal(overview.projects[0].taskCount, 1);
  assert.equal(overview.projects[0].stage, "product");
});

test("persists project pause independently of task lifecycle", () => {
  const { root } = fixture();
  setProjectPaused(root, "startup-ops", true);
  const overview = buildFounderOverview(root, [{ id: "startup-ops", name: "Startup Ops", status: "active" }]);
  assert.equal(overview.projects[0].status, "paused");
  const control = JSON.parse(readFileSync(join(root, "dashboard/backend/data/factory/control-plane.json"), "utf8"));
  assert.equal(control.projects["startup-ops"].status, "paused");
});

test("persists launch jobs across control-plane reads", () => {
  const { root } = fixture();
  saveFounderJob(root, { id: "job-1", projectId: "startup-ops", objective: "Ship it", status: "starting", createdAt: "2026-09-03T10:00:00.000Z" });
  saveFounderJob(root, { id: "job-1", projectId: "startup-ops", objective: "Ship it", status: "merge-ready", createdAt: "2026-09-03T10:00:00.000Z" });
  assert.equal(listFounderJobs(root).length, 1);
  assert.equal(listFounderJobs(root)[0].status, "merge-ready");
});

test("reads the repository Decision Card format into the founder inbox", () => {
  const { root, statePath } = fixture();
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  mkdirSync(join(state.worktree, "evidence"), { recursive: true });
  writeFileSync(join(state.worktree, "evidence/decision.md"), `# Decision Required

## Decision
Choose the storage model.

## Why this needs the founder
It changes the privacy promise.

## Option A
- Benefit: Local only
- Cost/risk: More engineering

## Option B
- Benefit: Faster
- Cost/risk: Third-party storage

## Recommendation
Choose A to minimize privacy risk.
`);
  state.status = "blocked";
  state.blocker = { stage: "product", outcome: "decision-required", summary: "Storage decision", actor: "openclaw", at: "2026-09-03T10:00:00.000Z" };
  state.stages.product = { status: "decision-required", evidence: [{ path: "evidence/decision.md" }] };
  writeState(statePath, state);
  const [decision] = buildFounderOverview(root, [{ id: "startup-ops", name: "Startup Ops" }]).decisions;
  assert.equal(decision.question, "Choose the storage model.");
  assert.equal(decision.options.length, 2);
  assert.match(decision.recommendation, /Choose A/);
});

test("overview enriches a registered project with its intelligence brief and health", () => {
  const { root } = fixture();
  registerIntelligence(root);
  const overview = buildFounderOverview(root, [{ id: "startup-ops", name: "Startup Ops", status: "active" }]);
  const project = overview.projects.find((p) => p.id === "startup-ops");

  assert.ok(project.intelligence, "project should carry an intelligence brief");
  assert.equal(project.intelligence.mission, "Give the founder a company view, not a job monitor.");
  assert.match(project.intelligence.roadmap.current, /Founder dashboard/);
  assert.equal(project.intelligence.decisions[0].id, "SO-2026-001");
  assert.ok(project.health, "project should carry a health score");
  assert.equal(typeof project.health.score, "number");

  assert.ok(overview.company, "overview exposes a company view");
  assert.ok(Array.isArray(overview.company.recommendedActions));
  assert.ok(overview.company.risks.some((r) => r.project === "startup-ops" && r.unmitigated));
  assert.ok(overview.company.opportunities.some((o) => o.project === "startup-ops"));
});

test("an unmitigated high risk plus an open strategic decision produces recommended actions", () => {
  const { root } = fixture();
  registerIntelligence(root, {
    risks: [{ id: "r1", title: "No rollback plan for the migration", severity: "high", mitigation: "", owner: "" }],
    openDecisions: ["SO-2026-042"],
  });
  const overview = buildFounderOverview(root, [{ id: "startup-ops", name: "Startup Ops" }]);
  const actions = overview.company.recommendedActions;
  assert.ok(actions.some((a) => a.kind === "risk" && /rollback plan/.test(a.action)));
  assert.ok(overview.openDecisions.some((d) => d.kind === "strategic" && d.id === "SO-2026-042"));
});

test("overview still works when no intelligence layer is registered", () => {
  const { root } = fixture();
  const overview = buildFounderOverview(root, [{ id: "startup-ops", name: "Startup Ops" }]);
  const project = overview.projects.find((p) => p.id === "startup-ops");
  assert.equal(project.intelligence, null);
  assert.ok("health" in project);
  assert.ok(overview.company);
  assert.deepEqual(overview.company.risks, []);
});

test("resolving a founder decision writes a handoff that carries project context", () => {
  const { root, statePath } = fixture();
  registerIntelligence(root);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  mkdirSync(join(state.worktree, "context"), { recursive: true });
  writeFileSync(join(state.worktree, "context", "ownership.json"), JSON.stringify({ version: 1, mission: "Worktree mission copy." }));
  mkdirSync(join(state.worktree, "evidence"), { recursive: true });
  writeFileSync(join(state.worktree, "evidence/decision.md"), "# Decision Required\n\n## Decision\nProceed?\n");
  state.status = "blocked";
  state.blocker = { stage: "product", outcome: "decision-required", summary: "Proceed?", actor: "openclaw", at: "2026-09-03T10:00:00.000Z" };
  state.stages.product = { status: "decision-required", evidence: [{ path: "evidence/decision.md" }] };
  writeState(statePath, state);

  resolveFounderDecision({ root, hqRoot: root, statePath, direction: "Yes, proceed." });
  const handoff = readFileSync(join(statePath, "..", "handoff-product.md"), "utf8");
  assert.match(handoff, /## Factory context \(global\)/);
  assert.match(handoff, /## Project context: Startup Ops/);
  assert.match(handoff, /Worktree mission copy\./);
});

test("founder inbox: a decision-required blocker is a 'decision' item and clears when resolved", () => {
  const { root, statePath } = fixture();
  registerIntelligence(root);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  mkdirSync(join(state.worktree, "evidence"), { recursive: true });
  writeFileSync(join(state.worktree, "evidence/decision.md"), "# Decision Required\n\n## Decision\nWhich storage engine?\n");
  state.status = "blocked";
  state.blocker = { stage: "product", outcome: "decision-required", summary: "Which storage engine?", actor: "openclaw", at: "2026-09-05T10:00:00.000Z" };
  state.stages.product = { status: "decision-required", evidence: [{ path: "evidence/decision.md" }] };
  writeState(statePath, state);

  const before = buildFounderOverview(root, [{ id: "startup-ops", name: "Startup Ops" }]);
  assert.equal(before.inbox.length, 1);
  assert.equal(before.inbox[0].kind, "decision");
  assert.equal(before.inbox[0].taskId, "task-demo");
  assert.equal(before.inbox[0].action, "respond-and-resume");

  resolveFounderDecision({ root, hqRoot: root, statePath, direction: "Use SQLite." });
  const after = buildFounderOverview(root, [{ id: "startup-ops", name: "Startup Ops" }]);
  assert.equal(after.inbox.length, 0, "resolved decision leaves the inbox");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).status, "active", "task resumed");
});

test("founder inbox: a terminally failed task is a 'blocked' item, not a decision", () => {
  const { root, statePath } = fixture();
  registerIntelligence(root);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.status = "blocked";
  state.currentStage = "qa";
  state.blocker = { stage: "qa", outcome: "fail", summary: "acceptance criterion 2 cannot pass", actor: "qa", at: "2026-09-05T12:00:00.000Z" };
  state.dispatches = [
    { stage: "qa", status: "failed" }, { stage: "qa", status: "failed" }, { stage: "qa", status: "failed" },
  ];
  writeState(statePath, state);

  const overview = buildFounderOverview(root, [{ id: "startup-ops", name: "Startup Ops" }]);
  assert.equal(overview.inbox.length, 1);
  assert.equal(overview.inbox[0].kind, "blocked");
  assert.equal(overview.inbox[0].action, "review-blocked-task");
  assert.match(overview.inbox[0].title, /qa failed/);
  assert.equal(overview.decisions.length, 0, "a fail is not a decision");
});

test("task view carries derived elapsed / last-handoff / last-result", () => {
  const { root, statePath } = fixture();
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.createdAt = "2026-09-05T09:00:00.000Z";
  state.events = [
    { at: "2026-09-05T09:00:00.000Z", type: "task-created", stage: "product" },
    { at: "2026-09-05T09:30:00.000Z", type: "stage-pass", stage: "product", actor: "openclaw" },
    { at: "2026-09-05T09:31:00.000Z", type: "handoff-ready", stage: "architect" },
  ];
  state.stages.product = { status: "pass", actor: "openclaw", summary: "outcome normalized", evidence: [{ path: "e.md" }] };
  writeState(statePath, state);

  const [task] = discoverFactoryTasks(root);
  assert.ok(task.elapsedMs >= 30 * 60 * 1000, "at least the 31 minutes of recorded events");
  assert.deepEqual(task.lastHandoff, { stage: "architect", at: "2026-09-05T09:31:00.000Z" });
  assert.equal(task.lastResult.stage, "product");
  assert.equal(task.lastResult.outcome, "pass");
  assert.equal(task.lastResult.summary, "outcome normalized");
});

test("buildObjectivesView: infra recovery vs founder decision on mixed blockers", () => {
  const root = mkdtempSync(join(tmpdir(), "founder-obj-view-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const objectiveId = "obj-aabbccdd-mixed";
  const idA = `${objectiveId}-auth-api`;
  const idB = `${objectiveId}-storage-pick`;

  const infra = {
    stage: "builder", outcome: "decision-required", infra: true,
    summary: "The builder for this task could not run (rate_limit). Retry the objective later, or adjust model routing for that role.",
  };
  const decision = {
    stage: "architect", outcome: "decision-required",
    summary: "Choose Postgres or SQLite",
  };

  for (const [id, blocker, outcome] of [
    [idA, infra, "Ship auth API"],
    [idB, decision, "Pick storage"],
  ]) {
    const wt = join(root, "wt", id);
    mkdirSync(wt, { recursive: true });
    const st = createState({
      task: { id, issue: `local:${id}`, outcome, acceptanceCriteria: ["x"], project: "app", workType: "backend", risk: "low" },
      repo, branch: `factory/${id}`, worktree: wt,
    });
    st.status = "blocked";
    st.blocker = blocker.infra ? { ...blocker, outcome: "fail" } : blocker;
    st.currentStage = blocker.stage;
    writeState(join(root, "dashboard/backend/data/factory/app/tasks", id, "state.json"), st);
  }

  const obj = {
    version: 1, objectiveId, objective: "Mixed blockers", project: "app", repo,
    status: "blocked", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: {
      [idA]: {
        id: idA, role: "backend-builder", status: "blocked", dependsOn: [],
        contract: { outcome: "Ship auth API" }, blocker: infra,
        statePath: join(root, "dashboard/backend/data/factory/app/tasks", idA, "state.json"),
      },
      [idB]: {
        id: idB, role: "frontend-builder", status: "blocked", dependsOn: [],
        contract: { outcome: "Pick storage" }, blocker: decision,
        statePath: join(root, "dashboard/backend/data/factory/app/tasks", idB, "state.json"),
      },
    },
    integration: { id: `${objectiveId}-integration`, role: "integration", status: "pending", dependsOn: [idA, idB] },
    events: [],
  };
  const objDir = join(root, "dashboard/backend/data/factory/app/objectives", objectiveId);
  mkdirSync(objDir, { recursive: true });
  writeFileSync(join(objDir, "objective-state.json"), `${JSON.stringify(obj, null, 2)}\n`);

  const plan = buildRecoveryPlan(obj);
  assert.equal(plan.nodes.length, 1);
  assert.equal(plan.nodes[0].role, "backend-builder");
  assert.equal(plan.nodes[0].title, "Ship auth API");

  const view = buildObjectivesView(root);
  const shaped = view.objectives.find((o) => o.objectiveId === objectiveId);
  assert.ok(shaped);
  assert.equal(shaped.recovery.count, 1);
  assert.equal(shaped.recovery.nodes[0].role, "backend-builder");
  assert.equal(shaped.recovery.nodes[0].title, "Ship auth API");
  assert.equal(shaped.recovery.nodes[0].id, undefined);
  assert.ok(!JSON.stringify(shaped.recovery.nodes).includes(idA));
  assert.equal(shaped.blockedOn, idB);
  assert.equal(view.summary.needsFounder, 1);

  assert.equal(findObjectiveStatePath(root, "../etc/passwd"), null);
  assert.equal(findObjectiveStatePath(root, "not-an-obj"), null);
  assert.equal(findObjectiveStatePath(root, "obj-missing-zzzz"), null);
  assert.ok(findObjectiveStatePath(root, objectiveId)?.endsWith("objective-state.json"));
});

test("a high-risk objective blocked at init (no task file) reaches the Founder Inbox as an approval item", () => {
  const root = mkdtempSync(join(tmpdir(), "founder-inbox-obj-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const objectiveId = "obj-deadbeef-deploy";
  const nodeId = `${objectiveId}-capability`;

  const obj = {
    version: 1, objectiveId, objective: "Make deployment a first-class capability and fix LifeMax on Vercel.",
    project: "startup-ops", repo, status: "blocked",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: {
      [nodeId]: {
        id: nodeId, role: "backend-builder", status: "blocked", dependsOn: [],
        contract: { outcome: "Implement the deployment contract and Vercel adapter", risk: "high" },
        statePath: null, branch: `factory/${nodeId}`,
        blocker: {
          stage: "init", outcome: "decision-required", founderAction: true,
          summary: "This objective was assessed high-risk ... Set FACTORY_FOUNDER_PUBLIC_KEY (see docs/software-factory/SETUP.md) ...",
          at: new Date().toISOString(),
        },
      },
      [`${objectiveId}-ui`]: {
        id: `${objectiveId}-ui`, role: "frontend-builder", status: "blocked-by-dep", dependsOn: [nodeId],
        contract: { outcome: "Add the deployment observability UI" }, statePath: null, blocker: null,
      },
    },
    integration: { id: `${objectiveId}-integration`, role: "integration", status: "pending", dependsOn: [nodeId] },
    events: [],
  };
  const objDir = join(root, "dashboard/backend/data/factory/repo/objectives", objectiveId);
  mkdirSync(objDir, { recursive: true });
  writeFileSync(join(objDir, "objective-state.json"), `${JSON.stringify(obj, null, 2)}\n`);

  const overview = buildFounderOverview(root, [{ id: "startup-ops", name: "Startup Ops", status: "active" }]);
  const item = overview.inbox.find((i) => i.id === `${objectiveId}:${nodeId}`);
  assert.ok(item, "the blocked high-risk objective node is in the inbox");
  assert.equal(item.kind, "approval");
  assert.equal(item.objectiveId, objectiveId);
  assert.match(item.recommendation, /FACTORY_FOUNDER_PUBLIC_KEY/);
  // It should also be the first item (approvals rank ahead of everything).
  assert.equal(overview.inbox[0].id, item.id);
});

test("buildRecoveryPlan / buildObjectivesView: only hard/decision → recovery.count===0", () => {
  const root = mkdtempSync(join(tmpdir(), "founder-obj-empty-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const objectiveId = "obj-aabbccdd-empty";
  const idB = `${objectiveId}-decide`;
  const idC = `${objectiveId}-hard`;

  const decision = { outcome: "decision-required", summary: "Choose Postgres or SQLite", stage: "architect" };
  const hard = { outcome: "fail", summary: "QA: 3 tests fail", stage: "qa" };

  for (const [id, blocker, outcome] of [
    [idB, decision, "Pick storage"],
    [idC, hard, "Fix tests"],
  ]) {
    const wt = join(root, "wt", id);
    mkdirSync(wt, { recursive: true });
    const st = createState({
      task: { id, issue: `local:${id}`, outcome, acceptanceCriteria: ["x"], project: "app", workType: "backend", risk: "low" },
      repo, branch: `factory/${id}`, worktree: wt,
    });
    st.status = "blocked";
    st.blocker = blocker.infra ? { ...blocker, outcome: "fail" } : blocker;
    st.currentStage = blocker.stage;
    writeState(join(root, "dashboard/backend/data/factory/app/tasks", id, "state.json"), st);
  }

  const obj = {
    version: 1, objectiveId, objective: "No recovery", project: "app", repo,
    status: "blocked", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    nodes: {
      [idB]: {
        id: idB, role: "architect", status: "blocked", dependsOn: [],
        contract: { outcome: "Pick storage" }, blocker: decision,
        statePath: join(root, "dashboard/backend/data/factory/app/tasks", idB, "state.json"),
      },
      [idC]: {
        id: idC, role: "backend-builder", status: "failed", dependsOn: [],
        contract: { outcome: "Fix tests" }, blocker: hard,
        statePath: join(root, "dashboard/backend/data/factory/app/tasks", idC, "state.json"),
      },
    },
    integration: { id: `${objectiveId}-integration`, role: "integration", status: "pending" },
    events: [],
  };
  const objDir = join(root, "dashboard/backend/data/factory/app/objectives", objectiveId);
  mkdirSync(objDir, { recursive: true });
  writeFileSync(join(objDir, "objective-state.json"), `${JSON.stringify(obj, null, 2)}\n`);

  assert.equal(buildRecoveryPlan(obj).nodes.length, 0);
  const view = buildObjectivesView(root);
  const shaped = view.objectives.find((o) => o.objectiveId === objectiveId);
  assert.ok(shaped);
  assert.equal(shaped.recovery.count, 0);
});

// ── objective lifecycle bucketing + founder archive ─────────────────────────

function writeObjectiveFixture(root, {
  objectiveId = "obj-12345678",
  project = "app",
  objective = "Add a dependency-free health endpoint with tests so ops can watch uptime",
  status = "active",
  status6Hint = "running", // node status that drives the presenter status
  updatedAt = "2026-09-08T11:30:00.000Z",
} = {}) {
  const dir = join(root, "dashboard/backend/data/factory", project, "objectives", objectiveId);
  mkdirSync(dir, { recursive: true });
  const obj = {
    version: 1, objectiveId, objective, project, repo: join(root, "repo"),
    status, createdAt: "2026-09-08T00:00:00.000Z", updatedAt,
    nodes: {
      [`${objectiveId}-a`]: {
        id: `${objectiveId}-a`, role: "backend-builder", status: status6Hint,
        dependsOn: [], contract: { outcome: "Build the endpoint" },
      },
    },
    integration: { id: `${objectiveId}-integration`, role: "integration", status: "pending" },
    events: [],
  };
  const path = join(dir, "objective-state.json");
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
  return { dir, path };
}

test("objectiveLifecycle: presenter status + freshness + archive decide the bucket", () => {
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const fresh = "2026-09-08T11:00:00.000Z";
  const old = "2026-09-01T00:00:00.000Z";

  // Open founder attention stays active regardless of age.
  assert.equal(objectiveLifecycle({ status6: "WAITING_FOR_FOUNDER", updatedAt: old }, { now }), "active");
  assert.equal(objectiveLifecycle({ status6: "BLOCKED", updatedAt: old }, { now }), "active");

  // Running/pending: active only while fresh, or while a recovery is pending.
  assert.equal(objectiveLifecycle({ status6: "RUNNING", updatedAt: fresh }, { now }), "active");
  assert.equal(objectiveLifecycle({ status6: "RUNNING", updatedAt: old }, { now }), "history");
  assert.equal(objectiveLifecycle({ status6: "RUNNING", updatedAt: old, recovery: { count: 2 } }, { now }), "active");
  assert.equal(objectiveLifecycle({ status6: "FAILED", updatedAt: old }, { now }), "history");

  // Completed: active only if recent.
  assert.equal(objectiveLifecycle({ status6: "COMPLETE", updatedAt: fresh }, { now }), "active");
  assert.equal(objectiveLifecycle({ status6: "COMPLETE", updatedAt: old }, { now }), "history");

  // Founder archive always wins.
  assert.equal(objectiveLifecycle({ status6: "WAITING_FOR_FOUNDER", updatedAt: fresh }, { now, archived: true }), "archived");
});

test("archiving an objective is presentation-only, reflected in the view, and reversible", () => {
  const root = mkdtempSync(join(tmpdir(), "founder-archive-"));
  mkdirSync(join(root, "repo"), { recursive: true });
  const { path } = writeObjectiveFixture(root, { objectiveId: "obj-aa11bb22", updatedAt: "2026-09-08T11:30:00.000Z" });
  const stateBefore = readFileSync(path, "utf8");
  const now = Date.parse("2026-09-08T12:00:00.000Z");

  let view = buildObjectivesView(root, { now });
  let shaped = view.objectives.find((o) => o.objectiveId === "obj-aa11bb22");
  assert.equal(shaped.archived, false);
  assert.equal(shaped.lifecycle, "active");
  assert.equal(view.summary.active, 1);
  assert.equal(view.summary.archived, 0);

  const res = setObjectiveArchived(root, "obj-aa11bb22", true, { reason: "shipped another way" });
  assert.equal(res.archived, true);
  assert.ok(res.archivedAt);
  assert.ok(listArchivedObjectives(root)["obj-aa11bb22"]);
  // The objective's own state file is byte-for-byte untouched.
  assert.equal(readFileSync(path, "utf8"), stateBefore);

  view = buildObjectivesView(root, { now });
  shaped = view.objectives.find((o) => o.objectiveId === "obj-aa11bb22");
  assert.equal(shaped.archived, true);
  assert.equal(shaped.archivedAt, res.archivedAt);
  assert.equal(shaped.lifecycle, "archived");
  assert.equal(view.summary.archived, 1);
  assert.equal(view.summary.active, 0);

  setObjectiveArchived(root, "obj-aa11bb22", false);
  assert.equal(listArchivedObjectives(root)["obj-aa11bb22"], undefined);
  assert.equal(readFileSync(path, "utf8"), stateBefore);
  view = buildObjectivesView(root, { now });
  assert.equal(view.objectives.find((o) => o.objectiveId === "obj-aa11bb22").lifecycle, "active");
});

test("an old untouched objective drops to history without being archived", () => {
  const root = mkdtempSync(join(tmpdir(), "founder-history-"));
  mkdirSync(join(root, "repo"), { recursive: true });
  writeObjectiveFixture(root, { objectiveId: "obj-99887766", updatedAt: "2026-09-01T00:00:00.000Z" });
  const view = buildObjectivesView(root, { now: Date.parse("2026-09-08T12:00:00.000Z") });
  const shaped = view.objectives.find((o) => o.objectiveId === "obj-99887766");
  assert.equal(shaped.archived, false);
  assert.equal(shaped.lifecycle, "history");
  assert.equal(view.summary.history, 1);
});
