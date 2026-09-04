import test from "node:test";
import assert from "node:assert/strict";
import { publishProposals, branchName } from "../lib/learning/publish.mjs";

const NOW = "2026-09-03T00:00:00Z";

// A scripted git double. Each entry matches on a substring of the joined args.
function fakeGit(script) {
  const calls = [];
  const runGit = (cwd, args) => {
    calls.push(args.join(" "));
    for (const [needle, result] of script) {
      if (args.join(" ").includes(needle)) return result;
    }
    return { ok: true, out: "" };
  };
  return { runGit, calls };
}

const files = [{ path: "factory/knowledge/LESSONS_LEARNED.md", content: "# Lessons Learned\n\n## LL-2026-001 — x\n" }];

test("commits locally and notes the missing remote when there is no origin", () => {
  const { runGit, calls } = fakeGit([
    ["rev-parse --show-toplevel", { ok: true, out: "/repo" }],
    ["show-ref --verify", { ok: false, out: "" }],
    ["diff --cached --name-only", { ok: true, out: "factory/knowledge/LESSONS_LEARNED.md" }],
    ["remote", { ok: true, out: "" }],
  ]);
  const res = publishProposals({
    hqRoot: "/repo", branch: branchName(NOW), files, commitTitle: "learning: proposals", now: NOW,
    runGit, ghAvailable: () => false,
  });
  assert.equal(res.published, true);
  assert.equal(res.committed, true);
  assert.equal(res.pushed, false);
  assert.equal(res.prUrl, null);
  assert.ok(res.notes.some((n) => /no 'origin' remote/.test(n)));
  assert.ok(calls.some((c) => c.startsWith("worktree add -b")));
  assert.ok(calls.some((c) => c.startsWith("worktree remove")));
});

test("pushes when origin exists and reports gh absence", () => {
  const { runGit } = fakeGit([
    ["rev-parse --show-toplevel", { ok: true, out: "/repo" }],
    ["show-ref --verify", { ok: false, out: "" }],
    ["diff --cached --name-only", { ok: true, out: "factory/knowledge/LESSONS_LEARNED.md" }],
    ["remote", { ok: true, out: "origin" }],
    ["push -u origin", { ok: true, out: "" }],
  ]);
  const res = publishProposals({
    hqRoot: "/repo", branch: "learning/2026-09-03-x", files, commitTitle: "t", now: NOW,
    runGit, ghAvailable: () => false,
  });
  assert.equal(res.pushed, true);
  assert.equal(res.prUrl, null);
  assert.ok(res.notes.some((n) => /gh CLI not available/.test(n)));
});

test("refuses when the branch already exists", () => {
  const { runGit } = fakeGit([
    ["rev-parse --show-toplevel", { ok: true, out: "/repo" }],
    ["show-ref --verify", { ok: true, out: "" }],
  ]);
  const res = publishProposals({ hqRoot: "/repo", branch: "learning/dup", files, commitTitle: "t", now: NOW, runGit, ghAvailable: () => false });
  assert.equal(res.published, false);
  assert.match(res.reason, /already exists/);
});

test("refuses when hqRoot is not a git repo", () => {
  const { runGit } = fakeGit([["rev-parse --show-toplevel", { ok: false, out: "" }]]);
  const res = publishProposals({ hqRoot: "/nope", branch: "learning/x", files, commitTitle: "t", now: NOW, runGit, ghAvailable: () => false });
  assert.equal(res.published, false);
  assert.match(res.reason, /not a git repository/);
});

test("does nothing when there are no files", () => {
  const res = publishProposals({ hqRoot: "/repo", branch: "x", files: [], commitTitle: "t", now: NOW });
  assert.equal(res.published, false);
});
