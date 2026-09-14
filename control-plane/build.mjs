#!/usr/bin/env node
// The build that refuses to ship nothing.
//
// This campaign exists because a deployment of this repository reported success
// while serving no files at all:
//
//     Running "vercel build"
//     Build Completed in /vercel/output [329ms]
//     Skipping cache upload because no files were prepared
//
// Nothing failed. Vercel found no framework and no entry point, produced zero
// files, deployed them, and every path returned 404 while the dashboard showed
// a green "Ready". A build that cannot fail is not a check.
//
// A static app has nothing to compile, so this does not generate the output —
// it verifies it. Every file the deployment needs must exist and be non-empty,
// and the entry point must actually reference the assets it depends on.
//
// WHERE THIS RUNS: CI, on every PR, via factory/test/control-plane-shell.test.mjs.
// It is deliberately NOT wired as Vercel's buildCommand. Setting one puts the
// project into build-output mode, and in that mode Vercel stops scanning api/
// and deploys a site with no functions at all — which is how two tested,
// working endpoints reached production as dead routes. Zero-config is what
// builds the API, so zero-config is what the deployment uses, and this check
// gates the merge instead of the deploy. Only merged main reaches production,
// so the gate still stands in front of it — one step earlier.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const apiDir = join(root, "api");

// Every file that must reach the deployment. Adding an asset means adding it
// here; an asset absent from this list is not protected by the check.
const REQUIRED = ["index.html", "styles.css", "app.js"];

// An asset can exist, be non-empty, and still be unreachable because nothing
// links to it. These are the references index.html must carry.
const REQUIRED_REFERENCES = ["/styles.css", "/app.js"];

const failures = [];

for (const name of REQUIRED) {
  const path = join(publicDir, name);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    failures.push(`missing: public/${name}`);
    continue;
  }
  if (!stat.isFile()) {
    failures.push(`not a file: public/${name}`);
    continue;
  }
  if (stat.size === 0) {
    failures.push(`empty: public/${name}`);
  }
}

if (!failures.length) {
  const html = readFileSync(join(publicDir, "index.html"), "utf8");
  for (const reference of REQUIRED_REFERENCES) {
    if (!html.includes(reference)) {
      failures.push(`index.html does not reference ${reference}`);
    }
  }
}

// The static assets can be perfect while the API is not deployed at all.
//
// That is not hypothetical: setting `outputDirectory` in vercel.json put the
// project into static-output mode, and Vercel stopped building `api/`
// altogether. The page served fine, every /api/* route hung, and the build log
// said nothing was wrong — the same shape of silent success this build script
// was written to prevent, one layer up.
//
// So: if this tree has an api/ directory, the configuration must not be one
// that excludes it.
if (!failures.length) {
  let routes = [];
  try {
    routes = readdirSync(apiDir).filter((name) => name.endsWith(".mjs") || name.endsWith(".js"));
  } catch {
    routes = [];
  }

  if (routes.length) {
    let config = {};
    try {
      config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
    } catch {
      failures.push("api/ exists but vercel.json could not be read");
    }
    // Either key takes the project out of zero-config, and zero-config is the
    // only mode that builds api/ at all.
    for (const key of ["outputDirectory", "buildCommand"]) {
      if (config[key]) {
        failures.push(
          `vercel.json sets ${key}=${config[key]}, which disables the ${routes.length} function(s) in api/`,
        );
      }
    }
  }
}

if (failures.length) {
  console.error("control-plane build failed; refusing to deploy an empty app:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

const total = REQUIRED.reduce(
  (sum, name) => sum + statSync(join(publicDir, name)).size,
  0,
);
console.log(
  `control-plane build ok: ${REQUIRED.length} files, ${total} bytes, serving from ${resolve(publicDir)}`,
);
