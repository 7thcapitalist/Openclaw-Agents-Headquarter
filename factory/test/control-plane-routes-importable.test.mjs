import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hqRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const apiDir = join(hqRoot, "control-plane", "api");

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".mjs") ? [path] : [];
  });
}

// A route module must be importable in a checkout where nobody has run
// `npm install` inside control-plane/.
//
// That is not a hypothetical. control-plane/ has its own package.json, its
// node_modules is gitignored, and nothing in the repository installs it --
// `npm run setup` covers dashboard/backend only. A factory agent works in a
// fresh `git worktree`, so for an agent that directory is ALWAYS absent.
//
// When api/_lib/store.mjs imported `@vercel/blob` at module scope, every test
// that imports a route died on ERR_MODULE_NOT_FOUND: ten of them, including
// each auth guard on this public endpoint -- unauthenticated reads, wrong write
// credentials, credential leakage. They did not fail, they never ran, and in
// that state a missing dependency is indistinguishable from broken auth.
//
// So: no bare specifier at module scope anywhere under api/. Relative paths and
// node: builtins only. A package that is genuinely needed gets loaded inside
// the function that needs it, after the configuration check, so an environment
// that cannot serve the request fails closed rather than failing to load.
const STATIC_IMPORT_RE = /^[^\S\r\n]*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_IMPORT_RE = /^[^\S\r\n]*import\s*['"]([^'"]+)['"]/gm;

test("no route statically imports an installed package", () => {
  const offenders = [];
  for (const file of sourceFiles(apiDir)) {
    const source = readFileSync(file, "utf8");
    for (const re of [STATIC_IMPORT_RE, SIDE_EFFECT_IMPORT_RE]) {
      re.lastIndex = 0;
      for (const [, specifier] of source.matchAll(re)) {
        const bare = !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:");
        if (bare) offenders.push(`${relative(hqRoot, file)} imports '${specifier}'`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    "these make the route un-importable without `npm install` in control-plane/, which silently disables the API's auth tests in every agent worktree — load the package inside the function that needs it instead");
});

test("the api directory actually has routes to check", () => {
  // Guards the guard: a path typo that found nothing would pass vacuously.
  assert.ok(sourceFiles(apiDir).length >= 3, "expected the control plane's api/ modules to be found");
});
