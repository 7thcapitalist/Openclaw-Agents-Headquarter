import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { validateRegistry } from "../lib/intel/schema.mjs";
import { listCompanyProjects, resolveCompanyProject } from "../lib/hq/registry.mjs";

function makeHq(projects, contextFiles = null) {
  const hq = mkdtempSync(join(tmpdir(), "hq-registry-"));
  mkdirSync(join(hq, "factory"), { recursive: true });
  writeFileSync(join(hq, "factory", "projects.json"), JSON.stringify({ version: 1, projects }));
  if (contextFiles) {
    const dir = join(hq, "context");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(contextFiles)) writeFileSync(join(dir, name), body);
  }
  return hq;
}

test("validateRegistry accepts the integration-layer optional fields", () => {
  const value = {
    version: 1,
    projects: [
      {
        key: "lifemaxing",
        name: "LifeMaxing",
        repo: "~/projects/lifemaxing",
        mission: "Help users improve their lives.",
        owner: "founder",
        github: { owner: "acme", repo: "lifemaxing" },
        responsibleAgents: ["claude-main", "codex-builder"],
      },
    ],
  };
  assert.equal(validateRegistry(value), value);
});

test("validateRegistry rejects malformed integration-layer fields", () => {
  assert.throws(
    () => validateRegistry({ version: 1, projects: [{ key: "a", repo: ".", github: { owner: "x" } }] }),
    /github must be/
  );
  assert.throws(
    () => validateRegistry({ version: 1, projects: [{ key: "a", repo: ".", responsibleAgents: "claude" }] }),
    /responsibleAgents must be an array/
  );
  assert.throws(
    () => validateRegistry({ version: 1, projects: [{ key: "a", repo: ".", mission: 5 }] }),
    /mission must be a string/
  );
});

test("a plain legacy entry still validates (backward compatible)", () => {
  const value = { version: 1, projects: [{ key: "openclaw-factory", repo: ".", contextDir: "context", status: "active" }] };
  assert.equal(validateRegistry(value), value);
});

test("listCompanyProjects composes registry + brief + dashboard row", () => {
  const hq = makeHq(
    [{ key: "openclaw-factory", name: "Factory", repo: ".", contextDir: "context", owner: "founder" }],
    {
      "MISSION.md": "# Mission\n\nShip the context layer this quarter.\n",
      "ownership.json": JSON.stringify({
        version: 1,
        mission: "Give every project a durable intelligence layer.",
        successMetrics: [{ id: "m1", name: "coverage", target: "100%", current: "40%" }],
        currentPriorities: [{ id: "p1", title: "Land Phase 1" }],
        risks: [{ id: "r1", title: "context bloat", severity: "medium" }],
        openDecisions: [],
        responsibleAgents: {},
      }),
    }
  );
  const hqProjects = [{ id: "openclaw-factory", name: "Factory (dashboard)", currentPhase: "Discovery", mission: "dash mission" }];
  const { projects, warnings } = listCompanyProjects({ hqRoot: hq, hqProjects });

  assert.equal(warnings.length, 0);
  assert.equal(projects.length, 1);
  const p = projects[0];
  assert.equal(p.key, "openclaw-factory");
  assert.equal(p.registered, true);
  assert.equal(p.repoExists, true);
  assert.equal(p.mission, "Give every project a durable intelligence layer.");
  assert.equal(p.dashboard.currentPhase, "Discovery");
  assert.equal(p.hasContext, true);
  assert.equal(p.risks.length, 1);
});

test("an unresolved / broken registry surfaces a warning, not a throw", () => {
  const hq = mkdtempSync(join(tmpdir(), "hq-registry-bad-"));
  mkdirSync(join(hq, "factory"), { recursive: true });
  writeFileSync(join(hq, "factory", "projects.json"), JSON.stringify({ version: 1, projects: [{ key: "BAD KEY", repo: "." }] }));
  const { projects, warnings } = listCompanyProjects({ hqRoot: hq });
  assert.deepEqual(projects, []);
  assert.equal(warnings[0].code, "registry-invalid");
});

test("resolveCompanyProject returns one project by key", () => {
  const hq = makeHq([{ key: "lifemaxing", repo: "/tmp/does-not-exist-lm", name: "LifeMaxing" }]);
  const p = resolveCompanyProject(hq, "lifemaxing");
  assert.equal(p.name, "LifeMaxing");
  assert.equal(p.repoExists, false);
  assert.equal(resolveCompanyProject(hq, "nope"), null);
});
