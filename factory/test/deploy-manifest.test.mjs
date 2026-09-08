import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { validateDeployManifest } from "../lib/deploy/manifest.mjs";

function manifest(overrides = {}) {
  return {
    version: 1,
    provider: "vercel",
    build: { command: "npm run build", rootDirectory: "." },
    env: [{ key: "DATABASE_URL", required: true, scope: "runtime", source: "secret-store" }],
    hooks: { migrate: "npm run migrate", preDeploy: ["npm run lint"], postDeploy: ["npm run seed"] },
    healthCheck: { path: "/api/health", expectStatus: 200, timeoutMs: 5000 },
    smokeTest: { path: "/api/version", method: "GET", expectStatus: 200, bodyIncludes: "ok" },
    ...overrides,
  };
}

test("deployment manifest accepts the documented contract", () => {
  assert.equal(validateDeployManifest(manifest()).version, 1);
});

test("deployment manifest rejects unsafe and malformed fields", () => {
  assert.throws(() => validateDeployManifest(manifest({ build: {} })), /build\.command is required/);
  assert.throws(() => validateDeployManifest(manifest({ provider: "hard-coded-cloud" })), /unknown provider/);
  assert.throws(() => validateDeployManifest(manifest({ surprise: true })), /unknown top-level property/);
  assert.throws(() => validateDeployManifest(manifest({ build: { command: "build", rootDirectory: "../escape" } })), /repo-relative path/);
  assert.throws(() => validateDeployManifest(manifest({ env: [{ key: "DATABASE_URL", required: true, scope: "runtime", source: "env", value: "secret" }] })), /property "value" is not allowed/);
  assert.throws(() => validateDeployManifest(manifest({ env: [{ key: "bad-key", required: true, scope: "runtime", source: "env" }] })), /SCREAMING_SNAKE_CASE/);
  assert.throws(() => validateDeployManifest(manifest({ healthCheck: { path: "api/health" } })), /must start with/);
});

test("reference schema documents the runtime-required shape and closes env declarations", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/deploy-manifest.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.required, ["version", "build", "env", "healthCheck"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.env.items.additionalProperties, false);
  assert.deepEqual(schema.properties.provider.enum, ["vercel", "none"]);
  assert.equal(schema.properties.healthCheck.properties.path.pattern, "^/");
});
