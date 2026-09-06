import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { buildCompletionReport, formatDuration } from "../lib/hq/completion-report.mjs";
import { writeCompletionReport } from "../lib/openclaw-runner.mjs";

function mergeReadyState(overrides = {}) {
  return {
    version: 1,
    status: "merge-ready",
    branch: "task/onboarding",
    repo: "/tmp/project",
    worktree: "/tmp/worktree-onboarding",
    createdAt: "2026-09-06T09:00:00.000Z",
    updatedAt: "2026-09-06T10:30:00.000Z",
    task: {
      id: "t-1",
      project: "lifemaxing",
      outcome: "Ship onboarding backend",
      risk: "medium",
      workType: "backend",
      acceptanceCriteria: ["Endpoint returns 200", "Migration applies cleanly"],
    },
    stages: {
      product: { status: "pass", actor: "openclaw", summary: "normalized", evidence: [{ path: "evidence/product.md" }] },
      architect: { status: "pass", actor: "architect", summary: "design ok", evidence: [{ path: "evidence/arch.md" }] },
      builder: { status: "pass", actor: "backend-builder", summary: "implemented", evidence: [{ path: "evidence/build.md" }] },
      reviewer: { status: "pass", actor: "reviewer", summary: "no issues", evidence: [{ path: "evidence/rev.md" }] },
      qa: { status: "pass", actor: "qa", summary: "all green", evidence: [{ path: "evidence/qa.md" }] },
      security: { status: "pass", actor: "security", summary: "no findings", evidence: [{ path: "evidence/sec.md" }] },
      release: { status: "pass", actor: "release", summary: "ready", evidence: [{ path: "evidence/rel.md" }] },
    },
    events: [
      { at: "2026-09-06T09:00:00.000Z", type: "task-created", stage: "product" },
      { at: "2026-09-06T10:29:00.000Z", type: "handoff-ready", stage: "release" },
      { at: "2026-09-06T10:30:00.000Z", type: "merge-ready", stage: "release", actor: "release" },
    ],
    githubPublish: { published: true, pushed: true, prUrl: "https://github.com/o/r/pull/7", ownerRepo: "o/r", remote: "origin", commitSha: "abc1234", commitRange: "base..abc1234" },
    ...overrides,
  };
}

test("formatDuration renders compact wall-clock strings", () => {
  assert.equal(formatDuration(45 * 1000), "45s");
  assert.equal(formatDuration(8 * 60 * 1000), "8m");
  assert.equal(formatDuration((3 * 60 + 12) * 60 * 1000), "3h 12m");
  assert.equal(formatDuration(null), "unknown");
});

test("a merge-ready report names every passed stage, the elapsed time, and the PR", () => {
  const md = buildCompletionReport(mergeReadyState(), { now: Date.parse("2026-09-06T12:00:00.000Z") });
  assert.match(md, /# Completion report — t-1/);
  assert.match(md, /Merge-ready/);
  for (const stage of ["product", "architect", "builder", "reviewer", "qa", "security", "release"]) {
    assert.match(md, new RegExp(`\\*\\*${stage}\\*\\* — pass`));
  }
  assert.match(md, /1h 30m/, "elapsed uses last event time for a terminal task, not now");
  assert.match(md, /https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.match(md, /o\/r/);
  assert.match(md, /abc1234/);
  assert.match(md, /Merge is always a separate, manual founder decision/);
});

test("a report is also produced for a terminal-blocked task and explains why", () => {
  const blocked = mergeReadyState({
    status: "blocked",
    stages: { ...mergeReadyState().stages, qa: { status: "fail", actor: "qa", summary: "criterion 2 fails", evidence: [{ path: "evidence/qa.md" }] } },
    blocker: { stage: "qa", outcome: "fail", summary: "criterion 2 fails: migration errors on a fresh DB", actor: "qa", at: "2026-09-06T10:20:00.000Z" },
    events: [
      { at: "2026-09-06T09:00:00.000Z", type: "task-created", stage: "product" },
      { at: "2026-09-06T10:10:00.000Z", type: "stage-fail", stage: "qa", actor: "qa" },
      { at: "2026-09-06T10:12:00.000Z", type: "failure-routed", fromStage: "qa", stage: "builder", attempt: 2 },
      { at: "2026-09-06T10:20:00.000Z", type: "stage-fail", stage: "qa", actor: "qa" },
    ],
    githubPublish: undefined,
  });
  const md = buildCompletionReport(blocked, { now: Date.parse("2026-09-06T10:25:00.000Z") });
  assert.match(md, /Blocked — needs the founder/);
  assert.match(md, /## Why it is blocked/);
  assert.match(md, /migration errors on a fresh DB/);
  assert.match(md, /## Setbacks and how they were handled/);
  assert.match(md, /qa failed \(qa\)/);
  assert.match(md, /routed back to builder \(attempt 2\)/);
  assert.match(md, /GitHub: not published/);
});

test("writeCompletionReport drops completion-report.md next to state.json and records it on state", () => {
  const dir = mkdtempSync(join(tmpdir(), "completion-report-"));
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, `${JSON.stringify(mergeReadyState(), null, 2)}\n`, "utf8");

  const result = writeCompletionReport({ statePath });
  assert.equal(result.path, join(dir, "completion-report.md"));
  assert.ok(existsSync(result.path));
  assert.match(readFileSync(result.path, "utf8"), /# Completion report — t-1/);

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.completionReport.path, join(dir, "completion-report.md"));
  assert.equal(state.completionReport.status, "merge-ready");
  assert.ok(state.events.some((e) => e.type === "completion-report"));
});

test("writeCompletionReport never throws on a broken state file", () => {
  const dir = mkdtempSync(join(tmpdir(), "completion-report-bad-"));
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, "{ not json", "utf8");
  const result = writeCompletionReport({ statePath });
  assert.ok(result.error, "returns an error object rather than throwing");
});
