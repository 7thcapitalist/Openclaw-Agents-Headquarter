import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { resolve } from "path";

const CLI = resolve("scripts/project-intel.mjs");

function run(request) {
  const res = spawnSync("node", [CLI], { input: JSON.stringify(request), encoding: "utf8" });
  return { code: res.status, out: res.stdout ? JSON.parse(res.stdout) : null, stderr: res.stderr };
}

test("list includes the registered factory project with a files map", () => {
  const { code, out } = run({ version: 1, action: "list" });
  assert.equal(code, 0);
  const factory = out.projects.find((p) => p.key === "openclaw-factory");
  assert.ok(factory);
  assert.equal(factory.contextDir, "context");
  assert.equal(typeof factory.files["PROJECT.md"], "boolean");
});

test("show for the factory returns a non-empty pack with the context heading", () => {
  const { code, out } = run({ version: 1, action: "show", project: "openclaw-factory" });
  assert.equal(code, 0);
  assert.match(out.text, /## Project context: OpenClaw Agents Headquarter/);
  assert.ok(Array.isArray(out.warnings));
});

test("lint on the committed factory context is clean", () => {
  const { code, out } = run({ version: 1, action: "lint", project: "openclaw-factory" });
  assert.equal(code, 0);
  const blocking = out.findings.filter((f) => f.severity === "error");
  assert.deepEqual(blocking, [], JSON.stringify(out.findings));
});

test("classify routes a privacy question to a decision request via the CLI", () => {
  const { code, out } = run({ version: 1, action: "classify", text: "store user health data on our backend" });
  assert.equal(code, 0);
  assert.equal(out.outcome, "decision-request");
  assert.equal(out.trigger, "privacy");
});

test("scaffold is idempotent: it never overwrites an existing context file", () => {
  // The factory's own context/ is committed, so scaffold must skip everything.
  const res = run({ version: 1, action: "scaffold", project: "openclaw-factory" });
  assert.equal(res.code, 0);
  assert.deepEqual(res.out.created, []);
  assert.ok(res.out.skipped.includes("PROJECT.md"));
  assert.ok(res.out.skipped.includes("ownership.json"));
});

test("an unknown project is a clean error, not a crash", () => {
  const res = run({ version: 1, action: "lint", project: "no-such-project" });
  assert.equal(res.code, 0);
  assert.equal(res.out.findings[0].code, "project-unregistered");
});
