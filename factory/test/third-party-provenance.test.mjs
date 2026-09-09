import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readProvenance, validateProvenance } from "../lib/third-party/provenance.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;

test("committed provenance is valid and pins Paperclip", () => {
  const manifest = readProvenance(ROOT);
  const source = manifest.sources.find((entry) => entry.id === "paperclip");
  assert.equal(source.commit, "6abeb67334348dcb6fde2d591a27ffc7efc7118d");
  assert.equal(source.license, "MIT");
});

test("validator rejects unknown sources, duplicate artifacts, and traversal", () => {
  const root = fixtureRoot();
  assert.throws(() => validateProvenance({ version: 1,
    sources: [{ id: "source", name: "Source", repository: "https://example.test/repo", commit: "a".repeat(40), license: "MIT", licenseNotice: "licenses/NOTICE.txt" }],
    artifacts: [
      { localPath: "artifact.mjs", sourceId: "missing", sourcePath: "../secret", classification: "copied", notes: "copied" },
      { localPath: "artifact.mjs", sourceId: "source", sourcePath: "src/file.ts", classification: "adapted", notes: "adapted" }
    ] }, { hqRoot: root }), (error) => {
      assert.match(error.message, /unknown source/);
      assert.match(error.message, /sourcePath must be repository-relative/);
      assert.match(error.message, /localPath duplicates/);
      return true;
    });
});

test("reader fails closed for malformed JSON and missing local artifacts", () => {
  const root = fixtureRoot();
  const path = join(root, "factory", "third-party", "provenance.json");
  mkdirSync(join(root, "factory", "third-party"), { recursive: true });
  writeFileSync(path, "{broken", "utf8");
  assert.throws(() => readProvenance(root), /Cannot read/);
  writeFileSync(path, JSON.stringify({ version: 1, sources: [{ id: "source", name: "Source", repository: "https://example.test/repo", commit: "b".repeat(40), license: "MIT", licenseNotice: "missing.txt" }], artifacts: [] }));
  assert.throws(() => readProvenance(root), /does not exist/);
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "hq-provenance-"));
  writeFileSync(join(root, "artifact.mjs"), "export {};\n");
  mkdirSync(join(root, "licenses"));
  writeFileSync(join(root, "licenses", "NOTICE.txt"), "MIT\n");
  return root;
}
