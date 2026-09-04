// Feature 8 — Chief of Staff preparation.
//
// This does NOT build the Chief of Staff agent. It defines and assembles the
// single input contract a future Chief of Staff will consume, so the agent can
// be dropped in later without re-plumbing: company state, project status, agent
// activity, founder decisions, learning findings, and GitHub activity.
//
// Pure composition over the Integration Layer. Read-only.

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { buildCompanyState } from "./company-state.mjs";

export const CHIEF_OF_STAFF_CONTRACT = "hq.chief-of-staff/1";

/**
 * @param {object}   input
 * @param {string}   input.hqRoot
 * @param {Array}   [input.tasks]        normalised factory task views
 * @param {Array}   [input.hqProjects]   dashboard HQ project rows
 * @param {boolean} [input.withGithub=false]
 * @param {Function}[input.exec]         gh runner (tests)
 * @param {Date}    [input.now]
 * @returns {Promise<object>} the Chief of Staff input contract
 */
export async function buildChiefOfStaffContext({
  hqRoot, tasks = [], hqProjects = [], withGithub = false, exec = undefined, now = new Date(),
}) {
  const state = await buildCompanyState({ hqRoot, tasks, hqProjects, withGithub, exec, now });

  const projectStatus = state.projects.map((p) => ({
    key: p.key,
    name: p.name,
    status: p.status,
    health: p.health ? { score: p.health.score, level: p.health.level } : null,
    phase: state.company?.projects?.find((c) => c.id === p.key)?.phase || null,
    activeTasks: p.activeTasks,
    blockedTasks: p.blockedTasks,
    openDecisions: (state.decisions || []).filter((d) => d.project === p.key).length,
    topRisk: (p.risks || []).slice().sort(bySeverity)[0] || null,
    externalSummary: p.externalSummary,
  }));

  const githubActivity = (state.external || []).map((e) => ({
    project: e.project,
    available: e.available,
    summary: e.summary,
    openPullRequests: (e.pullRequests || []).length,
    prsReadyForReview: (e.pullRequests || []).filter((pr) => !pr.isDraft).length,
    openIssues: (e.issues || []).length,
    latestCommit: e.commits?.[0] || null,
  }));

  return {
    generatedAt: state.generatedAt,
    contract: CHIEF_OF_STAFF_CONTRACT,
    founder: state.founder,
    company: { summary: state.summary, briefingSummary: state.company?.summary || null },
    projectStatus,
    agentActivity: state.agents,
    decisions: state.decisions || [],
    risks: state.risks || [],
    opportunities: state.opportunities || [],
    recommendedActions: state.recommendedActions || [],
    learningFindings: readLearningFindings(hqRoot),
    githubActivity,
    warnings: state.warnings || [],
  };
}

// The learning agent writes runtime findings under the dashboard data dir and a
// human digest alongside; the committed distilled knowledge lives in
// factory/knowledge/. Surface both, guarded.
export function readLearningFindings(hqRoot) {
  const root = resolve(hqRoot);
  const findingsPath = join(root, "dashboard", "backend", "data", "factory", "_learning", "findings.json");
  const digestPath = join(root, "dashboard", "backend", "data", "factory", "_learning", "digest.md");
  const knowledgeDir = join(root, "factory", "knowledge");

  let findings = [];
  let updatedAt = null;
  if (existsSync(findingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(findingsPath, "utf8"));
      findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
      updatedAt = parsed?.updatedAt || null;
    } catch {
      /* degrade silently — findings stay empty */
    }
  }

  return {
    count: findings.length,
    updatedAt,
    findings: findings.slice(0, 20),
    digestPath: existsSync(digestPath) ? digestPath : null,
    knowledgeDir: existsSync(knowledgeDir) ? knowledgeDir : null,
    knowledgeFiles: existsSync(knowledgeDir)
      ? ["LESSONS_LEARNED.md", "ENGINEERING_IMPROVEMENTS.md", "PROCESS_IMPROVEMENTS.md"].filter((f) =>
          existsSync(join(knowledgeDir, f))
        )
      : [],
  };
}

function bySeverity(a, b) {
  const rank = { high: 0, medium: 1, low: 2, unspecified: 3 };
  return (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);
}
