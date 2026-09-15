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
// This checks the STATIC assets only, and says so because the boundary matters:
// it has nothing to say about whether api/ works. Two deployments were
// misdiagnosed on the theory that vercel.json was suppressing the functions. It
// was not — the functions were deployed the whole time, and hung because their
// handlers used the wrong signature. A build-time check cannot see that; only a
// request can. See factory/test/control-plane-api-contract.test.mjs.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const apiDir = join(root, "api");

// Every file that must reach the deployment. Adding an asset means adding it
// here; an asset absent from this list is not protected by the check.
const REQUIRED = ["index.html", "styles.css", "app.js", "render.mjs", "home.mjs", "stage-vocabulary.mjs", "board.mjs", "views.mjs", "task-detail.mjs"];

// An asset can exist, be non-empty, and still be unreachable because nothing
// links to it. These are the references index.html must carry.
const REQUIRED_REFERENCES = ["/styles.css", "/app.js"];

// render.mjs and home.mjs are imported by app.js rather than referenced from
// the HTML, so the entry-point check above cannot see them. They are listed in
// REQUIRED so that their absence still fails the build instead of producing a
// page that loads and then throws on its first import.

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
