import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { readRegistry, resolveProject, resolveRepoPath, resolveProjectForState, registryPath } from "../lib/intel/registry.mjs";
import { validateRegistry } from "../lib/intel/schema.mjs";

function hqWithRegistry(value) {
  const hq = mkdtempSync(join(tmpdir(), "intel-registry-"));
  mkdirSync(join(hq, "factory"), { recursive: true });
  if (value !== undefined) writeFileSync(registryPath(hq), JSON.stringify(value, null, 2));
  return hq;
}

const validRegistry = {
  version: 1,
  projects: [
    { key: "openclaw-factory", name: "Factory", repo: ".", contextDir: "context", status: "active" },
    { key: "lifemaxing", repo: "~/projects/lifemaxing", contextDir: "context" },
  ],
};

test("reads a valid registry and resolves an entry by key", () => {
  const hq = hqWithRegistry(validRegistry);
  assert.equal(readRegistry(hq).projects.length, 2);
  assert.equal(resolveProject(hq, "lifemaxing").repo, "~/projects/lifemaxing");
  assert.equal(resolveProject(hq, "nope"), null);
});

test("resolveRepoPath maps '.', '~', and absolute forms", () => {
  const hq = hqWithRegistry(validRegistry);
  assert.equal(resolveRepoPath(hq, { repo: "." }), resolve(hq));
  assert.equal(resolveRepoPath(hq, { repo: "~/x/y" }), join(homedir(), "x/y"));
  assert.equal(resolveRepoPath(hq, { repo: "/abs/path" }), "/abs/path");
  assert.equal(resolveRepoPath(hq, { repo: "rel/path" }), resolve(hq, "rel/path"));
});

test("resolveProjectForState returns the real entry for a registered key", () => {
  const hq = hqWithRegistry(validRegistry);
  const entry = resolveProjectForState(hq, { repo: "/somewhere", task: { project: "openclaw-factory" } });
  assert.equal(entry.key, "openclaw-factory");
  assert.equal(entry.contextDir, "context");
  assert.equal(entry.status, "active");
});

test("resolveProjectForState returns a synthetic unregistered entry for an unknown key", () => {
  const hq = hqWithRegistry(validRegistry);
  const entry = resolveProjectForState(hq, { repo: "/somewhere", task: { project: "campuscart" } });
  assert.equal(entry.status, "unregistered");
  assert.equal(entry.contextDir, null);
  assert.equal(entry.repo, "/somewhere");
});

test("readRegistry on a missing file returns an empty registry without throwing", () => {
  const hq = hqWithRegistry(undefined);
  assert.deepEqual(readRegistry(hq), { version: 1, projects: [] });
});

test("validateRegistry rejects malformed registries", () => {
  assert.throws(() => validateRegistry({ version: 2, projects: [] }), /version must be 1/);
  assert.throws(() => validateRegistry({ version: 1, projects: {} }), /must be an array/);
  assert.throws(() => validateRegistry({ version: 1, projects: [{ repo: "." }] }), /key must be a lowercase slug/);
  assert.throws(() => validateRegistry({ version: 1, projects: [{ key: "a", repo: "." }, { key: "a", repo: "." }] }), /duplicate key/);
  assert.throws(() => validateRegistry({ version: 1, projects: [{ key: "a", repo: ".", contextDir: "../x" }] }), /contextDir/);
});

test("readRegistry throws on a structurally broken registry file", () => {
  const hq = hqWithRegistry({ version: 1, projects: [{ key: "Bad Key", repo: "." }] });
  assert.throws(() => readRegistry(hq), /lowercase slug/);
});
