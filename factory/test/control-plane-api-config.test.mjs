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

test("vercel.json does not disable the api/ functions", () => {
  const routes = readdirSync(join(controlPlane, "api")).filter((n) => n.endsWith(".mjs"));
  assert.ok(routes.length > 0, "this test is meaningless without functions to protect");

  // Both keys take the project out of zero-config, and zero-config is the only
  // mode that builds api/. Either one produces a deployment that serves the
  // page perfectly and answers no API route — verified twice against real
  // deployments before this test existed.
  assert.equal(
    config().outputDirectory,
    undefined,
    "outputDirectory switches the deployment to static-only and silently drops api/",
  );
  assert.equal(
    config().buildCommand,
    undefined,
    "buildCommand switches the deployment to build-output mode and silently drops api/",
  );
});

test("the build refuses a configuration that would drop the functions", () => {
  const scratch = mkdtempSync(join(tmpdir(), "control-plane-api-"));
  try {
    cpSync(controlPlane, scratch, { recursive: true });
    const broken = { ...config(), outputDirectory: "public" };
    writeFileSync(join(scratch, "vercel.json"), JSON.stringify(broken, null, 2));

    assert.throws(
      () => execFileSync(process.execPath, ["build.mjs"], { cwd: scratch, encoding: "utf8" }),
      (error) => {
        assert.notEqual(error.status, 0);
        assert.match(String(error.stderr), /disables the \d+ function\(s\) in api\//);
        return true;
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

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
