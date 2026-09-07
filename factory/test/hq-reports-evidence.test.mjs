import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readObjectiveReport, readTaskEvidence } from "../../dashboard/backend/lib/founderControlPlane.mjs";

function hqFixture() {
  const root = mkdtempSync(join(tmpdir(), "hq-reports-"));
  const factory = join(root, "dashboard", "backend", "data", "factory");
  mkdirSync(factory, { recursive: true });
  return { root, factory };
}

test("readObjectiveReport returns the report when present, and a status stub when only state exists", () => {
  const { root, factory } = hqFixture();
  const dir = join(factory, "demo", "objectives", "obj-abc12345");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "objective-state.json"), JSON.stringify({ objectiveId: "obj-abc12345", status: "active" }));
  assert.deepEqual(readObjectiveReport(root, "obj-abc12345"), { objectiveId: "obj-abc12345", markdown: null, status: "active" });

  writeFileSync(join(dir, "report.md"), "# Objective report — obj-abc12345\n\nAll done.\n");
  const r = readObjectiveReport(root, "obj-abc12345");
  assert.match(r.markdown, /All done/);

  assert.equal(readObjectiveReport(root, "obj-nope00000"), null);
  assert.equal(readObjectiveReport(root, "../etc/passwd"), null, "id shape is validated");
});

test("readTaskEvidence surfaces per-stage evidence excerpts, timeline, retries and the github result", () => {
  const { root, factory } = hqFixture();
  const taskDir = join(factory, "demo", "tasks", "demo-task");
  const worktree = join(root, "wt-demo-task");
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(worktree, "evidence", "builder.md"), "# builder\n\nPASS\n\nImplemented the module and tests.\n");
  writeFileSync(join(worktree, "evidence", "reviewer.md"), "# reviewer\n\nAPPROVE\n\nNo blocking issues.\n");

  const state = {
    version: 1, status: "merge-ready", branch: "factory/demo-task", worktree,
    task: { id: "demo-task", project: "demo", risk: "low", workType: "backend" },
    assignments: { builder: "codex", reviewer: "claude" },
    stages: {
      builder: { status: "pass", actor: "codex", summary: "impl", evidence: [{ path: "evidence/builder.md" }] },
      reviewer: { status: "pass", actor: "claude", summary: "ok", evidence: [{ path: "evidence/reviewer.md" }] },
    },
    dispatches: [
      { stage: "builder", actor: "codex", attempt: 1, outcome: "fail" },
      { stage: "builder", actor: "codex", attempt: 2, outcome: "pass" },
      { stage: "reviewer", actor: "claude", attempt: 1, outcome: "pass" },
    ],
    events: [
      { at: "2026-09-07T09:00:00Z", type: "task-created", stage: "product" },
      { at: "2026-09-07T09:30:00Z", type: "stage-pass", stage: "builder", actor: "codex" },
      { at: "2026-09-07T09:45:00Z", type: "merge-ready", stage: "release" },
    ],
    githubPublish: { published: true, pushed: true, prUrl: "https://github.com/o/r/pull/9", commitSha: "abc1234def" },
  };
  writeFileSync(join(taskDir, "state.json"), JSON.stringify(state));

  const ev = readTaskEvidence(root, "demo-task");
  assert.equal(ev.status, "merge-ready");
  assert.equal(ev.branch, "factory/demo-task");
  assert.equal(ev.githubPublish.prUrl, "https://github.com/o/r/pull/9");
  assert.equal(ev.retryByStage.builder, 1, "one builder retry recorded");
  assert.equal(ev.failedDispatches.length, 1);
  assert.ok(ev.evidenceByStage.builder && ev.evidenceByStage.builder[0].excerpt.includes("Implemented the module"));
  assert.deepEqual(ev.evidenceByStage.reviewer[0].verdicts, ["APPROVE"]);
  assert.equal(ev.events[0].type, "merge-ready", "timeline is newest-first");
  assert.equal(readTaskEvidence(root, "ghost-task"), null);
});
