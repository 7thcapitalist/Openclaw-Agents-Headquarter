import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  publishMergeReadyTask,
  buildPrBody,
  parseGithubRemote,
  resolveTaskGithubTarget,
  ensureBranchHasCommit,
} from "../lib/hq/github-publish.mjs";

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
    baseSha: "base000",
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

// A git runner for the injected-exec tests: answers the branch-hygiene calls
// (add / status / rev-parse / rev-list) with sensible defaults and lets a test
// override any single command.
function gitRunner(overrides = {}) {
  const calls = [];
  const exec = (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.join(" ");
    if (overrides[key]) return overrides[key](cwd, args);
    if (key === "git remote") return { ok: true, out: "origin" };
    if (key === "git add -A") return { ok: true, out: "" };
    if (key === "git status --porcelain") return { ok: true, out: "" };
    if (args[0] === "git" && args[1] === "commit") return { ok: true, out: "" };
    if (key === "git rev-parse HEAD") return { ok: true, out: "head111" };
    if (key.startsWith("git rev-list --count")) return { ok: true, out: "3" };
    if (args[0] === "git" && args[1] === "push") return { ok: true, out: "" };
    throw new Error(`unexpected exec: ${key}`);
  };
  return { exec, calls };
}

test("parseGithubRemote handles ssh, https, and .git suffixes; rejects non-github", () => {
  assert.deepEqual(parseGithubRemote("git@github.com:acme/widgets.git"), { owner: "acme", repo: "widgets" });
  assert.deepEqual(parseGithubRemote("https://github.com/acme/widgets"), { owner: "acme", repo: "widgets" });
  assert.deepEqual(parseGithubRemote("https://github.com/acme/widgets.git/"), { owner: "acme", repo: "widgets" });
  assert.equal(parseGithubRemote("git@gitlab.com:acme/widgets.git"), null);
  assert.equal(parseGithubRemote(""), null);
});

test("resolveTaskGithubTarget prefers the registry, then falls back to the origin remote", () => {
  const hq = makeHq();
  const fromRegistry = resolveTaskGithubTarget({ hqRoot: hq, state: mergeReadyState(), exec: () => { throw new Error("must not touch git"); } });
  assert.equal(fromRegistry.ownerRepo, "7thcapitalist/lifemax");
  assert.equal(fromRegistry.source, "registry");

  const fromRemote = resolveTaskGithubTarget({
    hqRoot: hq,
    state: mergeReadyState({ task: { ...mergeReadyState().task, project: "no-github" } }),
    exec: (cwd, args) => (args.join(" ") === "git remote get-url origin"
      ? { ok: true, out: "git@github.com:derived/repo.git" }
      : { ok: false, out: "" }),
  });
  assert.equal(fromRemote.ownerRepo, "derived/repo");
  assert.equal(fromRemote.source, "git-remote");

  const none = resolveTaskGithubTarget({
    hqRoot: hq,
    state: mergeReadyState({ task: { ...mergeReadyState().task, project: "no-github" } }),
    exec: () => ({ ok: false, out: "" }),
  });
  assert.equal(none.ownerRepo, null);
  assert.match(none.reason, /no github/);
});

test("ensureBranchHasCommit makes one audit commit when the tree is dirty and no commit exists yet", () => {
  const { exec, calls } = gitRunner({
    "git status --porcelain": () => ({ ok: true, out: " M src/app.mjs" }),
  });
  const result = ensureBranchHasCommit({ state: mergeReadyState(), exec });
  assert.equal(result.committed, true);
  assert.equal(result.commitSha, "head111");
  assert.equal(result.commitRange, "base000..head111");
  const commit = calls.find((c) => c.args[1] === "commit");
  assert.match(commit.args[3], /factory\(t-1\): Ship onboarding backend/);
});

test("ensureBranchHasCommit reports an empty branch rather than pushing nothing", () => {
  const { exec } = gitRunner({
    "git status --porcelain": () => ({ ok: true, out: "" }),
    "git rev-list --count base000..HEAD": () => ({ ok: true, out: "0" }),
  });
  const result = ensureBranchHasCommit({ state: mergeReadyState(), exec });
  assert.equal(result.empty, true);
});

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

test("refuses when the project has no github coordinates and none can be derived", () => {
  const hq = makeHq();
  const result = publishMergeReadyTask({
    hqRoot: hq,
    state: mergeReadyState({ task: { ...mergeReadyState().task, project: "no-github" } }),
    exec: () => ({ ok: false, out: "" }),
  });
  assert.equal(result.published, false);
  assert.match(result.reason, /no github/);
});

test("refuses when the project key does not resolve at all", () => {
  const hq = makeHq();
  const result = publishMergeReadyTask({
    hqRoot: hq,
    state: mergeReadyState({ task: { ...mergeReadyState().task, project: "ghost-project" } }),
    exec: () => ({ ok: false, out: "" }),
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

test("records a push failure without throwing, and still reports the resolved repo + commit", () => {
  const hq = makeHq();
  const { exec } = gitRunner({
    "git status --porcelain": () => ({ ok: true, out: " M a" }),
  });
  // gitRunner already answers add/status/rev-parse/rev-list; handle commit + push here.
  const router = (cwd, args) => {
    if (args[1] === "commit") return { ok: true, out: "" };
    if (args[1] === "push") return { ok: false, out: "rejected: non-fast-forward" };
    return exec(cwd, args);
  };
  const result = publishMergeReadyTask({ hqRoot: hq, state: mergeReadyState(), exec: router });
  assert.equal(result.published, false);
  assert.equal(result.pushed, false);
  assert.equal(result.ownerRepo, "7thcapitalist/lifemax");
  assert.equal(result.commitSha, "head111");
  assert.match(result.reason, /rejected: non-fast-forward/);
});

test("pushes and reports 'open manually' when gh is unavailable, recording the commit range", () => {
  const hq = makeHq();
  const { exec, calls } = gitRunner();
  const result = publishMergeReadyTask({ hqRoot: hq, state: mergeReadyState(), exec, ghAvailable: () => false });
  assert.equal(result.published, true);
  assert.equal(result.pushed, true);
  assert.equal(result.prUrl, null);
  assert.equal(result.ownerRepo, "7thcapitalist/lifemax");
  assert.equal(result.commitRange, "base000..head111");
  assert.match(result.reason, /open the PR manually/);
  const push = calls.find((c) => c.args[1] === "push");
  assert.deepEqual(push.args, ["git", "push", "-u", "origin", "task/onboarding"]);
  assert.equal(push.cwd, "/tmp/worktree-onboarding");
});

test("never pushes the default branch even if state.branch is somehow 'main'", () => {
  const hq = makeHq();
  let pushed = false;
  const exec = (cwd, args) => { if (args[1] === "push") pushed = true; return { ok: true, out: "" }; };
  const result = publishMergeReadyTask({ hqRoot: hq, state: mergeReadyState({ branch: "main" }), exec });
  assert.equal(result.published, false);
  assert.equal(pushed, false);
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
