// Deployment status across every registered project, in one read.
//
// The per-project route (/api/hq/projects/:id/deployment) answers for one
// project and needs the caller to already know which. The Today view needs the
// opposite: the whole estate at a glance, so a failed deploy or a project
// waiting on the founder is visible without opening anything.
//
// Read-only, like the per-project route it aggregates. Deploying is a gated
// factory action (`production-deploy` is in prohibitedAutonomousActions and a
// real deploy needs allowRealDeploy); nothing here can start, retry or roll back
// one, and there is deliberately no write route beside it.

import { readRegistry } from "../intel/registry.mjs";
import { readDeploymentStatus } from "../deploy/status.mjs";

export const DEPLOYMENTS_CONTRACT = "hq.deployments/1";

// Every state factory/lib/deploy/ can persist. `unknown` is not one of them —
// it exists so a value this module does not recognise is reported as
// unrecognised rather than silently bucketed as healthy.
const KNOWN_STATES = new Set(["deployed", "failed", "not_deployed"]);

export function buildDeploymentsSnapshot({ hqRoot, now = new Date().toISOString() } = {}) {
  const warnings = [];

  let projects = [];
  try {
    projects = readRegistry(hqRoot)?.projects || [];
  } catch (error) {
    warnings.push(`project registry unavailable: ${error.message}`);
  }

  const deployments = [];
  for (const project of projects) {
    const key = project?.key;
    if (!key) continue;
    // A project that has never deployed is a normal, common state and must not
    // read as a failure; readDeploymentStatus already returns not_deployed for
    // a missing record, and an unreadable one is surfaced as a warning.
    const status = readDeploymentStatus({
      hqRoot, projectKey: key,
      onError: (error) => warnings.push(`${key}: deployment record unreadable (${error.message})`),
    });
    const state = KNOWN_STATES.has(status.state) ? status.state : "unknown";
    deployments.push({
      projectKey: key,
      name: project.name || key,
      kind: project.kind || null,
      state,
      // Whether this row is the Headquarters rather than a company project.
      //
      // company-state deliberately excludes the headquarters entry ("company
      // projects only — never the Headquarters") while this panel included it,
      // so one snapshot reported 1 project and 2 for the same registry. Neither
      // was wrong; they were answering different questions and neither said so.
      // Flagging the row lets the console reconcile them.
      isHeadquarters: project.kind === "headquarters",
      // A URL the registry declares is better than nothing when the release
      // stage has never written a deployment record — which is the case for
      // every project here today.
      productionUrl: status.productionUrl || project.productionUrl || null,
      productionUrlSource: status.productionUrl ? "deployment-record" : project.productionUrl ? "registry" : null,
      health: status.health || null,
      lastDeploymentAt: status.lastDeploymentAt || null,
      founderActionRequired: Boolean(status.founderActionRequired),
    });
  }

  // Ordered by what needs a human first, then by name, so the list does not
  // reshuffle between reads and the top of it is always the actionable end.
  const rank = (d) => (d.founderActionRequired ? 0 : d.state === "failed" ? 1 : d.state === "unknown" ? 2 : d.state === "deployed" ? 3 : 4);
  deployments.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  const count = (predicate) => deployments.filter(predicate).length;
  return {
    version: 1,
    contract: DEPLOYMENTS_CONTRACT,
    asOf: now,
    available: true,
    readOnly: true,
    summary: {
      // Counts company projects, matching company-state's definition. The
      // headquarters is counted separately rather than folded in, so the two
      // panels can no longer disagree about how many projects exist.
      projects: deployments.filter((d) => !d.isHeadquarters).length,
      infrastructure: deployments.filter((d) => d.isHeadquarters).length,
      deployed: count((d) => d.state === "deployed"),
      failed: count((d) => d.state === "failed"),
      neverDeployed: count((d) => d.state === "not_deployed"),
      awaitingFounder: count((d) => d.founderActionRequired),
    },
    deployments,
    warnings,
  };
}
