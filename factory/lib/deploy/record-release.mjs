// Record a deployment the release stage says already happened.
//
// This is deliberately NOT a deploy. `runDeployment` performs one and is gated
// behind `allowRealDeploy` and the `production-deploy` prohibition; nothing
// here starts, retries or rolls back anything. It only writes down a URL the
// release stage reported, so that "open what it produced" has something to
// open — which until now it never did, because the only writer of a deployment
// record was a function no production code path called.
//
// Two records are written, because the console asks two different questions:
//
//   * the PROJECT record (`factory/lib/deploy/store.mjs`) answers "where does
//     this project live now" and is what the Projects view and the deployments
//     panel read. It carries production only.
//   * the TASK's own `state.deployment` answers "what did THIS piece of work
//     produce", which is the Deliveries preview link. A preview URL belongs
//     only here: it is scoped to one task's branch and would be wrong as the
//     project's answer.
//
// A malformed or missing URL is not a release failure. The release stage has
// already passed by the time this runs, and refusing to record a deployment
// must never retroactively fail work that shipped; every problem here is
// returned as a `reason` and recorded as an event instead.

import { randomUUID } from "crypto";
import { mutateTransactionalState } from "../store/transactional-json.mjs";
import { readDeploymentState, writeDeploymentState } from "./store.mjs";

const HISTORY_LIMIT = 20;

// Same rules as the registry's declared URL, for the same reason: this value
// ends up as an href the founder clicks.
export function normalizeDeploymentUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes(".")) return null;
  return url.toString();
}

// What a release result may claim. `environment` decides which of the two
// records above the URL is allowed to reach.
export function readReleaseDeployment(result) {
  const raw = result?.deployment;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const url = normalizeDeploymentUrl(raw.url);
  if (!url) return { url: null, reason: "the release result's deployment.url is not an https URL" };
  const environment = raw.environment === "preview" ? "preview" : "production";
  return {
    url,
    environment,
    providerDeploymentId: typeof raw.providerDeploymentId === "string" && raw.providerDeploymentId.trim()
      ? raw.providerDeploymentId.trim()
      : null,
    provider: typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : null,
    reason: null,
  };
}

function recordOnTask({ statePath, deployment, now }) {
  return mutateTransactionalState(statePath, {
    // Fresh key per call: a release ingests once, and the row exists for the
    // audit chain rather than for replay.
    commandId: `deployment-record:${randomUUID()}`,
    replayable: false,
    // Without this the ledger would store a full copy of the state document,
    // which is what the 2026-09-14 write storm was made of.
    toResponse: (state) => state?.deployment ?? null,
    mutate: (state) => {
      if (!state) return undefined;
      const next = structuredClone(state);
      next.deployment = {
        ...(next.deployment || {}),
        ...(deployment.environment === "preview"
          ? { previewUrl: deployment.url }
          : { productionUrl: deployment.url }),
        provider: deployment.provider,
        providerDeploymentId: deployment.providerDeploymentId,
        recordedAt: now,
      };
      next.events.push({
        at: now,
        type: "deployment-recorded",
        stage: "release",
        actor: "system",
        outcome: deployment.environment,
      });
      return next;
    },
  });
}

function recordOnProject({ hqRoot, projectKey, deployment, now }) {
  let prior = null;
  try {
    prior = readDeploymentState({ hqRoot, projectKey });
  } catch {
    // An unreadable prior record must not cost us the new, good one. The
    // deployments panel already surfaces the unreadable-record warning.
  }
  const state = {
    version: 1,
    projectKey,
    state: "deployed",
    provider: deployment.provider ?? prior?.provider ?? null,
    productionUrl: deployment.url,
    providerDeploymentId: deployment.providerDeploymentId ?? null,
    lastDeploymentAt: now,
    health: prior?.health ?? null,
    founderActionRequired: false,
    founderActionReason: null,
    lastError: null,
    history: [
      ...(Array.isArray(prior?.history) ? prior.history : []),
      { at: now, step: "record-release", outcome: "pass", detail: deployment.providerDeploymentId || deployment.url },
    ].slice(-HISTORY_LIMIT),
  };
  return writeDeploymentState({ hqRoot, projectKey, state });
}

/**
 * Record whatever the release stage reported. Never throws.
 *
 * @returns {{recorded: boolean, environment?: string, url?: string, projectRecordPath?: string|null, reason?: string}}
 */
export function recordReleaseDeployment({ hqRoot, statePath, state, result, now = new Date().toISOString() }) {
  const deployment = readReleaseDeployment(result);
  if (!deployment) return { recorded: false, reason: "the release result declared no deployment" };
  if (!deployment.url) return { recorded: false, reason: deployment.reason };

  try {
    recordOnTask({ statePath, deployment, now });
  } catch (error) {
    return { recorded: false, reason: `the task's deployment record could not be written: ${error.message}` };
  }

  // A preview belongs to the task that produced it, never to the project as a
  // whole: pointing the project's "where does this live" at one task's branch
  // deployment is how a founder ends up clicking through to a dead preview.
  if (deployment.environment === "preview") {
    return { recorded: true, environment: "preview", url: deployment.url, projectRecordPath: null };
  }

  const projectKey = state?.task?.project;
  if (!projectKey) {
    return { recorded: true, environment: "production", url: deployment.url, projectRecordPath: null, reason: "the task names no project, so only the task record was written" };
  }
  try {
    const path = recordOnProject({ hqRoot, projectKey, deployment, now });
    return { recorded: true, environment: "production", url: deployment.url, projectRecordPath: path };
  } catch (error) {
    return { recorded: true, environment: "production", url: deployment.url, projectRecordPath: null, reason: `the project record could not be written: ${error.message}` };
  }
}
