// The control plane is the only deployable tree in this repository, and the
// properties that make it safe to deploy are not visible in a diff.
//
// Three of them are worth a test rather than care:
//
//   1. the build fails on an empty or incomplete output — this campaign exists
//      because a build that could not fail deployed zero files green
//   2. nothing under control-plane/ imports from dashboard/ or factory/ — the
//      deployable tree must stay self-contained, and a stray import would ship
//      factory code to a public URL
//   3. no credential and no company data is committed there
//
// (2) and (3) are the publish boundary restated for the tree that is actually
// published. `factory/lib/hq/mirror.mjs` decides what leaves the machine at
// runtime; these assertions cover what leaves it at deploy time.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hqRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const controlPlane = join(hqRoot, "control-plane");

function sourceFiles(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else out.push(path);
  }
  return out;
}

function runBuild(cwd) {
  return execFileSync(process.execPath, ["build.mjs"], { cwd, encoding: "utf8" });
}

test("the build succeeds on the committed tree", () => {
  const output = runBuild(controlPlane);
  assert.match(output, /control-plane build ok/);
});

test("the build fails rather than deploying an empty output", () => {
  const scratch = mkdtempSync(join(tmpdir(), "control-plane-build-"));
  try {
    cpSync(controlPlane, scratch, { recursive: true });

    // The exact failure that started this campaign: an output directory that
    // exists and contains nothing.
    for (const name of readdirSync(join(scratch, "public"))) {
      rmSync(join(scratch, "public", name));
    }

    assert.throws(
      () => runBuild(scratch),
      (error) => {
        assert.notEqual(error.status, 0, "an empty output must fail the build");
        assert.match(String(error.stderr), /refusing to deploy an empty app/);
        return true;
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the build fails on a present but empty asset", () => {
  const scratch = mkdtempSync(join(tmpdir(), "control-plane-build-"));
  try {
    cpSync(controlPlane, scratch, { recursive: true });
    writeFileSync(join(scratch, "public", "app.js"), "");

    assert.throws(
      () => runBuild(scratch),
      (error) => {
        assert.notEqual(error.status, 0);
        assert.match(String(error.stderr), /empty: public\/app\.js/);
        return true;
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the build fails when the entry point stops referencing an asset", () => {
  const scratch = mkdtempSync(join(tmpdir(), "control-plane-build-"));
  try {
    cpSync(controlPlane, scratch, { recursive: true });
    const html = readFileSync(join(scratch, "public", "index.html"), "utf8");
    writeFileSync(
      join(scratch, "public", "index.html"),
      html.replace('<script type="module" src="/app.js"></script>', ""),
    );

    assert.throws(
      () => runBuild(scratch),
      (error) => {
        assert.notEqual(error.status, 0);
        assert.match(String(error.stderr), /does not reference \/app\.js/);
        return true;
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the deployable tree imports nothing from dashboard/ or factory/", () => {
  const offenders = [];
  for (const path of sourceFiles(controlPlane)) {
    if (![".mjs", ".js", ".json", ".html"].includes(extname(path))) continue;
    const source = readFileSync(path, "utf8");
    // Any traversal out of control-plane/, and any direct name of the two
    // trees that must never ship.
    if (/(from|import|require)\s*\(?\s*["'][^"']*\.\.\//.test(source)
      || /["'][^"']*\/(dashboard|factory)\//.test(source)) {
      offenders.push(relative(hqRoot, path));
    }
  }
  assert.deepEqual(offenders, [], "the deployable tree must be self-contained");
});

test("every dependency is pinned exactly and the lockfile is committed", () => {
  const manifest = JSON.parse(readFileSync(join(controlPlane, "package.json"), "utf8"));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };

  // A range in a deployable tree means the artifact that ships is not the one
  // that was reviewed. Pin exactly, and commit the lockfile so the transitive
  // set is pinned too.
  for (const [name, range] of Object.entries(declared)) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name} must be pinned to an exact version, got ${range}`);
  }
  assert.ok(statSync(join(controlPlane, "package-lock.json")).isFile(), "package-lock.json must be committed");

  // The publish boundary is the reason to care who is in here at all. Keep the
  // list short enough to read, and first-party.
  assert.deepEqual(Object.keys(declared).sort(), ["@vercel/blob"]);
});

test("the deployable tree contains no credential and no .env", () => {
  const secretish = /(?:api[_-]?key|secret|token|password|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY)\s*[:=]\s*["'][^"']{8,}/i;
  const offenders = [];
  for (const path of sourceFiles(controlPlane)) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name === ".env" || name.startsWith(".env.")) offenders.push(relative(hqRoot, path));
    if (![".mjs", ".js", ".json", ".html", ".css", ".md"].includes(extname(path))) continue;
    if (secretish.test(readFileSync(path, "utf8"))) offenders.push(relative(hqRoot, path));
  }
  assert.deepEqual(offenders, []);
});

test("the repository root stays non-deployable", () => {
  // The root must not acquire the markers that made Vercel deploy it: a
  // vercel.json, or an index.html that a zero-config build would serve.
  assert.throws(() => statSync(join(hqRoot, "vercel.json")));
  assert.throws(() => statSync(join(hqRoot, "index.html")));
  const rootManifest = JSON.parse(readFileSync(join(hqRoot, "package.json"), "utf8"));
  assert.equal(rootManifest.scripts.build, undefined, "a root build script invites a root deployment");
});

test("the preview server binds loopback only", () => {
  const source = readFileSync(join(controlPlane, "serve.mjs"), "utf8");
  assert.match(source, /listen\(port,\s*"127\.0\.0\.1"/);
  assert.doesNotMatch(source, /"0\.0\.0\.0"/);
});


// Every module the page imports must be one the build protects.
//
// `money.mjs` shipped imported by app.js and absent from build.mjs's REQUIRED
// list, so deleting it would have produced a build that passed and a page that
// threw on its first import — the precise failure that file exists to prevent.
// Keeping the list correct by hand is what failed; this derives it instead.
test("build.mjs protects every module the console actually imports", () => {
  const publicDir = join(controlPlane, "public");
  const build = readFileSync(join(controlPlane, "build.mjs"), "utf8");

  const required = new Set(
    // The REQUIRED array, read as source rather than imported: build.mjs exits
    // the process on failure and must not be run inside the test runner.
    [...build.matchAll(/"([\w.-]+\.(?:mjs|js|css|html))"/g)].map((m) => m[1]),
  );

  // Walk the import graph from the entry point, so a module imported by a
  // module is covered too.
  const seen = new Set();
  const queue = ["app.js"];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    let source;
    try { source = readFileSync(join(publicDir, name), "utf8"); } catch { continue; }
    // app.js imports absolutely ("/render.mjs") because the browser loads it as
    // the entry point; every other module imports relatively ("./render.mjs").
    // Both forms name a file in this directory, so both are followed.
    for (const match of source.matchAll(/from\s+"\.?\/([\w.-]+\.mjs)"/g)) {
      queue.push(match[1]);
    }
  }

  for (const name of seen) {
    assert.ok(
      required.has(name),
      `public/${name} is imported by the console but missing from REQUIRED in control-plane/build.mjs — `
      + "deleting it would pass the build and break the page",
    );
  }

  // And the reverse: a listed asset that no longer exists would fail the build
  // for the right reason, but a listed asset nothing imports is dead weight.
  assert.ok(seen.has("app.js"));
  assert.ok(seen.size >= 6, `expected the console's module graph, found ${seen.size}`);
});
