// Regression: the founder "Start work" flow POSTs { objective, projectId, repo }
// and the dashboard always sends `repo` (it is filled from the project's
// data-repo, e.g. "." for the Headquarters project). server.mjs used a bare
// `resolve(...)` that was never imported from "path" -> ReferenceError:
// "resolve is not defined", surfaced in the UI. The fix routes both launch
// endpoints through resolveRepoInput(), which normalizes the value the SAME way
// resolveProjectRepo() does (against the HQ root, not process.cwd()).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import test from "node:test";

import { resolveRepoInput, resolveProjectRepo } from "../../dashboard/backend/lib/founderControlPlane.mjs";

function hqRoot() {
  const root = mkdtempSync(join(tmpdir(), "hq-launch-repo-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "projects.json"), JSON.stringify({
    version: 1,
    projects: [
      { key: "openclaw-factory", name: "Headquarters", kind: "headquarters", repo: ".", github: { owner: "o", repo: "r" } },
      { key: "lifemaxing", name: "LifeMax", repo: "~/projects/lifemax" },
    ],
  }));
  return root;
}

test("resolveRepoInput normalizes an explicit repo value against the HQ root", () => {
  const root = hqRoot();
  assert.equal(resolveRepoInput(root, "."), resolve(root));
  assert.equal(resolveRepoInput(root, "./sub"), resolve(root, "sub"));
  assert.equal(resolveRepoInput(root, "/abs/path"), "/abs/path");
  assert.equal(resolveRepoInput(root, "~/x/y"), join(homedir(), "x/y"));
});

test("resolveRepoInput treats empty / whitespace / missing as 'no explicit repo' (null)", () => {
  const root = hqRoot();
  assert.equal(resolveRepoInput(root, ""), null);
  assert.equal(resolveRepoInput(root, "   "), null);
  assert.equal(resolveRepoInput(root, undefined), null);
  assert.equal(resolveRepoInput(root, null), null);
});

test('an explicit repo:"." resolves identically to selecting the Headquarters project by name', () => {
  const root = hqRoot();
  // This is exactly what the dashboard sends when the founder picks the
  // Headquarters project: projectId "openclaw-factory" AND repo "." from data-repo.
  assert.equal(resolveRepoInput(root, "."), resolveProjectRepo(root, "openclaw-factory"));
});

test("resolveRepoInput(root, undefined) falls through so the project registry wins", () => {
  const root = hqRoot();
  const launch = resolveRepoInput(root, undefined) || resolveProjectRepo(root, "lifemaxing");
  assert.equal(launch, join(homedir(), "projects/lifemax"));
});
