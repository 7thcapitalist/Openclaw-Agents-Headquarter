import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildChiefOfStaffContext, readLearningFindings, CHIEF_OF_STAFF_CONTRACT } from "../lib/hq/chief-of-staff.mjs";

function makeHq({ withLearning = false } = {}) {
  const hq = mkdtempSync(join(tmpdir(), "hq-cos-"));
  mkdirSync(join(hq, "factory"), { recursive: true });
  writeFileSync(
    join(hq, "factory", "projects.json"),
    JSON.stringify({ version: 1, projects: [{ key: "lifemaxing", name: "LifeMaxing", repo: "/tmp/hq-cos-nope", contextDir: "context" }] })
  );
  writeFileSync(
    join(hq, "factory", "agents.json"),
    JSON.stringify({ version: 1, agents: [{ id: "codex-builder", name: "Codex", kind: "codex", role: "Builder", harnessAgentIds: ["backend-builder"] }] })
  );
  if (withLearning) {
    const dir = join(hq, "dashboard", "backend", "data", "factory", "_learning");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "findings.json"), JSON.stringify({ version: 1, updatedAt: "2026-09-04T00:00:00Z", findings: [{ id: 1, title: "Prefer node:test" }] }));
    writeFileSync(join(dir, "digest.md"), "# Digest\n");
  }
  return hq;
}

test("buildChiefOfStaffContext returns the documented input contract", async () => {
  const hq = makeHq();
  const ctx = await buildChiefOfStaffContext({ hqRoot: hq, tasks: [] });

  assert.equal(ctx.contract, CHIEF_OF_STAFF_CONTRACT);
  for (const key of ["company", "projectStatus", "agentActivity", "decisions", "risks", "recommendedActions", "learningFindings", "githubActivity"]) {
    assert.ok(key in ctx, `missing ${key}`);
  }
  assert.equal(ctx.projectStatus[0].key, "lifemaxing");
  assert.ok(Array.isArray(ctx.agentActivity.agents));
  assert.equal(ctx.agentActivity.agents[0].id, "codex-builder");
});

test("projectStatus carries health, tasks, and open-decision counts", async () => {
  const hq = makeHq();
  const tasks = [
    { id: "t-1", project: "lifemaxing", stage: "architect", agent: "architect", status: "blocked", blocker: { outcome: "decision-required", stage: "architect", summary: "storage" }, updatedAt: "2026-09-03T00:00:00Z" },
  ];
  const ctx = await buildChiefOfStaffContext({ hqRoot: hq, tasks });
  const lm = ctx.projectStatus.find((p) => p.key === "lifemaxing");
  assert.equal(lm.openDecisions, 1);
  assert.equal(lm.blockedTasks.length, 1);
  assert.ok(lm.health && typeof lm.health.score === "number");
});

test("readLearningFindings surfaces runtime findings and committed knowledge", () => {
  const withL = readLearningFindings(makeHq({ withLearning: true }));
  assert.equal(withL.count, 1);
  assert.equal(withL.findings[0].title, "Prefer node:test");
  assert.ok(withL.digestPath);

  const without = readLearningFindings(makeHq());
  assert.equal(without.count, 0);
  assert.equal(without.digestPath, null);
});
