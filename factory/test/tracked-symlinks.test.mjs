import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A symlink committed into the repository is almost never intentional, and an
// absolute one is never portable: it encodes the path of the machine that
// created it. `node_modules -> /home/<user>/<repo>/node_modules` reached main in
// #173 this way — agents and test runs link node_modules into a scratch
// worktree, and `git add -A` picked the link up because `.gitignore` said
// `node_modules/`, whose trailing slash matches directories only.
//
// In the main checkout that link also pointed at itself.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Mode 120000 is git's symlink mode; the blob's content is the link target.
function trackedSymlinks() {
  const out = execFileSync("git", ["ls-tree", "-r", "HEAD"], { cwd: repo, encoding: "utf8" });
  return out.split("\n").filter(Boolean).map((line) => {
    const [meta, path] = line.split("\t");
    const [mode, , sha] = meta.split(/\s+/);
    return { mode, path, sha };
  }).filter((entry) => entry.mode === "120000");
}

const targetOf = (sha) => execFileSync("git", ["cat-file", "-p", sha], { cwd: repo, encoding: "utf8" }).trim();

test("no tracked symlink uses an absolute path", () => {
  const offenders = trackedSymlinks()
    .map((entry) => ({ ...entry, target: targetOf(entry.sha) }))
    .filter((entry) => isAbsolute(entry.target))
    .map((entry) => `${entry.path} -> ${entry.target}`);
  assert.deepEqual(offenders, [],
    `absolute symlinks are machine-specific and break every other checkout:\n  ${offenders.join("\n  ")}`);
});

test("no tracked symlink escapes the repository", () => {
  const offenders = trackedSymlinks()
    .map((entry) => ({ ...entry, target: targetOf(entry.sha) }))
    .filter((entry) => !resolve(join(repo, dirname(entry.path)), entry.target).startsWith(repo))
    .map((entry) => `${entry.path} -> ${entry.target}`);
  assert.deepEqual(offenders, [], `symlinks pointing outside the repo:\n  ${offenders.join("\n  ")}`);
});

// The rule that lets the above stay true without anyone remembering it.
test("a node_modules symlink is ignored, not just a node_modules directory", () => {
  const ignored = (path) => {
    try { execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: repo }); return true; }
    catch { return false; }
  };
  // The path itself, which is what a symlink occupies. Asserting a path *below*
  // it would ask git to walk through the link and fail for a reason that has
  // nothing to do with the rule under test.
  assert.equal(ignored("node_modules"), true, "a symlink named node_modules must be ignored");
  assert.equal(ignored("dashboard/backend/node_modules"), true, "nested worktrees link it too");
});
