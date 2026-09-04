import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildCompanyState } from "../lib/hq/company-state.mjs";

function makeHq() {
  const hq = mkdtempSync(join(tmpdir(), "hq-company-state-"));
  mkdirSync(join(hq, "factory"), { recursive: true });
  writeFileSync(
    join(hq, "factory", "projects.json"),
    JSON.stringify({
      version: 1,
      projects: [
        { key: "openclaw-factory", name: "Factory", repo: ".", contextDir: "context", github: { owner: "acme", repo: "factory" } },
        { key: "lifemaxing", name: "LifeMaxing", repo: "/tmp/hq-cs-nope", contextDir: "context" },
      ],
    })
  );
  writeFileSync(
    join(hq, "factory", "agents.json"),
    JSON.stringify({
      version: 1,
      agents: [
        { id: "claude-main", name: "Claude", kind: "claude", role: "Architecture", harnessAgentIds: ["architect"] },
        { id: "codex-builder", name: "Codex", kind: "codex", role: "Builder", harnessAgentIds: ["backend-builder"] },
      ],
    })
  );
  const ctx = join(hq, "context");
  mkdirSync(ctx, { recursive: true });
  writeFileSync(join(ctx, "MISSION.md"), "# Mission\n\nBuild AI-native productivity tools.\n");
  writeFileSync(
    join(ctx, "ownership.json"),
    JSON.stringify({
      version: 1,
      mission: "Build AI-native productivity tools.",
      successMetrics: [{ id: "m1", name: "coverage", target: "100%", current: "50%" }],
      currentPriorities: [{ id: "p1", title: "Health integrations" }],
      risks: [{ id: "r1", title: "Privacy architecture undecided", severity: "high" }],
      openDecisions: ["OPS-2026-002"],
      responsibleAgents: {},
    })
  );
  return hq;
}

const tasks = [
  { id: "t-1", objective: "Add endpoint", project: "openclaw-factory", stage: "builder", agent: "backend-builder", agentStatus: "running", status: "active", updatedAt: "2026-09-03T10:00:00Z" },
  { id: "t-2", objective: "Storage model", project: "lifemaxing", stage: "architect", agent: "architect", agentStatus: "blocked", status: "blocked", blocker: { outcome: "decision-required", stage: "architect", summary: "local vs remote storage", at: "2026-09-03T09:00:00Z" }, risk: "high", statePath: "/tmp/state.json", updatedAt: "2026-09-03T09:00:00Z" },
];

test("buildCompanyState composes projects, agents, decisions and a summary", async () => {
  const hq = makeHq();
  const state = await buildCompanyState({ hqRoot: hq, tasks });

  assert.equal(state.founder.headquarters, "OpenClaw Agents Headquarter");
  assert.equal(state.projects.length, 2);
  assert.equal(state.summary.projects, 2);
  assert.equal(state.summary.agents, 2);

  const factory = state.projects.find((p) => p.key === "openclaw-factory");
  assert.equal(factory.activeTasks.length, 1);
  assert.equal(factory.hasContext, true);

  const lm = state.projects.find((p) => p.key === "lifemaxing");
  assert.equal(lm.repoExists, false);
  assert.equal(lm.blockedTasks.length, 1);

  // The architect blocker is a founder decision (plus the strategic open
  // decision carried in the company ownership.json).
  const blocker = state.decisions.find((d) => d.kind === "task-blocker");
  assert.ok(blocker, "expected a task-blocker decision");
  assert.match(blocker.question, /local vs remote storage/);
  assert.ok(state.summary.openDecisions >= 1);

  // Agent activity is folded in.
  const codex = state.agents.agents.find((a) => a.id === "codex-builder");
  assert.equal(codex.status, "working");
  const claude = state.agents.agents.find((a) => a.id === "claude-main");
  assert.equal(claude.status, "blocked");
  assert.equal(state.summary.blockedAgents, 1);
});

test("withGithub pulls read-only awareness through the injected exec", async () => {
  const hq = makeHq();
  const exec = async (args) => {
    const joined = args.join(" ");
    if (joined === "auth status") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "repo" && args[1] === "view") return { stdout: JSON.stringify({ name: "factory", defaultBranchRef: { name: "main" } }), stderr: "", code: 0 };
    if (args[0] === "api" && /commits/.test(joined)) return { stdout: JSON.stringify([{ sha: "deadbeef00", commit: { message: "init", author: { name: "founder", date: "2026-09-01T00:00:00Z" } } }]), stderr: "", code: 0 };
    if (args[0] === "api" && /branches/.test(joined)) return { stdout: "[]", stderr: "", code: 0 };
    if (args[0] === "pr") return { stdout: "[]", stderr: "", code: 0 };
    if (args[0] === "issue") return { stdout: "[]", stderr: "", code: 0 };
    return { stdout: "", stderr: "no", code: 1 };
  };
  const state = await buildCompanyState({ hqRoot: hq, tasks: [], withGithub: true, exec });
  assert.equal(state.external.length, 1);
  assert.equal(state.external[0].project, "openclaw-factory");
  assert.equal(state.external[0].available, true);
  assert.equal(state.external[0].commits[0].message, "init");
});

test("a broken registry degrades to an empty project list plus a warning", async () => {
  const hq = mkdtempSync(join(tmpdir(), "hq-cs-bad-"));
  mkdirSync(join(hq, "factory"), { recursive: true });
  writeFileSync(join(hq, "factory", "projects.json"), JSON.stringify({ version: 1, projects: [{ key: "BAD KEY", repo: "." }] }));
  const state = await buildCompanyState({ hqRoot: hq, tasks: [] });
  assert.deepEqual(state.projects, []);
  assert.ok(state.warnings.some((w) => w.code === "registry-invalid"));
});
