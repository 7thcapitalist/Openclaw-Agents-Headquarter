import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildProjectBrief, listProjectBriefs, parseDecisions, parseRoadmap } from "../lib/intel/project-brief.mjs";

function makeHq(projects) {
  const hq = mkdtempSync(join(tmpdir(), "intel-brief-hq-"));
  mkdirSync(join(hq, "factory"), { recursive: true });
  writeFileSync(join(hq, "factory", "projects.json"), JSON.stringify({ version: 1, projects }));
  return hq;
}

function writeContext(hq, dir, files) {
  const base = join(hq, dir);
  mkdirSync(base, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(base, name), body);
  return base;
}

const acmeFiles = {
  "PROJECT.md": "# Acme\n\nAcme helps teams ship.\n",
  "VISION.md": "# Vision\n\nAcme removes busywork.\n\n## The bet\n\nOwn scheduling for small teams.\n\n## Non-goals\n\n- Not an enterprise suite.\n- Not a CRM.\n",
  "MISSION.md": "# Mission\n\nShip the scheduling module this quarter.\n",
  "ROADMAP.md": "# Roadmap\n\n## Current milestone\n\nScheduling module. Blocker: none.\n\n## Next\n\n1. Billing\n2. Mobile app\n\n## Deferred\n\n- SSO\n",
  "DECISIONS.md": "# Decisions\n\n## ACM-2026-001 — Use SQLite\n\n- Date: 2026-08-01\n- Status: Accepted\n- Decision: SQLite for v1 storage.\n\n## ACM-2026-002 — No third-party auth\n\n- Date: 2026-08-10\n- Status: Accepted\n- Decision: Roll our own session auth.\n",
  "MEMORY.md": "# Project memory\n\n- Vendor sandbox rate-limits to 5 req/s.\n- Webhooks replay out of order.\n",
  "TECH_CONTEXT.md": "# Tech context\n\n## Constraints\n\n- No ORM; queries are hand-written in db/.\n- Node builtins only in the core library.\n- Do not weaken the ./run.sh execution boundary.\n",
  "USERS.md": "# Users\n\nSmall team leads.\n\n## Sensitivities\n\nCalendar data is private.\n",
  "COMPETITIVE_CONTEXT.md": "# Competitive context\n\n## Our wedge\n\nScheduling without a login wall.\n",
  "ownership.json": JSON.stringify({
    version: 1,
    mission: "Remove busywork for small teams.",
    successMetrics: [{ id: "m1", name: "D30 retention", target: "35%", current: "22%", asOf: "2026-08-20" }],
    currentPriorities: [{ id: "p1", title: "Scheduling module" }],
    risks: [
      { id: "r1", title: "No load testing", severity: "high" },
      { id: "r2", title: "Vendor lock-in", severity: "medium", mitigation: "Abstract the client", owner: "architect" },
    ],
    openDecisions: ["ACM-2026-014"],
    responsibleAgents: { architect: "claude", builder: "codex" },
  }),
};

test("a full context directory produces a structured brief", () => {
  const hq = makeHq([{ key: "acme", name: "Acme", repo: ".", contextDir: "context" }]);
  writeContext(hq, "context", acmeFiles);
  const brief = buildProjectBrief({ hqRoot: hq, key: "acme" });

  assert.equal(brief.registered, true);
  assert.equal(brief.mission, "Remove busywork for small teams.");
  assert.match(brief.missionDetail, /scheduling module this quarter/i);
  assert.equal(brief.vision.nonGoals.length, 2);
  assert.match(brief.vision.bet, /Own scheduling/);
  assert.match(brief.roadmap.current, /Scheduling module\. Blocker: none\./);
  assert.deepEqual(brief.roadmap.next, ["Billing", "Mobile app"]);
  assert.deepEqual(brief.roadmap.deferred, ["SSO"]);
  assert.equal(brief.decisions.length, 2);
  assert.equal(brief.decisions[0].id, "ACM-2026-002");
  assert.equal(brief.decisions[0].title, "No third-party auth");
  assert.match(brief.decisions[0].summary, /session auth/);
  assert.equal(brief.memory.length, 2);
  assert.match(brief.memory[0], /rate-limits to 5 req\/s/);
  assert.equal(brief.ownership.openDecisions[0], "ACM-2026-014");
  assert.equal(brief.risks.length, 2);
  const r1 = brief.risks.find((r) => r.id === "r1");
  assert.equal(r1.unmitigated, true);
  const r2 = brief.risks.find((r) => r.id === "r2");
  assert.equal(r2.unmitigated, false);
  assert.deepEqual(brief.contextFindings, []);
});

test("missing files degrade to warnings and findings, never throw", () => {
  const hq = makeHq([{ key: "acme", repo: ".", contextDir: "context" }]);
  writeContext(hq, "context", { "PROJECT.md": "# Acme\n\nOnly this.\n" });
  const brief = buildProjectBrief({ hqRoot: hq, key: "acme" });
  assert.equal(brief.registered, true);
  assert.equal(brief.mission, null);
  assert.equal(brief.ownership, null);
  assert.ok(brief.warnings.some((w) => w.code === "ownership-missing"));
  assert.ok(brief.contextFindings.some((f) => f.file === "VISION.md" && f.code === "missing"));
  assert.ok(brief.contextFindings.some((f) => f.file === "ownership.json" && f.severity === "error"));
});

test("an unregistered key returns an unregistered brief without throwing", () => {
  const hq = makeHq([{ key: "acme", repo: ".", contextDir: "context" }]);
  const brief = buildProjectBrief({ hqRoot: hq, key: "ghost" });
  assert.equal(brief.registered, false);
  assert.equal(brief.mission, null);
  assert.deepEqual(brief.decisions, []);
});

test("secrets in a context file are scrubbed out of the brief", () => {
  const hq = makeHq([{ key: "acme", repo: ".", contextDir: "context" }]);
  writeContext(hq, "context", {
    ...acmeFiles,
    "TECH_CONTEXT.md": "# Tech context\n\n## Constraints\n\n- Rotate key sk-abcdefghijklmnopqrstuvwxyz012345 monthly.\n",
  });
  const brief = buildProjectBrief({ hqRoot: hq, key: "acme" });
  assert.ok(!JSON.stringify(brief).includes("sk-abcdefghijklmnopqrstuvwxyz012345"));
  assert.match(brief.techContext, /\[redacted: openai-sk\]/);
  assert.ok(brief.warnings.some((w) => w.code === "secret-redacted"));
});

test("project context does not leak between projects", () => {
  const hq = makeHq([
    { key: "acme", repo: "acme-repo", contextDir: "context" },
    { key: "beta", repo: "beta-repo", contextDir: "context" },
  ]);
  writeContext(hq, "acme-repo/context", acmeFiles);
  writeContext(hq, "beta-repo/context", {
    "PROJECT.md": "# Beta\n\nBeta is a secret skunkworks.\n",
    "ownership.json": JSON.stringify({ version: 1, mission: "Beta mission only.", risks: [] }),
  });
  const acme = buildProjectBrief({ hqRoot: hq, key: "acme" });
  const beta = buildProjectBrief({ hqRoot: hq, key: "beta" });
  assert.equal(acme.mission, "Remove busywork for small teams.");
  assert.equal(beta.mission, "Beta mission only.");
  assert.ok(!JSON.stringify(acme).includes("skunkworks"));
  assert.ok(!JSON.stringify(beta).includes("busywork"));
});

test("listProjectBriefs returns one brief per registered project", () => {
  const hq = makeHq([
    { key: "acme", repo: "acme-repo", contextDir: "context" },
    { key: "beta", repo: "beta-repo", contextDir: "context" },
  ]);
  writeContext(hq, "acme-repo/context", acmeFiles);
  const { briefs } = listProjectBriefs({ hqRoot: hq });
  assert.equal(briefs.length, 2);
  assert.deepEqual(briefs.map((b) => b.key).sort(), ["acme", "beta"]);
});

test("parseDecisions and parseRoadmap are usable standalone", () => {
  const decisions = parseDecisions("## AB-2026-001 — First\n\n- Status: Accepted\n\n## Plain heading\n");
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].title, "Plain heading");
  const roadmap = parseRoadmap("## Current milestone\n\nDoing X.\n\n## Next\n\n- Y\n- Z\n");
  assert.match(roadmap.current, /Doing X/);
  assert.deepEqual(roadmap.next, ["Y", "Z"]);
});
