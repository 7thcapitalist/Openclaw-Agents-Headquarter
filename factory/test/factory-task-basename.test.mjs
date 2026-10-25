import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const script = fileURLToPath(new URL("../../scripts/factory-task.mjs", import.meta.url));

test("factory-task without --state-root derives the default state dir via basename (no ReferenceError)", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-task-basename-"));
  const repo = join(root, "my-project");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const r = spawnSync(process.execPath, [script, "status", "--task", "nope", "--repo", repo], { encoding: "utf8" });
  assert.doesNotMatch(r.stderr, /ReferenceError/);
  assert.match(r.stderr, /Task state not found:.*my-project/);
});
