import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { previewAgentCompanyImport } from "../lib/packages/agent-company-import.mjs";

function hq(agents = [], projects = []) {
  const root = mkdtempSync(join(tmpdir(), "hq-import-hq-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  writeFileSync(join(root, "factory", "agents.json"), JSON.stringify({ version: 1, agents }));
  writeFileSync(join(root, "factory", "projects.json"), JSON.stringify({ version: 1, projects }));
  return root;
}

function pkg(files) {
  const root = mkdtempSync(join(tmpdir(), "hq-import-pkg-"));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return root;
}

const COMPANY = "---\nkind: company\nname: Test Co\nslug: test-co\n---\n";
const agentDoc = (fields) => `---\nkind: agent\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n`;
const preview = (packageDir, hqRoot) => previewAgentCompanyImport({ packageDir, hqRoot });

// --- the boundary ------------------------------------------------------------

test("the module exposes nothing that can apply an import", async () => {
  const module = await import("../lib/packages/agent-company-import.mjs");
  assert.deepEqual(Object.keys(module), ["previewAgentCompanyImport"],
    "an import module that can apply is one that will eventually apply something nobody reviewed");
});

test("a preview mutates neither the package nor HQ's registries", () => {
  const hqRoot = hq([{ id: "reviewer", name: "Reviewer Agent", role: "Review" }]);
  const packageDir = pkg({ "COMPANY.md": COMPANY, "agents/AGENTS.md": agentDoc({ name: "New Agent", slug: "new-agent" }) });

  const before = {
    agents: readFileSync(join(hqRoot, "factory", "agents.json"), "utf8"),
    projects: readFileSync(join(hqRoot, "factory", "projects.json"), "utf8"),
    doc: readFileSync(join(packageDir, "agents/AGENTS.md"), "utf8"),
  };
  const view = preview(packageDir, hqRoot);
  assert.equal(view.applied, false);
  assert.equal(view.readOnly, true);
  assert.equal(readFileSync(join(hqRoot, "factory", "agents.json"), "utf8"), before.agents);
  assert.equal(readFileSync(join(hqRoot, "factory", "projects.json"), "utf8"), before.projects);
  assert.equal(readFileSync(join(packageDir, "agents/AGENTS.md"), "utf8"), before.doc);
});

test("the preview names the files a human would have to change by hand", () => {
  const view = preview(pkg({ "COMPANY.md": COMPANY }), hq());
  assert.deepEqual(view.appliesTo, ["factory/agents.json", "factory/projects.json"]);
});

// --- lint gates the diff -----------------------------------------------------

test("a package that fails linting is not parsed and produces no diff", () => {
  const packageDir = pkg({ "COMPANY.md": COMPANY, "agents/AGENTS.md": "---\nkind: agent\n---\n" });
  const view = preview(packageDir, hq());
  assert.equal(view.status, "rejected");
  assert.equal(view.lint.valid, false);
  assert.deepEqual(view.entries, []);
  assert.equal(view.diff.summary.added, 0);
  assert.match(view.reason, /did not pass linting/);
});

test("a package carrying secret-shaped content is rejected before any diff", () => {
  const packageDir = pkg({
    "COMPANY.md": COMPANY,
    "agents/AGENTS.md": `${agentDoc({ name: "Leaky", slug: "leaky" })}\ntoken sk-abcdefghijklmnopqrstuvwxyz\n`,
  });
  const view = preview(packageDir, hq());
  assert.equal(view.status, "rejected");
  assert.doesNotMatch(JSON.stringify(view.entries), /sk-abcdefghijklmnopqrstuvwxyz/);
});

// --- the diff ----------------------------------------------------------------

test("an agent HQ does not have is proposed as an addition", () => {
  const view = preview(
    pkg({ "COMPANY.md": COMPANY, "a/AGENTS.md": agentDoc({ name: "Growth Agent", slug: "growth", role: "Distribution" }) }),
    hq([{ id: "reviewer", name: "Reviewer Agent" }]),
  );
  assert.deepEqual(view.diff.agents.added.map((item) => item.id), ["growth"]);
  assert.equal(view.diff.summary.added, 1);
});

test("an agent HQ already has is a field-level change, not a blind overwrite", () => {
  const view = preview(
    pkg({ "COMPANY.md": COMPANY, "a/AGENTS.md": agentDoc({ name: "Reviewer Agent", slug: "reviewer", role: "Independent review", harness: "claude" }) }),
    hq([{ id: "reviewer", name: "Reviewer Agent", role: "Review", harness: "multiple" }]),
  );
  const [change] = view.diff.agents.changed;
  assert.equal(change.id, "reviewer");
  assert.deepEqual(change.changes.sort((a, b) => a.field.localeCompare(b.field)), [
    { field: "harness", current: "multiple", proposed: "claude" },
    { field: "role", current: "Review", proposed: "Independent review" },
  ]);
  assert.equal(view.diff.summary.changed, 1);
});

test("an identical agent is unchanged rather than a needless proposal", () => {
  const view = preview(
    pkg({ "COMPANY.md": COMPANY, "a/AGENTS.md": agentDoc({ name: "Reviewer Agent", slug: "reviewer", role: "Review" }) }),
    hq([{ id: "reviewer", name: "Reviewer Agent", role: "Review" }]),
  );
  assert.deepEqual(view.diff.agents.unchanged.map((item) => item.id), ["reviewer"]);
  assert.equal(view.diff.summary.changed, 0);
});

test("a project is matched on its registry key, not only on an id field", () => {
  const view = preview(
    pkg({ "COMPANY.md": COMPANY, "p/PROJECT.md": "---\nkind: project\nname: LifeMax\nslug: lifemaxing\nmission: New mission\n---\n" }),
    hq([], [{ key: "lifemaxing", name: "LifeMax", mission: "Old mission" }]),
  );
  assert.deepEqual(view.diff.projects.changed.map((item) => item.id), ["lifemaxing"]);
});

test("a dangling reporting line is a conflict, not an imported dangling reference", () => {
  const view = preview(
    pkg({ "COMPANY.md": COMPANY, "a/AGENTS.md": agentDoc({ name: "Growth Agent", slug: "growth", reportsTo: "cmo" }) }),
    hq([{ id: "reviewer" }]),
  );
  assert.deepEqual(view.diff.conflicts, [{
    kind: "agent", id: "growth", field: "reportsTo",
    reason: "reports to 'cmo', which exists in neither the package nor HQ",
  }]);
  assert.equal(view.diff.summary.conflicts, 1);
});

test("a reporting line satisfied by the package itself is not a conflict", () => {
  const view = preview(
    pkg({
      "COMPANY.md": COMPANY,
      "a/AGENTS.md": agentDoc({ name: "Growth Agent", slug: "growth", reportsTo: "cmo" }),
      "b/AGENTS.md": agentDoc({ name: "CMO", slug: "cmo" }),
    }),
    hq(),
  );
  assert.deepEqual(view.diff.conflicts, []);
});

test("reporting to the founder is always valid", () => {
  const view = preview(
    pkg({ "COMPANY.md": COMPANY, "a/AGENTS.md": agentDoc({ name: "Chief", slug: "chief", reportsTo: "founder" }) }),
    hq(),
  );
  assert.deepEqual(view.diff.conflicts, []);
});

// --- safety of what is read --------------------------------------------------

test("a symlink out of the package is never followed", () => {
  const outside = mkdtempSync(join(tmpdir(), "hq-import-outside-"));
  writeFileSync(join(outside, "AGENTS.md"), agentDoc({ name: "Sneaky", slug: "sneaky" }));
  const packageDir = pkg({ "COMPANY.md": COMPANY });
  mkdirSync(join(packageDir, "linked"));
  symlinkSync(join(outside, "AGENTS.md"), join(packageDir, "linked", "AGENTS.md"));

  const view = preview(packageDir, hq());
  assert.equal(view.entries.some((entry) => entry.id === "sneaky"), false,
    "a symlinked entry file must not be read out of the package");
});

test("package text is sanitised, so a diff cannot carry markup into a reviewer's view", () => {
  const view = preview(
    pkg({ "COMPANY.md": COMPANY, "a/AGENTS.md": agentDoc({ name: "<script>alert(1)</script>", slug: "x" }) }),
    hq(),
  );
  const json = JSON.stringify(view);
  assert.doesNotMatch(json, /<script>/);
  assert.match(json, /scriptalert\(1\)\/script/);
});

test("free text from a package is bounded", () => {
  const view = preview(
    pkg({ "COMPANY.md": COMPANY, "a/AGENTS.md": agentDoc({ name: "Long", slug: "long", responsibility: "x".repeat(2000) }) }),
    hq(),
  );
  assert.ok(view.diff.agents.added[0].responsibility.length <= 500);
});

test("unrecognised frontmatter keys never reach the diff", () => {
  const view = preview(
    pkg({ "COMPANY.md": COMPANY, "a/AGENTS.md": agentDoc({ name: "X", slug: "x", secretToken: "value", arbitraryKey: "junk" }) }),
    hq(),
  );
  const [added] = view.diff.agents.added;
  assert.equal(added.secretToken, undefined);
  assert.equal(added.arbitraryKey, undefined);
});

test("an unreadable HQ registry over-reports additions rather than claiming a match", () => {
  const hqRoot = hq();
  writeFileSync(join(hqRoot, "factory", "agents.json"), "{ truncated");
  const view = preview(pkg({ "COMPANY.md": COMPANY, "a/AGENTS.md": agentDoc({ name: "Reviewer Agent", slug: "reviewer" }) }), hqRoot);
  assert.deepEqual(view.diff.agents.added.map((item) => item.id), ["reviewer"]);
  assert.deepEqual(view.diff.agents.unchanged, []);
});

test("a company entry is listed but is not an agent or project proposal", () => {
  const view = preview(pkg({ "COMPANY.md": COMPANY }), hq());
  assert.equal(view.status, "preview");
  assert.deepEqual(view.diff.other.map((item) => item.kind), ["company"]);
  assert.equal(view.diff.summary.added, 0);
});
