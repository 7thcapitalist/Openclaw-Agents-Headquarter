import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  checkOpenAiSeat,
  checkCopilotFallback,
  checkSessions,
  checkAcpxAgents,
  checkFactoryActivity,
  checkGateway,
  runDoctor,
} from "../../scripts/factory-doctor.mjs";

test("checkOpenAiSeat flags cooldown and 0% as failure, low as warning, headroom as ok", () => {
  assert.equal(checkOpenAiSeat("openai:setup ... cooldown (3h)\nopenai usage: 5h 0% left ⏱3h 1m · Week 44% left").level, "fail");
  assert.equal(checkOpenAiSeat("openai usage: 5h 8% left ⏱2h · Week 40% left").level, "warn");
  assert.equal(checkOpenAiSeat("openai usage: 5h 73% left ⏱1h · Week 80% left").level, "ok");
});

test("checkCopilotFallback warns on the [indeterminate] readiness line", () => {
  assert.equal(checkCopilotFallback("- github-copilot/gpt-4.1 [indeterminate] Auth readiness could not be confirmed").level, "warn");
  assert.equal(checkCopilotFallback("Providers w/ OAuth/tokens (2): github-copilot (1), openai (1)").level, "ok");
  assert.equal(checkCopilotFallback("openai only").level, "warn");
});

test("checkSessions warns when many stale transient sessions exist", () => {
  const now = Date.now();
  const stale = Array.from({ length: 12 }, (_, i) => ({ key: `agent:x:factory-t${i}`, ageMs: 30 * 3600 * 1000, totalTokens: 1, contextTokens: 10 }));
  assert.equal(checkSessions(JSON.stringify({ sessions: stale })).level, "warn");
  const fresh = [{ key: "agent:main:main", ageMs: 1000, totalTokens: 1, contextTokens: 10 }];
  assert.equal(checkSessions(JSON.stringify({ sessions: fresh })).level, "ok");
  assert.equal(checkSessions("not json").level, "warn");
});

test("checkAcpxAgents warns when claude/codex are unmapped", () => {
  const only = JSON.stringify({ plugins: { entries: { acpx: { config: { agents: { cursor: { command: "x" } } } } } } });
  const r = checkAcpxAgents(only);
  assert.equal(r.level, "warn");
  assert.match(r.line, /claude, codex/);
  const all = JSON.stringify({ plugins: { entries: { acpx: { config: { agents: { cursor: {}, claude: {}, codex: {} } } } } } });
  assert.equal(checkAcpxAgents(all).level, "ok");
});

test("checkFactoryActivity warns when no state.json exists, ok when some do", () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-activity-"));
  assert.equal(checkFactoryActivity(root).level, "warn");
  mkdirSync(join(root, "dashboard/backend/data/factory/p/tasks/t1"), { recursive: true });
  writeFileSync(join(root, "dashboard/backend/data/factory/p/tasks/t1/state.json"), "{}");
  assert.equal(checkFactoryActivity(root).level, "ok");
});

test("checkGateway ok / warn / fail", () => {
  assert.equal(checkGateway("Runtime: running (pid 1)\nConnectivity probe: ok").level, "ok");
  assert.equal(checkGateway("Runtime: running (pid 1)").level, "warn");
  assert.equal(checkGateway("could not connect").level, "fail");
});

test("runDoctor composes all checks with an injected run fn", () => {
  const canned = {
    "daemon status": "Runtime: running\nConnectivity probe: ok",
    models: "openai usage: 5h 50% left · Week 60% left\ngithub-copilot (1)",
    "sessions --all-agents --json --limit all": JSON.stringify({ sessions: [] }),
  };
  const run = (args) => ({ ok: true, out: canned[args.join(" ")] ?? "" });
  const results = runDoctor({ run, configText: JSON.stringify({ plugins: { entries: { acpx: { config: { agents: { cursor: {} } } } } } }), hqRoot: mkdtempSync(join(tmpdir(), "doctor-compose-")) });
  assert.equal(results.length, 6);
  assert.equal(results.find((r) => r.line.includes("gateway")).level, "ok");
  assert.equal(results.find((r) => r.line.includes("OpenAI")).level, "ok");
});
