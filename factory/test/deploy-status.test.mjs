import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readDeploymentStatus } from "../lib/deploy/status.mjs";
import { deploymentStatePath, writeDeploymentState } from "../lib/deploy/store.mjs";

function root() {
  const hqRoot = mkdtempSync(join(tmpdir(), "deploy-status-"));
  mkdirSync(join(hqRoot, "factory"), { recursive: true });
  writeFileSync(join(hqRoot, "factory", "projects.json"), JSON.stringify({ version: 1, projects: [{ key: "app", repo: "/tmp/different-repo-name" }] }));
  return hqRoot;
}

test("status defaults to not_deployed and resolves registry key separately from repo basename", () => {
  const hqRoot = root();
  assert.equal(readDeploymentStatus({ hqRoot, projectKey: "app" }).state, "not_deployed");
  writeDeploymentState({ hqRoot, projectKey: "app", state: {
    version: 1, projectKey: "app", state: "deployed", productionUrl: "https://app.example",
    health: { ok: true, status: 200 }, lastDeploymentAt: "2026-09-08T12:00:00.000Z", founderActionRequired: false,
  } });
  assert.match(deploymentStatePath(hqRoot, "app"), /different-repo-name\/deployments\/app\.json$/);
  assert.deepEqual(readDeploymentStatus({ hqRoot, projectKey: "app" }), {
    state: "deployed", productionUrl: "https://app.example", health: { ok: true, status: 200 },
    lastDeploymentAt: "2026-09-08T12:00:00.000Z", founderActionRequired: false,
  });
});

test("missing or malformed status never throws and can report a read warning", () => {
  const hqRoot = root();
  assert.equal(readDeploymentStatus({ hqRoot, projectKey: "unknown" }).state, "not_deployed");
  const path = deploymentStatePath(hqRoot, "app");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "not json");
  let warning = null;
  assert.equal(readDeploymentStatus({ hqRoot, projectKey: "app", onError: (error) => { warning = error; } }).state, "not_deployed");
  assert.ok(warning);
});

test("dashboard exposes a read-only project deployment route through the status projection", () => {
  const source = readFileSync(new URL("../../dashboard/backend/server.mjs", import.meta.url), "utf8");
  assert.match(source, /app\.get\("\/api\/hq\/projects\/:id\/deployment"/);
  assert.match(source, /readDeploymentStatus\(\{ hqRoot: ROOT, projectKey: req\.params\.id \}\)/);
  assert.doesNotMatch(source, /app\.(?:post|put|patch|delete)\("\/api\/hq\/projects\/:id\/deployment"/);
});
