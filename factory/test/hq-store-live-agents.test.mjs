import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readHqState } from "../../dashboard/backend/lib/hqStore.mjs";

function fixture({ withRegistry = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hqstore-live-"));
  mkdirSync(join(root, "factory"), { recursive: true });
  mkdirSync(join(root, "dashboard", "backend", "data", "hq"), { recursive: true });
  for (const f of ["tasks", "agents", "sops", "reports", "logs"]) {
    writeFileSync(join(root, "dashboard", "backend", "data", "hq", `${f}.json`), "[]");
  }
  writeFileSync(join(root, "dashboard", "backend", "data", "hq", "projects.json"), "[]");
  if (withRegistry) {
    writeFileSync(join(root, "factory", "agents.json"), JSON.stringify({
      version: 1,
      agents: [
        { id: "chief-of-staff", name: "Chief of Staff Agent", role: "Orchestration", harness: "openclaw", runtimeAgentId: "main", reportsTo: "founder" },
        { id: "reviewer", name: "Reviewer Agent", role: "Independent review", harness: "multiple", runtimeAgentId: "reviewer", reportsTo: "chief-of-staff" },
      ],
    }));
  }
  return root;
}

test("readHqState surfaces the real workforce roster, not the empty seed collection", () => {
  const state = readHqState(fixture());
  assert.equal(state.agents.length, 2);
  const ids = state.agents.map((a) => a.id).sort();
  assert.deepEqual(ids, ["chief-of-staff", "reviewer"]);
  assert.equal(state.commandCenter.stats.agents, 2);
  // reportsTo edges still drive the tree
  const cos = state.agents.find((a) => a.id === "chief-of-staff");
  assert.ok(Array.isArray(cos.directReports) && cos.directReports.includes("reviewer"));
  // each row carries a derived status
  assert.ok(state.agents.every((a) => typeof a.status === "string"));
});

test("readHqState falls back to the seed collection when no registry exists", () => {
  const state = readHqState(fixture({ withRegistry: false }));
  assert.deepEqual(state.agents, []);
  assert.equal(state.commandCenter.stats.agents, 0);
});
