import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A run writes its gate proof to <worktree>/evidence, so that pattern must stay
// anchored to the worktree root. Unanchored, `evidence/` also matches product
// source in any directory of that name, and `git add -A` drops it silently —
// no error, no warning. The FCT-P0-05 modules were written, tested and left
// uncommittable that way before being flattened to lib/evidence-*.mjs. This
// keeps the trap from being reintroduced for the next such directory.
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// check-ignore answers from the rules alone; the path need not exist.
const ignored = (path) => {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: repo });
    return true;
  } catch { return false; }
};

test("run evidence at the worktree root is still ignored", () => {
  assert.equal(ignored("evidence/qa-test-output.log"), true);
  assert.equal(ignored("evidence/security-scan.md"), true);
});

test("product source in a nested directory named evidence is NOT ignored", () => {
  assert.equal(ignored("factory/lib/evidence/manifest.mjs"), false);
  assert.equal(ignored("dashboard/backend/lib/evidence/view.mjs"), false);
});

test("the shipped evidence modules are tracked", () => {
  const tracked = execFileSync("git", ["ls-files", "factory/lib"], { cwd: repo }).toString();
  assert.match(tracked, /factory\/lib\/evidence-manifest\.mjs/);
  assert.match(tracked, /factory\/lib\/evidence-criteria\.mjs/);
});
