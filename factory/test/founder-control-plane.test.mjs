import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildFounderOverview, discoverFactoryTasks, listFounderJobs, resolveFounderDecision, saveFounderJob, setProjectPaused } from "../../dashboard/backend/lib/founderControlPlane.mjs";
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
