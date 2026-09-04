import test from "node:test";
import assert from "node:assert/strict";
import { readRepoAwareness, githubAvailable, summariseRepoAwareness } from "../lib/hq/github.mjs";

const ok = (obj) => ({ stdout: JSON.stringify(obj), stderr: "", code: 0 });
const fail = (msg) => ({ stdout: "", stderr: msg, code: 1 });

function fakeGh(overrides = {}) {
  const calls = [];
  const exec = async (args) => {
    calls.push(args);
    const joined = args.join(" ");
    if (joined === "auth status") return overrides.auth || { stdout: "", stderr: "", code: 0 };
    if (args[0] === "repo" && args[1] === "view") {
      return overrides.repoView || ok({ name: "widget", description: "A widget", url: "https://github.com/acme/widget", defaultBranchRef: { name: "main" }, pushedAt: "2026-09-01T00:00:00Z", isPrivate: false, isArchived: false });
    }
    if (args[0] === "api" && /\/commits/.test(joined)) {
      return overrides.commits || ok([
        { sha: "abcdef1234567890", commit: { message: "Add health endpoint\n\nbody", author: { name: "Codex", date: "2026-09-01T12:00:00Z" } } },
      ]);
    }
    if (args[0] === "api" && /\/branches/.test(joined)) {
      return overrides.branches || ok([{ name: "main" }, { name: "task/health" }]);
    }
    if (args[0] === "pr" && args[1] === "list") {
      return overrides.prs || ok([
        { number: 12, title: "Health endpoint", author: { login: "codex" }, isDraft: false, headRefName: "task/health", baseRefName: "main", createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T01:00:00Z", url: "https://github.com/acme/widget/pull/12" },
      ]);
    }
    if (args[0] === "issue" && args[1] === "list") {
      return overrides.issues || ok([
        { number: 5, title: "Flaky test", author: { login: "founder" }, labels: [{ name: "bug" }], createdAt: "2026-08-30T00:00:00Z", updatedAt: "2026-08-31T00:00:00Z", url: "https://github.com/acme/widget/issues/5" },
      ]);
    }
    return fail(`unexpected gh call: ${joined}`);
  };
  return { exec, calls };
}

test("readRepoAwareness assembles a full awareness object from gh output", async () => {
  const { exec } = fakeGh();
  const a = await readRepoAwareness({ owner: "acme", repo: "widget", exec });

  assert.equal(a.available, true);
  assert.equal(a.repoInfo.defaultBranch, "main");
  assert.equal(a.commits[0].sha, "abcdef1234");
  assert.equal(a.commits[0].message, "Add health endpoint");
  assert.deepEqual(a.branches, ["main", "task/health"]);
  assert.equal(a.pullRequests[0].number, 12);
  assert.equal(a.pullRequests[0].isDraft, false);
  assert.equal(a.issues[0].number, 5);
  assert.deepEqual(a.issues[0].labels, ["bug"]);
  assert.equal(a.warnings.length, 0);
});

test("one failing section degrades independently, the rest still populate", async () => {
  const { exec } = fakeGh({ commits: fail("HTTP 403 rate limited") });
  const a = await readRepoAwareness({ owner: "acme", repo: "widget", exec });
  assert.equal(a.available, true);
  assert.deepEqual(a.commits, []);
  assert.equal(a.pullRequests[0].number, 12);
  assert.ok(a.warnings.some((w) => w.code === "gh-commits-failed"));
});

test("unauthenticated gh yields available:false with a warning, no throw", async () => {
  const { exec } = fakeGh({ auth: { stdout: "", stderr: "not logged in", code: 1 } });
  const a = await readRepoAwareness({ owner: "acme", repo: "widget", exec });
  assert.equal(a.available, false);
  assert.equal(a.warnings[0].code, "gh-unavailable");
  assert.equal(await githubAvailable(exec), false);
});

test("disabled or coordinate-less projects short-circuit", async () => {
  const { exec, calls } = fakeGh();
  const disabled = await readRepoAwareness({ owner: "acme", repo: "widget", exec, enabled: false });
  assert.equal(disabled.available, false);
  assert.equal(disabled.warnings[0].code, "github-disabled");

  const noCoords = await readRepoAwareness({ owner: "", repo: "", exec });
  assert.equal(noCoords.warnings[0].code, "github-coordinates-missing");
  assert.equal(calls.length, 0);
});

test("summariseRepoAwareness produces a one-line human summary", async () => {
  const { exec } = fakeGh();
  const a = await readRepoAwareness({ owner: "acme", repo: "widget", exec });
  const line = summariseRepoAwareness(a);
  assert.match(line, /Add health endpoint/);
  assert.match(line, /1 open PR/);
  assert.match(line, /1 open issue/);
});
