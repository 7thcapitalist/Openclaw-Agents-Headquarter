import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Nothing in this suite parses the browser bundle. Every dashboard test reads
// app.js as TEXT and regex-matches it, so a file that JavaScript cannot parse
// at all still passes them — the assertions match the source just fine.
//
// That is not hypothetical. A duplicate `const decisions` in renderToday made
// app.js a SyntaxError, taking down the whole Today view rather than one panel,
// and the full suite stayed green through it. This test is the cheap guard:
// every file the browser loads must at least parse.
//
// It deliberately checks parseability only, not behaviour. `node --check` is a
// syntax gate, and these files use browser globals that Node does not have, so
// importing them here would fail for reasons that say nothing about the code.

const PUBLIC_DIR = resolve("dashboard/backend/public");

function browserScripts() {
  const roots = [PUBLIC_DIR, join(PUBLIC_DIR, "lib")];
  const files = [];
  for (const dir of roots) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (!name.isFile()) continue;
      if (name.name.endsWith(".js") || name.name.endsWith(".mjs")) files.push(join(dir, name.name));
    }
  }
  return files.sort();
}

test("every browser script the dashboard serves parses", () => {
  const files = browserScripts();
  // A guard that silently matches nothing is worse than no guard.
  assert.ok(files.length >= 5, `expected to find browser scripts, found ${files.length}`);

  const broken = [];
  for (const file of files) {
    try {
      // ESM syntax (import/export) is only legal under --check for .mjs, so
      // parse .js as a module explicitly rather than letting the extension decide.
      execFileSync(process.execPath, ["--input-type=module", "--check"], {
        input: readFileUtf8(file), stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      broken.push(`${file.replace(`${PUBLIC_DIR}/`, "")}: ${firstLine(String(error.stderr || error.message))}`);
    }
  }
  assert.deepEqual(broken, [], `browser scripts that do not parse:\n  ${broken.join("\n  ")}`);
});

function readFileUtf8(path) {
  return execFileSync("cat", [path], { encoding: "utf8" });
}
function firstLine(text) {
  return text.split("\n").map((s) => s.trim()).filter(Boolean).find((s) => /Error|error/.test(s)) || "did not parse";
}
