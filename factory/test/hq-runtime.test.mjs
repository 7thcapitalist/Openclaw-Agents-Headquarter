import test from "node:test";
import assert from "node:assert/strict";
import {
  readOpenclawRuntime,
  cleanModel,
  readOpenclawActivity,
  normalizeAuditEvent,
  deriveAgentActivity,
  reconcileRoster,
} from "../lib/hq/runtime.mjs";

test("cleanModel strips the credential-profile suffix", () => {
  assert.equal(cleanModel("openai/gpt-5.6-sol@openai:setup-abc"), "openai/gpt-5.6-sol");
  assert.equal(cleanModel("claude/opus"), "claude/opus");
  assert.equal(cleanModel(null), null);
});

test("readOpenclawRuntime parses `openclaw agents list --json` and degrades when offline", async () => {
  const ok = await readOpenclawRuntime({
    exec: async (args) => {
      assert.deepEqual(args, ["agents", "list", "--json"]);
      return { stdout: JSON.stringify([{ id: "architect", identityName: "Principal Architect", model: "openai/gpt-5.6-sol@x" }]), stderr: "", code: 0 };
    },
  });
  assert.equal(ok.available, true);
  assert.equal(ok.agents[0].id, "architect");
  assert.equal(ok.agents[0].model, "openai/gpt-5.6-sol");

  const offline = await readOpenclawRuntime({ exec: async () => ({ stdout: "", stderr: "not found", code: 127 }) });
  assert.equal(offline.available, false);
  assert.match(offline.error, /not found/);

  const disabled = await readOpenclawRuntime({ enabled: false });
  assert.equal(disabled.available, false);
});

test("readOpenclawActivity parses `openclaw audit` agent_run events into per-agent activity", async () => {
  const events = [
    { agentId: "architect", occurredAt: 3000, runId: "r2", action: "agent.run.started", status: "started" },
    { agentId: "reviewer", occurredAt: 2000, runId: "r1", action: "agent.run.started", status: "started" },
    { agentId: "reviewer", occurredAt: 2500, runId: "r1", action: "agent.run.finished", status: "failed", errorCode: "run_failed" },
  ];
  const result = await readOpenclawActivity({
    exec: async (args) => {
      assert.deepEqual(args, ["audit", "--json", "--kind", "agent_run", "--limit", "200"]);
      return { stdout: JSON.stringify({ events, nextCursor: null }), stderr: "", code: 0 };
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.byAgent.architect.running, true, "a started run with no finished event is still running");
  assert.equal(result.byAgent.reviewer.running, false);
  assert.equal(result.byAgent.reviewer.lastRun.status, "failed");
});

test("normalizeAuditEvent rejects malformed rows instead of throwing", () => {
  assert.equal(normalizeAuditEvent(null), null);
  assert.equal(normalizeAuditEvent({ agentId: "x" }), null); // missing occurredAt
  assert.equal(normalizeAuditEvent({ occurredAt: 1 }), null); // missing agentId
  const ok = normalizeAuditEvent({ agentId: "main", occurredAt: 1000, action: "agent.run.started", status: "started", runId: "r1" });
  assert.equal(ok.agentId, "main");
  assert.equal(ok.at, 1000);
});

test("deriveAgentActivity: a run with only a started event is running; a finished run is not", () => {
  const events = [
    normalizeAuditEvent({ agentId: "main", occurredAt: 100, runId: "r1", action: "agent.run.started", status: "started" }),
    normalizeAuditEvent({ agentId: "main", occurredAt: 200, runId: "r1", action: "agent.run.finished", status: "succeeded" }),
    normalizeAuditEvent({ agentId: "product", occurredAt: 150, runId: "r2", action: "agent.run.started", status: "started" }),
  ];
  const byAgent = deriveAgentActivity(events);
  assert.equal(byAgent.main.running, false);
  assert.equal(byAgent.main.lastRun.status, "succeeded");
  assert.equal(byAgent.product.running, true);
  assert.equal(byAgent.product.lastRun.status, "running");
  assert.equal(byAgent.product.lastActivityAt, new Date(150).toISOString());
});

test("reconcileRoster flags a role whose runtimeAgentId does not exist live, and lists unmapped runtime agents", () => {
  const agents = [
    { id: "architect", role: "Technical design", runtimeAgentId: "architect" },
    { id: "learning-agent", role: "Continuous improvement", runtimeAgentId: "learning" },
    { id: "research", role: "Discovery & research", runtimeAgentId: null },
  ];
  const runtime = { available: true, agents: [{ id: "architect" }, { id: "cursor" }] };
  const { roles, unmapped } = reconcileRoster(agents, runtime);

  const architect = roles.find((r) => r.agentId === "architect");
  assert.equal(architect.resolved, true);

  const learning = roles.find((r) => r.agentId === "learning-agent");
  assert.equal(learning.resolved, false, "no live OpenClaw agent named 'learning' in this fixture");

  const research = roles.find((r) => r.agentId === "research");
  assert.equal(research.runtimeAgentId, null);
  assert.equal(research.resolved, false);

  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].id, "cursor");
});
