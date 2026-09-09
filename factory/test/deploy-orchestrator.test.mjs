import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { MissingCredentialError } from "../lib/deploy/adapters/vercel.mjs";
import { runDeployment } from "../lib/deploy/orchestrator.mjs";
import { deploymentStatePath, readDeploymentState } from "../lib/deploy/store.mjs";

function fixture() {
  const hqRoot = mkdtempSync(join(tmpdir(), "deploy-orchestrator-"));
  const repoPath = join(hqRoot, "app-repo");
  mkdirSync(join(hqRoot, "factory"), { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(hqRoot, "factory", "projects.json"), JSON.stringify({ version: 1, projects: [{ key: "app", repo: repoPath }] }));
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const manifest = {
    version: 1,
    provider: "vercel",
    build: { command: "npm run build" },
    env: [{ key: "VERCEL_TOKEN", required: true, scope: "runtime", source: "secret-store" }],
    hooks: { preDeploy: ["npm run lint"], migrate: "npm run migrate", postDeploy: ["npm run post"] },
    healthCheck: { path: "/health", expectStatus: 200 },
    smokeTest: { path: "/version", method: "GET", expectStatus: 200, bodyIncludes: "ok" },
  };
  return { hqRoot, repoPath, manifest };
}

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 8, 12, 0, tick++));
}

test("orchestrator runs build, test, deploy and both smoke requests, then persists deployed state", async () => {
  const input = fixture();
  const commands = [];
  const requests = [];
  let deployCalls = 0;
  const state = await runDeployment({
    ...input,
    projectKey: "app",
    provider: { id: "mock", async deploy() { deployCalls += 1; return { url: "https://app.example", providerDeploymentId: "dpl_1" }; } },
    env: { VERCEL_TOKEN: "do-not-persist" },
    now: clock(),
    allowRealDeploy: true,
    exec: async (command) => { commands.push(command); return { code: 0 }; },
    fetchFn: async (url) => { requests.push(url); return { status: 200, async text() { return '{"ok":true}'; } }; },
  });
  assert.equal(state.state, "deployed");
  assert.equal(state.productionUrl, "https://app.example");
  assert.ok(state.lastDeploymentAt);
  assert.deepEqual(commands, ["npm run build", "npm test", "npm run lint", "npm run migrate", "npm run post"]);
  assert.deepEqual(requests, ["https://app.example/health", "https://app.example/version"]);
  assert.equal(deployCalls, 1);
  const persisted = readDeploymentState({ hqRoot: input.hqRoot, projectKey: "app" });
  assert.equal(persisted.health.ok, true);
  assert.deepEqual(persisted.history.filter((x) => ["build", "test", "deploy", "smoke"].includes(x.step)).map((x) => x.step), ["build", "test", "deploy", "smoke"]);
  assert.doesNotMatch(readFileSync(deploymentStatePath(input.hqRoot, "app"), "utf8"), /do-not-persist/);
});

test("a build failure stops before provider deploy", async () => {
  const input = fixture();
  let deployed = false;
  const state = await runDeployment({
    ...input, projectKey: "app", env: { VERCEL_TOKEN: "x" }, allowRealDeploy: true,
    provider: { id: "mock", async deploy() { deployed = true; } },
    exec: async (command) => ({ code: command === "npm run build" ? 1 : 0, stderr: "compiler error" }),
  });
  assert.equal(state.state, "failed");
  assert.match(state.lastError, /build failed/);
  assert.equal(deployed, false);
});

test("dry run and credential failures require founder action", async () => {
  const input = fixture();
  let deployCalls = 0;
  const base = { ...input, projectKey: "app", env: { VERCEL_TOKEN: "x" }, exec: async () => ({ code: 0 }) };
  const dry = await runDeployment({ ...base, provider: { id: "mock", async deploy() { deployCalls += 1; } } });
  assert.equal(dry.state, "needs_founder_action");
  assert.equal(dry.founderActionRequired, true);
  assert.equal(deployCalls, 0);
  const missing = await runDeployment({ ...base, allowRealDeploy: true, provider: { id: "mock", async deploy() { throw new MissingCredentialError("VERCEL_TOKEN"); } } });
  assert.equal(missing.state, "needs_founder_action");
  assert.match(missing.founderActionReason, /VERCEL_TOKEN/);
});

test("failed smoke retains the production URL and records unhealthy state", async () => {
  const input = fixture();
  const state = await runDeployment({
    ...input, projectKey: "app", env: { VERCEL_TOKEN: "x" }, allowRealDeploy: true,
    provider: { id: "mock", async deploy() { return { url: "https://broken.example" }; } },
    exec: async () => ({ code: 0 }),
    fetchFn: async () => ({ status: 503, async text() { return "bad"; } }),
  });
  assert.equal(state.state, "failed");
  assert.equal(state.productionUrl, "https://broken.example");
  assert.equal(state.health.ok, false);
  assert.ok(state.lastDeploymentAt);
});
