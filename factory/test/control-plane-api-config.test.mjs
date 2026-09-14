// The control plane's API must actually be deployed.
//
// #195 shipped two working, tested functions that were never built. Setting
// `outputDirectory` in vercel.json put the project into static-output mode:
// Vercel served public/ correctly, skipped api/ entirely, and reported a
// successful build. Every /api/* route was dead while the dashboard said Ready
// and the page rendered fine.
//
// That is the same failure the campaign started from — a green deploy serving
// something incomplete — so it gets the same treatment: a check that fails
// rather than a note asking people to remember.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hqRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const controlPlane = join(hqRoot, "control-plane");

function config() {
  return JSON.parse(readFileSync(join(controlPlane, "vercel.json"), "utf8"));
}


// NOTE: an earlier version of this file asserted that `outputDirectory` and
// `buildCommand` in vercel.json suppress the api/ functions. That was wrong.
// The functions were deployed in every configuration tried; they hung because
// their handlers used the Web signature instead of Node's. Those assertions are
// removed rather than kept as harmless extras — a guard that enforces a false
// belief sends the next reader down the same wrong path.
//
// The real contract is tested in control-plane-api-contract.test.mjs, by
// calling each route and asserting it ends the response.

test("every api route exports a default handler", async () => {
  for (const name of readdirSync(join(controlPlane, "api")).filter((n) => n.endsWith(".mjs"))) {
    const module = await import(join(controlPlane, "api", name));
    assert.equal(typeof module.default, "function", `api/${name} must export a default handler`);
  }
});

test("the content security policy still allows the page to call its own API", () => {
  const csp = config()
    .headers.flatMap((rule) => rule.headers)
    .find((header) => header.key === "Content-Security-Policy");
  assert.ok(csp, "the CSP must be present");
  // The page fetches /api/session and /api/mirror from itself. A CSP without
  // connect-src 'self' would break sign-in in the browser while every
  // server-side test kept passing.
  assert.match(csp.value, /connect-src 'self'/);
});
