import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runMany, runPool } from "../../scripts/factory-run-many.mjs";

function makeRepo(root, name) {
  const repo = join(root, name);
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "README.md"), `# ${name}\n`);
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "T"]);
  git(["config", "user.email", "t@x.l"]);
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  return repo;
}

// Mock Chief-of-Staff intake: emit a valid contract with the id it was handed.
const executeChiefOfStaff = async ({ id, repo }) =>
  JSON.stringify({
    id,
    issue: `local:${id}`,
    outcome: `Deliver something in ${repo}`,
    acceptanceCriteria: ["it works"],
    project: "p",
    workType: "backend",
    risk: "low",
    preferredBuilder: "auto",
    constraints: [],
  });

// Mock per-stage agent: writes evidence + a passing result for its dispatch,
// and records the wall-clock window so the test can prove task overlap.
function makeExecute(windows) {
  return async ({ dispatch }) => {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 25));
    const evDir = join(dispatch.cwd, "evidence");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, `${dispatch.stage}.md`), `${dispatch.stage} ok\n`);
    writeFileSync(dispatch.resultPath, JSON.stringify({
      version: 1, dispatchId: dispatch.dispatchId, stage: dispatch.stage, actor: dispatch.actor,
      outcome: "pass", summary: `${dispatch.stage} pass`, evidence: [`evidence/${dispatch.stage}.md`],
    }));
    windows.push({ task: dispatch.taskId, start, end: Date.now() });
  };
}

test("runPool respects the concurrency cap and returns results in input order", async () => {
  const active = { n: 0, max: 0 };
  const out = await runPool([1, 2, 3, 4, 5], 2, async (x) => {
    active.n += 1; active.max = Math.max(active.max, active.n);
    await new Promise((r) => setTimeout(r, 15));
    active.n -= 1;
    return x * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
  assert.equal(active.max, 2);
});

test("two independent factory tasks run concurrently and both reach merge-ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-run-many-"));
  const repoA = makeRepo(root, "app-a");
  const repoB = makeRepo(root, "app-b");
  const windows = [];

  const results = await runMany({
    tasks: [
      { objective: "Add feature A", repo: repoA },
      { objective: "Add feature B", repo: repoB },
    ],
    concurrency: 2,
    dependencies: { executeChiefOfStaff, execute: makeExecute(windows) },
  });

  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.status, "merge-ready", JSON.stringify(r.blocker || r.error || r));
    assert.ok(r.elapsedMs >= 0);
  }
  assert.notEqual(results[0].taskId, results[1].taskId, "distinct task ids");

  // The two tasks' execution windows overlapped in wall-clock time.
  const ids = [...new Set(windows.map((w) => w.task))];
  assert.equal(ids.length, 2);
  const spanA = { start: Math.min(...windows.filter((w) => w.task === ids[0]).map((w) => w.start)), end: Math.max(...windows.filter((w) => w.task === ids[0]).map((w) => w.end)) };
  const spanB = { start: Math.min(...windows.filter((w) => w.task === ids[1]).map((w) => w.start)), end: Math.max(...windows.filter((w) => w.task === ids[1]).map((w) => w.end)) };
  assert.ok(spanA.start < spanB.end && spanB.start < spanA.end, "task execution windows overlap");
});
