import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { discoverProjects, parseGithubRemote, slugify, readOriginUrl } from "../lib/hq/discovery.mjs";

function makeHq({ projects = [], workspaceRoots }) {
  const hq = mkdtempSync(join(tmpdir(), "hq-discovery-hq-"));
  mkdirSync(join(hq, "factory"), { recursive: true });
  writeFileSync(join(hq, "factory", "projects.json"), JSON.stringify({ version: 1, projects }));
  if (workspaceRoots) {
    writeFileSync(
      join(hq, "factory", "hq.config.json"),
      JSON.stringify({ version: 1, discovery: { workspaceRoots, ignore: ["node_modules", "worktrees"], maxDepth: 3 } })
    );
  }
  return hq;
}

function makeRepo(dir, { originUrl = null } = {}) {
  mkdirSync(join(dir, ".git"), { recursive: true });
  if (originUrl) {
    writeFileSync(
      join(dir, ".git", "config"),
      `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    );
  } else {
    writeFileSync(join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  }
  return dir;
}

test("parseGithubRemote handles https and ssh forms", () => {
  assert.deepEqual(parseGithubRemote("https://github.com/acme/widget.git"), { owner: "acme", repo: "widget" });
  assert.deepEqual(parseGithubRemote("https://github.com/acme/widget"), { owner: "acme", repo: "widget" });
  assert.deepEqual(parseGithubRemote("git@github.com:acme/widget.git"), { owner: "acme", repo: "widget" });
  assert.equal(parseGithubRemote("https://gitlab.com/acme/widget.git"), null);
  assert.equal(parseGithubRemote(""), null);
});

test("slugify produces registry-safe keys", () => {
  assert.equal(slugify("LifeMaxing"), "lifemaxing");
  assert.equal(slugify("Campus Cart 2"), "campus-cart-2");
  assert.equal(slugify("--weird--"), "weird");
});

test("discovery proposes unregistered repos, skips registered and ignored ones, and never writes", () => {
  const ws = mkdtempSync(join(tmpdir(), "hq-discovery-ws-"));
  makeRepo(join(ws, "lifemaxing"), { originUrl: "git@github.com:acme/lifemaxing.git" });
  makeRepo(join(ws, "campuscart"));
  makeRepo(join(ws, "already-registered"));
  mkdirSync(join(ws, "node_modules", "somepkg", ".git"), { recursive: true }); // ignored dir
  makeRepo(join(ws, "worktrees", "lm-feature")); // ignored dir name

  const hq = makeHq({
    projects: [{ key: "already-registered", repo: join(ws, "already-registered") }],
    workspaceRoots: [ws],
  });
  const registryBefore = readFileSync(join(hq, "factory", "projects.json"), "utf8");

  const { proposals, scannedRoots, warnings } = discoverProjects({ hqRoot: hq });

  assert.deepEqual(scannedRoots, [ws]);
  assert.equal(warnings.length, 0);
  const keys = proposals.map((p) => p.key).sort();
  assert.deepEqual(keys, ["campuscart", "lifemaxing"]);

  const lm = proposals.find((p) => p.key === "lifemaxing");
  assert.deepEqual(lm.github, { owner: "acme", repo: "lifemaxing" });
  assert.equal(lm.proposedEntry.key, "lifemaxing");
  assert.equal(lm.proposedEntry.contextDir, "context");
  assert.equal(lm.proposedEntry.status, "active");

  // Discovery must not have touched the registry.
  assert.equal(readFileSync(join(hq, "factory", "projects.json"), "utf8"), registryBefore);
});

test("discovery warns when a configured workspace root is missing", () => {
  const hq = makeHq({ workspaceRoots: ["/no/such/workspace/root"] });
  const { proposals, warnings } = discoverProjects({ hqRoot: hq });
  assert.deepEqual(proposals, []);
  assert.equal(warnings[0].code, "root-missing");
});

test("readOriginUrl parses the origin url from .git/config", () => {
  const dir = makeRepo(mkdtempSync(join(tmpdir(), "hq-discovery-repo-")), { originUrl: "https://github.com/acme/x.git" });
  assert.equal(readOriginUrl(dir), "https://github.com/acme/x.git");
});
