import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildCompanyContextSection, assembleAgentContext } from "../lib/hq/company-context.mjs";

function makeHq() {
  const hq = mkdtempSync(join(tmpdir(), "hq-company-context-"));
  mkdirSync(join(hq, "factory", "context"), { recursive: true });
  writeFileSync(join(hq, "factory", "factory.config.json"), JSON.stringify({ mode: "human-merge", prohibitedAutonomousActions: ["push-to-main"], requiredGates: ["independent-review"] }));
  writeFileSync(join(hq, "factory", "context", "FACTORY.md"), "# Factory\n\nThe factory ships software with operator control.\n");
  writeFileSync(
    join(hq, "factory", "projects.json"),
    JSON.stringify({ version: 1, projects: [{ key: "lifemaxing", name: "LifeMaxing", repo: ".", contextDir: "pctx" }] })
  );
  const company = join(hq, "context");
  mkdirSync(company, { recursive: true });
  writeFileSync(join(company, "ownership.json"), JSON.stringify({ version: 1, mission: "Build AI-native productivity tools." }));

  // The project's own committed context (worktree == repo == hq here).
  const pctx = join(hq, "pctx");
  mkdirSync(pctx, { recursive: true });
  writeFileSync(join(pctx, "MISSION.md"), "# Mission\n\nHelp users improve their lives.\n");
  writeFileSync(join(pctx, "ownership.json"), JSON.stringify({
    version: 1, mission: "Help users improve their lives.",
    successMetrics: [{ id: "m1", name: "DAU", target: "1000", current: "10" }],
    currentPriorities: [{ id: "p1", title: "Health integrations" }],
    risks: [], openDecisions: [],
  }));
  return hq;
}

const state = { repo: ".", worktree: null, task: { id: "preview", project: "lifemaxing", outcome: "(preview)" } };

test("the company section carries the company mission and isolation rule", () => {
  const hq = makeHq();
  const { text } = buildCompanyContextSection({ hqRoot: hq, state });
  assert.match(text, /## Company context/);
  assert.match(text, /Build AI-native productivity tools/);
  assert.match(text, /Project contexts are isolated/i);
});

test("project-scoped signals from company state appear; other projects never leak", () => {
  const hq = makeHq();
  const companyState = {
    projects: [
      { key: "lifemaxing", health: { level: "needs-attention", score: 62 }, intelligencePriorities: ["Health integrations"], risks: [{ title: "Privacy architecture undecided", unmitigated: true }] },
      { key: "campuscart", health: { level: "at-risk", score: 20 }, intelligencePriorities: ["Secret CampusCart plan"], risks: [{ title: "CampusCart-only risk", unmitigated: true }] },
    ],
    decisions: [
      { project: "lifemaxing", question: "Need answer about storage model" },
      { project: "campuscart", question: "CampusCart pricing decision" },
    ],
  };
  const { text } = buildCompanyContextSection({ hqRoot: hq, state, companyState });
  assert.match(text, /Current priority: Health integrations/);
  assert.match(text, /Privacy architecture undecided/);
  assert.match(text, /storage model/);
  assert.doesNotMatch(text, /CampusCart/);
  assert.doesNotMatch(text, /campuscart/);
});

test("assembleAgentContext prepends the company section and keeps the factory + project pack", () => {
  const hq = makeHq();
  const { text, sections } = assembleAgentContext({ hqRoot: hq, state });
  assert.ok(sections.company);
  assert.ok(sections.factory);
  assert.ok(sections.project);
  // Order: company first, then the existing pack.
  assert.ok(text.indexOf("## Company context") < text.indexOf("## Factory context"));
  assert.match(text, /Help users improve their lives|Project context: LifeMaxing/);
});
