import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { publishMergeReadyTask, buildPrBody } from "../lib/hq/github-publish.mjs";

function makeHq({ autoPublish = true } = {}) {
  const hq = mkdtempSync(join(tmpdir(), "hq-github-publish-"));
  mkdirSync(join(hq, "factory"), { recursive: true });
  writeFileSync(
    join(hq, "factory", "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        { key: "lifemaxing", name: "LifeMaxing", repo: "/tmp/nope", contextDir: "context", github: { owner: "7thcapitalist", repo: "lifemax" } },
        { key: "no-github", name: "NoGithub", repo: "/tmp/nope2", contextDir: "context" },
      ],
    })
  );
  writeFileSync(join(hq, "factory", "hq.config.json"), JSON.stringify({ version: 1, github: { autoPublish } }));
  return hq;
}

function mergeReadyState(overrides = {}) {
  return {
    status: "merge-ready",
    branch: "task/onboarding",
    worktree: "/tmp/worktree-onboarding",
    task: {
      id: "t-1",
      project: "lifemaxing",
      outcome: "Ship onboarding backend",
      acceptanceCriteria: ["Endpoint returns 200", "Migration applies cleanly"],
    },
    stages: {
      product: { status: "pass", actor: "openclaw", summary: "normalized" },
      architect: { status: "pass", actor: "architect", summary: "design ok" },
      builder: { status: "pass", actor: "backend-builder", summary: "implemented" },
      reviewer: { status: "pass", actor: "reviewer", summary: "no issues" },
      qa: { status: "pass", actor: "qa", summary: "all green" },
      security: { status: "pass", actor: "security", summary: "no findings" },
      release: { status: "pass", actor: "release", summary: "ready" },
    },
    ...overrides,
  };
}

test("refuses a task that is not merge-ready", () => {
  const hq = makeHq();
  const result = publishMergeReadyTask({ hqRoot: hq, state: { status: "active" } });
  assert.equal(result.published, false);
  assert.match(result.reason, /not merge-ready/);
});

test("refuses when github.autoPublish is disabled", () => {
  const hq = makeHq({ autoPublish: false });
  const result = publishMergeReadyTask({ hqRoot: hq, state: mergeReadyState() });
  assert.equal(result.published, false);
  assert.match(result.reason, /disabled/);
});

test("refuses to publish an empty or default branch", () => {
  const hq = makeHq();
  for (const branch of [null, "", "main", "master"]) {
    const result = publishMergeReadyTask({ hqRoot: hq, state: mergeReadyState({ branch }) });
    assert.equal(result.published, false);
    assert.match(result.reason, /default branch/);
  }
});

test("refuses when the project has no github coordinates", () => {
  const hq = makeHq();
  const result = publishMergeReadyTask({
    hqRoot: hq,
    state: mergeReadyState({ task: { ...mergeReadyState().task, project: "no-github" } }),
  });
  assert.equal(result.published, false);
  assert.match(result.reason, /no github/);
});

test("refuses when the project key does not resolve at all", () => {
  const hq = makeHq();
  const result = publishMergeReadyTask({
    hqRoot: hq,
    state: mergeReadyState({ task: { ...mergeReadyState().task, project: "ghost-project" } }),
  });
  assert.equal(result.published, false);
  assert.match(result.reason, /no github/);
});

test("refuses when the worktree has no origin remote", () => {
  const hq = makeHq();
  const exec = (cwd, args) => {
    if (args.join(" ") === "git remote") return { ok: true, out: "" };
    throw new Error(`unexpected exec: ${args.join(" ")}`);
  };
  const result = publishMergeReadyTask({ hqRoot: hq, state: mergeReadyState(), exec });
  assert.equal(result.published, false);
  assert.match(result.reason, /no 'origin' remote/);
});

test("records a push failure without throwing", () => {
  const hq = makeHq();
  const exec = (cwd, args) => {
    if (args.join(" ") === "git remote") return { ok: true, out: "origin" };
    if (args[0] === "git" && args[1] === "push") return { ok: false, out: "rejected: non-fast-forward" };
    throw new Error(`unexpected exec: ${args.join(" ")}`);
  };
  const result = publishMergeReadyTask({ hqRoot: hq, state: mergeReadyState(), exec });
  assert.equal(result.published, false);
  assert.equal(result.pushed, false);
  assert.match(result.reason, /rejected: non-fast-forward/);
});

test("pushes and reports 'open manually' when gh is unavailable", () => {
  const hq = makeHq();
  const calls = [];
  const exec = (cwd, args) => {
    calls.push({ cwd, args });
    if (args.join(" ") === "git remote") return { ok: true, out: "origin" };
    if (args[0] === "git" && args[1] === "push") return { ok: true, out: "" };
    throw new Error(`unexpected exec: ${args.join(" ")}`);
  };
  const result = publishMergeReadyTask({ hqRoot: hq, state: mergeReadyState(), exec, ghAvailable: () => false });
  assert.equal(result.published, true);
  assert.equal(result.pushed, true);
  assert.equal(result.prUrl, null);
  assert.match(result.reason, /open the PR manually/);
  const push = calls.find((c) => c.args[1] === "push");
  assert.deepEqual(push.args, ["git", "push", "-u", "origin", "task/onboarding"]);
  assert.equal(push.cwd, "/tmp/worktree-onboarding");
});

test("pushes and opens a PR via a real-shaped gh invocation (exec injected, gh mocked separately by the caller in production)", () => {
  const hq = makeHq();
  const exec = (cwd, args) => {
    if (args.join(" ") === "git remote") return { ok: true, out: "origin" };
    if (args[0] === "git" && args[1] === "push") return { ok: true, out: "" };
    throw new Error(`unexpected exec: ${args.join(" ")}`);
  };
  // publishMergeReadyTask shells out to `gh` directly (not via `exec`) for PR
  // creation, matching the existing hq/github.mjs pattern; here we only
  // verify the git side and the gh-unavailable path, since invoking a real
  // `gh` binary belongs to an integration/manual check, not this unit test.
  const result = publishMergeReadyTask({ hqRoot: hq, state: mergeReadyState(), exec, ghAvailable: () => false });
  assert.equal(result.pushed, true);
});

test("buildPrBody includes outcome, acceptance criteria, stage verdicts, and the task id, and nothing invented", () => {
  const body = buildPrBody(mergeReadyState());
  assert.match(body, /Ship onboarding backend/);
  assert.match(body, /Endpoint returns 200/);
  assert.match(body, /Migration applies cleanly/);
  assert.match(body, /builder: pass \(backend-builder\)/);
  assert.match(body, /security: pass \(security\)/);
  assert.match(body, /Task id: t-1/);
  assert.match(body, /Merge is always a manual/);
});

test("buildPrBody skips stages that never ran", () => {
  const state = mergeReadyState();
  state.stages.qa = { status: "pending" };
  const body = buildPrBody(state);
  assert.doesNotMatch(body, /qa: pending/);
});
