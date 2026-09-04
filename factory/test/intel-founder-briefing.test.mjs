import test from "node:test";
import assert from "node:assert/strict";
import { buildCompanyBriefing } from "../lib/intel/founder-briefing.mjs";

function brief(overrides = {}) {
  return {
    key: "acme", name: "Acme", registered: true, status: "active",
    mission: "Remove busywork.", roadmap: { current: "Milestone A. Blocker: none.", next: ["Billing"], later: [], deferred: [] },
    decisions: [], memory: [], contextFindings: [],
    ownership: { successMetrics: [{ id: "m1", name: "D30", current: "22%", target: "35%" }], currentPriorities: [{ id: "p1", title: "Scheduling" }], risks: [], openDecisions: [], responsibleAgents: {} },
    risks: [],
    ...overrides,
  };
}

test("a clean project with no tasks scores healthy", () => {
  const out = buildCompanyBriefing({ briefs: [brief()], projects: [{ id: "acme", name: "Acme", tasks: [] }] });
  assert.equal(out.projects[0].health.level, "healthy");
  assert.equal(out.projects[0].health.score, 100);
  assert.equal(out.summary.healthy, 1);
});

test("blocked task + unmitigated high risk + open strategic decision drags health to at-risk", () => {
  const b = brief({
    risks: [{ id: "r1", title: "No load testing", severity: "high", unmitigated: true, mitigation: "", owner: "" }],
    ownership: { ...brief().ownership, openDecisions: ["ACM-2026-014", "ACM-2026-015"] },
  });
  const projects = [{
    id: "acme", name: "Acme",
    tasks: [{ id: "t1", status: "blocked", blocker: { outcome: "decision-required" }, objective: "add billing" }],
  }];
  const taskDecisions = [{ id: "t1:product", taskId: "t1", project: "acme", statePath: "/s/t1/state.json", question: "Which billing provider?", why: "Spend + vendor lock-in." }];
  const out = buildCompanyBriefing({ briefs: [b], projects, taskDecisions });

  const p = out.projects[0];
  assert.equal(p.health.level, "at-risk");
  assert.ok(p.health.score < 55);
  assert.ok(p.health.reasons.some((r) => /blocked task/.test(r.reason)));
  assert.ok(p.health.reasons.some((r) => /unmitigated high risk/.test(r.reason)));
  assert.ok(p.health.reasons.some((r) => /strategic decision/.test(r.reason)));
  assert.equal(p.openDecisionCount, 3); // 1 task-blocker + 2 strategic
});

test("recommended actions rank founder decisions first, then risks, then context, then opportunities", () => {
  const b = brief({
    risks: [{ id: "r1", title: "No load testing", severity: "high", unmitigated: true, mitigation: "", owner: "" }],
    contextFindings: [{ code: "missing", file: "MISSION.md", severity: "error", message: "gone" }],
    ownership: { ...brief().ownership, successMetrics: [{ id: "m1", name: "signups", current: "120", target: "100" }] },
  });
  const projects = [{ id: "acme", name: "Acme", tasks: [] }];
  const taskDecisions = [{ id: "t1:product", taskId: "t1", project: "acme", statePath: "/s/t1/state.json", question: "Pick storage", why: "Privacy posture." }];
  const out = buildCompanyBriefing({ briefs: [b], projects, taskDecisions });

  const kinds = out.recommendedActions.map((a) => a.kind);
  assert.equal(kinds[0], "decision");
  assert.ok(out.recommendedActions[0].ref.statePath === "/s/t1/state.json");
  assert.ok(kinds.indexOf("risk") < kinds.indexOf("opportunity"));
  assert.ok(kinds.includes("context"));
  // metric already past target surfaces as an opportunity
  assert.ok(out.opportunities.some((o) => o.kind === "metric-at-target"));
});

test("an idle priority with no task in flight is an opportunity", () => {
  const out = buildCompanyBriefing({
    briefs: [brief()],
    projects: [{ id: "acme", name: "Acme", tasks: [] }],
  });
  assert.ok(out.opportunities.some((o) => o.kind === "idle-priority" && /Scheduling/.test(o.detail)));
});

test("risks and opportunities stay tagged to their own project", () => {
  const acme = brief({ key: "acme", name: "Acme", risks: [{ id: "r1", title: "Acme risk", severity: "high", unmitigated: true }] });
  const beta = brief({ key: "beta", name: "Beta", ownership: { successMetrics: [], currentPriorities: [{ id: "p9", title: "Beta thing" }], risks: [], openDecisions: [], responsibleAgents: {} }, risks: [] });
  const out = buildCompanyBriefing({
    briefs: [acme, beta],
    projects: [{ id: "acme", name: "Acme", tasks: [] }, { id: "beta", name: "Beta", tasks: [] }],
  });
  assert.ok(out.risks.every((r) => r.project === "acme"));
  assert.ok(out.opportunities.some((o) => o.project === "beta" && /Beta thing/.test(o.detail)));
  assert.equal(out.summary.projectCount, 2);
});
