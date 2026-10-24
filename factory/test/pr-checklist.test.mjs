import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runChecklist, parseAddedLines } from "../lib/pr-checklist.mjs";

const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test("clean diff with a test passes", () => {
  assert.equal(runChecklist({ files: ["scripts/a.mjs", "factory/test/a.test.mjs"], scope: ["scripts/**", "factory/test/**"] }).ok, true);
});
test("flags .env and credential files but allows .env.example", () => {
  assert.deepEqual(failed(runChecklist({ files: [".env", "x/auth.json", "k.pem", "a.test.mjs"] })), ["secrets"]);
  assert.equal(runChecklist({ files: [".env.example", "a.test.mjs"] }).ok, true);
});
test("flags secret-looking added content", () => {
  const addedLines = { "a.mjs": ["const t = 'ghp_" + "a".repeat(36) + "'"] };
  assert.deepEqual(failed(runChecklist({ files: ["a.mjs", "a.test.mjs"], addedLines })), ["secrets"]);
});
test("flags files outside scope", () => {
  const r = runChecklist({ files: ["scripts/a.mjs", "docs/x.md", "a.test.mjs"], scope: ["scripts/**", "a.test.mjs"] });
  assert.deepEqual(failed(r), ["scope"]);
  assert.match(r.checks[1].details[0], /docs\/x\.md/);
});
test("code without tests fails unless disabled", () => {
  assert.deepEqual(failed(runChecklist({ files: ["scripts/a.mjs"] })), ["tests"]);
  assert.equal(runChecklist({ files: ["scripts/a.mjs"], requireTests: false }).ok, true);
  assert.equal(runChecklist({ files: ["docs/a.md"] }).ok, true);
});
test("parseAddedLines reads added lines per file", () => {
  assert.deepEqual(parseAddedLines("+++ b/a.mjs\n+one\n-two\n+three\n"), { "a.mjs": ["one", "three"] });
});
test("CLI exits 1 on a branch that adds .env, 0 on a clean one", () => {
  const cli = resolve(import.meta.dirname, "../../scripts/pr-checklist.mjs");
  const repo = mkdtempSync(join(tmpdir(), "prcl-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "r.md"), "x");
  git("add", "."); git("commit", "-qm", "base");
  git("checkout", "-qb", "feat");
  mkdirSync(join(repo, "t"));
  writeFileSync(join(repo, "t", "a.test.mjs"), "x");
  git("add", "."); git("commit", "-qm", "ok");
  const run = () => { try { execFileSync("node", [cli, "--base", "main"], { cwd: repo, stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
  assert.equal(run(), 0);
  writeFileSync(join(repo, ".env"), "K=1");
  git("add", "-f", "."); git("commit", "-qm", "bad");
  assert.equal(run(), 1);
});
