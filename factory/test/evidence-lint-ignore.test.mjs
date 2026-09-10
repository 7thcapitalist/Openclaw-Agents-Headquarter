import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureEvidenceLintIgnored } from "../lib/task-initializer.mjs";

// The shape a Next.js project actually ships (this is lifemaxing's, trimmed).
const NEXT_CONFIG = `import js from "@eslint/js";
const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
];
export default eslintConfig;
`;

function project(contents, name = "eslint.config.mjs") {
  const dir = mkdtempSync(join(tmpdir(), "factory-lint-ignore-"));
  if (contents !== null) writeFileSync(join(dir, name), contents, "utf8");
  return dir;
}

// Prettier honours .gitignore so ignoring evidence/ there covers it. ESLint 9
// honours only its own `ignores`, so factory evidence failed the project's own
// lint gate on a QA agent's scratch .ts — a file that is not product code.
test("evidence is added to an existing flat-config ignores list", () => {
  const dir = project(NEXT_CONFIG);
  assert.deepEqual(ensureEvidenceLintIgnored(dir), ["eslint.config.mjs"]);
  const updated = readFileSync(join(dir, "eslint.config.mjs"), "utf8");
  assert.match(updated, /"evidence\/\*\*",/);
  // The entry lands inside the ignores array, before the existing entries.
  assert.match(updated, /ignores:\s*\[[\s\S]*"evidence\/\*\*",[\s\S]*"\.next\/\*\*"/);
  // Everything else survives untouched.
  assert.match(updated, /"next-env\.d\.ts"/);
  assert.match(updated, /js\.configs\.recommended/);
});

test("it is idempotent", () => {
  const dir = project(NEXT_CONFIG);
  assert.deepEqual(ensureEvidenceLintIgnored(dir), ["eslint.config.mjs"]);
  const once = readFileSync(join(dir, "eslint.config.mjs"), "utf8");
  assert.deepEqual(ensureEvidenceLintIgnored(dir), []);
  assert.equal(readFileSync(join(dir, "eslint.config.mjs"), "utf8"), once);
});

test("a project with no eslint config is left alone", () => {
  assert.deepEqual(ensureEvidenceLintIgnored(project(null)), []);
});

test("an unrecognised config is left untouched rather than rewritten", () => {
  const odd = `export default [{ files: ["**/*.ts"] }];\n`;
  const dir = project(odd);
  assert.deepEqual(ensureEvidenceLintIgnored(dir), []);
  assert.equal(readFileSync(join(dir, "eslint.config.mjs"), "utf8"), odd);
});

test("the .js and .cjs config names are handled too", () => {
  for (const name of ["eslint.config.js", "eslint.config.cjs"]) {
    const dir = project(NEXT_CONFIG, name);
    assert.deepEqual(ensureEvidenceLintIgnored(dir), [name]);
    assert.match(readFileSync(join(dir, name), "utf8"), /"evidence\/\*\*",/);
  }
});
