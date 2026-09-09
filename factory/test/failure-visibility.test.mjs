// Guardrail against the failure that prompted this work: a founder request that
// dies in a detached promise and leaves no trace in any founder-facing view.
//
// Every entry path is driven with a stub executor forced into each realistic
// failure, and asserted to produce a classified outcome AND an entry in the feed
// the founder actually reads. If someone later reintroduces a bare
// `catch { saveFounderJob(..., status: "error" }`, these tests fail.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildFounderOverview, finishFounderJob, listFounderJobs, saveFounderJob,
} from "../../dashboard/backend/lib/founderControlPlane.mjs";
import { createState, writeState } from "../lib/task-workflow.mjs";
import { decomposeObjective } from "../lib/objective/decompose.mjs";
import { createContractFromObjective } from "../lib/natural-language-intake.mjs";

const PROJECTS = [{ id: "startup-ops", name: "Startup Ops", status: "active" }];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "failure-visibility-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "projects.json"), JSON.stringify({
    version: 1, projects: [{ key: "startup-ops", name: "Startup Ops", repo }],
  }));
  return { root, repo };
}

function newJob(overrides = {}) {
  return {
    id: "founder-abc", kind: "objective", projectId: "startup-ops",
    objective: "Add a nightly digest email for the founder",
    status: "decomposing", createdAt: "2026-09-09T01:00:00.000Z",
    updatedAt: "2026-09-09T01:00:00.000Z", ...overrides,
  };
}

// The three realistic ways an entry path dies, as they actually arrive.
const RATE_LIMIT = Object.assign(
  new Error("Command failed: openclaw agent --agent main --message <prompt> --json --timeout 900"),
  { stderr: "usage limit reached for this auth profile; resets in 2h 26m", transient: true },
);
const INVALID_JSON = new Error("decomposition returned invalid JSON: Unexpected token } in JSON at position 412");
const GIT_ERROR = Object.assign(new Error("Command failed: git worktree add"), {
  stderr: "fatal: 'factory/task-x' is already checked out at '/home/x/.openclaw-worktrees/y'",
});

test("a rate-limited run pauses with a resume time and never pages the founder", () => {
  const { root } = fixture();
  finishFounderJob(root, newJob(), {
    error: RATE_LIMIT,
    whatFailed: "Planning your objective",
    resumeAfter: "2026-09-09T04:21:00.000Z",
  });

  const [job] = listFounderJobs(root);
  assert.equal(job.outcome.outcomeClass, "paused-credits");
  assert.equal(job.status, "paused", "a paused job must not read as broken");
  assert.equal(job.outcome.resumeAfter, "2026-09-09T04:21:00.000Z");

  const overview = buildFounderOverview(root, PROJECTS);
  assert.equal(overview.inbox.length, 0, "infrastructure never reaches the Founder Inbox");
  const recovering = overview.autoRecovering.find((r) => r.objective === job.objective);
  assert.ok(recovering, "but it IS visible as work the system is carrying");
  assert.equal(recovering.resumeAfter, "2026-09-09T04:21:00.000Z");
  assert.match(recovering.detail, /resumes automatically/i);
});

test("a garbage model response is a hard failure the founder can see", () => {
  const { root } = fixture();
  finishFounderJob(root, newJob(), { error: INVALID_JSON, whatFailed: "Planning your objective" });

  const overview = buildFounderOverview(root, PROJECTS);
  assert.equal(overview.inbox.length, 1);
  const [item] = overview.inbox;
  assert.equal(item.outcome.outcomeClass, "hard-failed");
  assert.equal(item.id, "job:founder-abc");
  assert.ok(item.title.length > 20, "the inbox row leads with a plain sentence");
  assert.match(item.title, /could not recover/i);
  assert.match(item.detail, /invalid JSON/);
  assert.ok(item.recommendation, "and tells the founder what to do about it");
});

test("a git failure is surfaced, not swallowed", () => {
  const { root } = fixture();
  finishFounderJob(root, newJob({ kind: "task" }), { error: GIT_ERROR, whatFailed: "Your request" });

  const overview = buildFounderOverview(root, PROJECTS);
  assert.equal(overview.inbox.length, 1);
  assert.match(overview.inbox[0].detail, /already checked out/);
});

test("the founder-visible record never contains the dispatched prompt", () => {
  const { root } = fixture();
  const secretish = "Founder objective:\nRewrite billing using the key sk-livedeadbeefdeadbeefdeadbeef01";
  finishFounderJob(root, newJob(), {
    error: Object.assign(
      new Error(`Command failed: openclaw agent --agent main --session-key agent:main:x --message ${secretish} --json --timeout 900`),
      { stderr: "" },
    ),
    whatFailed: "Planning your objective",
  });
  const [job] = listFounderJobs(root);
  assert.doesNotMatch(job.outcome.detail, /Rewrite billing/);
  assert.doesNotMatch(job.outcome.detail, /sk-live/);
  assert.match(job.outcome.detail, /openclaw agent --agent main failed/);
});

test("a delivered run is recorded as complete, not as a failure", () => {
  const { root } = fixture();
  finishFounderJob(root, newJob(), { result: { status: "merge-ready" }, whatFailed: "Your objective" });
  const [job] = listFounderJobs(root);
  assert.equal(job.outcome.outcomeClass, "merge-ready");
  assert.equal(job.status, "complete");
  assert.equal(job.outcome.needsFounder, false);
  assert.equal(buildFounderOverview(root, PROJECTS).inbox.length, 0);
});

test("a job is not reported twice when its task already speaks for itself", () => {
  const { root, repo } = fixture();
  const state = createState({
    task: {
      id: "task-demo", issue: "local:demo", outcome: "Ship the digest",
      acceptanceCriteria: ["It sends"], project: "startup-ops", workType: "backend", risk: "low",
    },
    repo, branch: "factory/task-demo", worktree: join(root, "worktree"),
  });
  state.status = "blocked";
  state.blocker = { stage: "qa", outcome: "fail", summary: "QA: 2 acceptance criteria unmet", at: "2026-09-09T02:00:00.000Z" };
  writeState(join(root, "dashboard/backend/data/factory/repo/tasks/task-demo/state.json"), state);

  finishFounderJob(root, newJob({ kind: "task", taskId: "task-demo" }), {
    error: new Error("pipeline stopped"), whatFailed: "Your request",
  });

  const overview = buildFounderOverview(root, PROJECTS);
  const rows = overview.inbox.filter((i) => i.taskId === "task-demo");
  assert.equal(rows.length, 1, "the richer task-level row wins; the job row is deduped away");
  assert.notEqual(rows[0].id, "job:founder-abc");
});

test("an unclassified legacy job cannot silently occupy the inbox", () => {
  const { root } = fixture();
  // Exactly the pre-existing shape: a raw string, no typed outcome.
  saveFounderJob(root, newJob({ status: "error", error: "Command failed: openclaw agent" }));
  const overview = buildFounderOverview(root, PROJECTS);
  assert.equal(overview.inbox.length, 0, "no typed outcome means no row — and no crash");
});

// ── the real entry paths, with a stubbed model call ───────────────────────────

test("decomposition failure produces a classified outcome, not a dead job", async () => {
  const { root, repo } = fixture();
  for (const [error, expected] of [[RATE_LIMIT, "paused-credits"], [INVALID_JSON, "hard-failed"]]) {
    const failure = await decomposeObjective({
      hqRoot: root, objective: "Add a digest", project: "startup-ops", repo,
      execute: async () => { throw error; },
    }).then(() => null, (e) => e);
    assert.ok(failure, "decomposition must reject, not resolve silently");

    const job = finishFounderJob(root, newJob({ id: `job-${expected}` }), {
      error: failure, whatFailed: "Planning your objective",
    });
    assert.equal(job.outcome.outcomeClass, expected);
    assert.ok(job.outcome.headline.length > 20);
  }
});

test("intake failure produces a classified outcome, not a dead job", async () => {
  const { root, repo } = fixture();
  const failure = await createContractFromObjective({
    objective: "Add a digest", repo, project: "startup-ops",
    stateRoot: join(root, "state"), hqRoot: root,
    execute: async () => { throw RATE_LIMIT; },
  }).then(() => null, (e) => e);
  assert.ok(failure, "intake must reject, not resolve silently");

  const job = finishFounderJob(root, newJob({ kind: "task" }), {
    error: failure, whatFailed: "Your request",
  });
  assert.equal(job.outcome.outcomeClass, "paused-credits");
  assert.equal(buildFounderOverview(root, PROJECTS).inbox.length, 0);
  assert.equal(buildFounderOverview(root, PROJECTS).autoRecovering.length, 1);
});

test("a model that returns prose instead of JSON is a hard failure at intake", async () => {
  const { root, repo } = fixture();
  const failure = await createContractFromObjective({
    objective: "Add a digest", repo, project: "startup-ops",
    stateRoot: join(root, "state"), hqRoot: root,
    execute: async () => "Sure! I'd be happy to help you plan that.",
  }).then(() => null, (e) => e);
  assert.ok(failure, "prose must not be accepted as a task contract");

  const job = finishFounderJob(root, newJob({ kind: "task" }), { error: failure, whatFailed: "Your request" });
  assert.equal(job.outcome.outcomeClass, "hard-failed");
  assert.equal(buildFounderOverview(root, PROJECTS).inbox.length, 1);
});
