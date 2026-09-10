// Durable approval and decision history.
//
// Adapted from Paperclip's `approvals` and `issue-approvals` services at pinned
// commit 6abeb67334348dcb6fde2d591a27ffc7efc7118d (MIT). Issue #120.
//
// THIS IS A PROJECTION, NOT A GATE. Paperclip's approvals table is the
// authority: writing `status: "approved"` into it authorises the work. HQ
// deliberately inverts that. The authority here is, and stays, the Ed25519
// assertion verified by `validateFounderAssertion()` in task-workflow.mjs
// against the key snapshotted into the task at creation. This module only
// READS canonical task state and reports what already happened.
//
// The consequence is the property that matters: there is no function here that
// can approve anything, and no file this module writes that any gate reads.
// Adding a row to this history grants nothing. That is why it is safe to expose
// the whole decision record to the dashboard.

import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { defaultStateRoot } from "./tasks.mjs";

// Lifecycle states, derived — never stored.
export const DECISION_STATES = Object.freeze([
  "requested",  // the factory asked and is waiting
  "approved",   // a valid signed assertion was recorded
  "rejected",   // the founder said no
  "consumed",   // the approval was used: the build actually resumed
  "revoked",    // the approving authority was replaced before use
  "expired",    // the request is stale and no longer awaited
]);

// A request nobody has acted on for this long is reported as `expired`. It is
// not deleted or invalidated — expiry here is a reading of the record, not an
// action on it, so a founder can still approve a stale request.
const DEFAULT_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

export function buildDecisionHistory({ hqRoot, stateRoot = null, now = new Date().toISOString(), expiryMs = DEFAULT_EXPIRY_MS, limit = 100 } = {}) {
  const warnings = [];
  const root = resolve(stateRoot || defaultStateRoot(hqRoot));
  const decisions = [];

  for (const statePath of stateFiles(root)) {
    const taskId = basename(dirname(statePath));
    try {
      decisions.push(...decisionsForTask(JSON.parse(readFileSync(statePath, "utf8")), { statePath, now, expiryMs }));
    } catch (error) {
      warnings.push(`task ${taskId} decision history unavailable: ${error.message}`);
    }
  }

  decisions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const counts = Object.fromEntries(DECISION_STATES.map((state) => [state, decisions.filter((d) => d.state === state).length]));

  return {
    version: 1,
    asOf: now,
    available: warnings.length === 0,
    authority: "founder-signed-assertion",
    warnings,
    summary: {
      total: decisions.length,
      ...counts,
      awaitingFounder: counts.requested,
      unsigned: decisions.filter((d) => d.state === "approved" && !d.evidence.signatureVerified).length,
    },
    decisions: decisions.slice(0, limit),
  };
}

// ------------------------------------------------------------------ internals

function decisionsForTask(state, { statePath, now, expiryMs }) {
  const out = [];
  const correlation = {
    taskId: state.task?.id || basename(dirname(statePath)),
    objectiveId: objectiveIdFor(state, statePath),
    projectId: state.task?.project || null,
    risk: state.task?.risk || null,
  };
  const events = Array.isArray(state.events) ? state.events : [];
  const at = (type) => events.filter((event) => event.type === type).map((event) => event.at);

  // --- the high-risk build approval ----------------------------------------
  const request = state.founderApprovalRequest;
  if (request) {
    const approvedAt = at("founder-approval-recorded").at(-1) || null;
    const rejectedAt = at("founder-approval-rejected").at(-1) || null;
    const rekeyedAt = at("founder-approval-authority-rekeyed").at(-1) || null;
    // "Consumed" means the approval was actually used: the task resumed after
    // it. An approval that never moved the work is not the same fact.
    const resumedAfter = approvedAt ? at("task-resumed").some((time) => time >= approvedAt) : false;
    const requestedAt = request.requestedAt || request.at || state.createdAt || null;

    out.push({
      kind: "high-risk-build",
      ...correlation,
      state: approvalState({ approvedAt, rejectedAt, rekeyedAt, resumedAfter, requestedAt, now, expiryMs, awaiting: isAwaiting(state) }),
      requestedAt,
      decidedAt: approvedAt || rejectedAt || null,
      updatedAt: approvedAt || rejectedAt || rekeyedAt || requestedAt || state.updatedAt || null,
      actor: approvedAt || rejectedAt ? "founder" : "system",
      // Deliberately NOT `state.blocker.summary`. A task can carry an unrelated
      // blocker (a recovery escalation, a failed gate) at the same time as an
      // approval request, and borrowing that text made the approval row
      // describe something else entirely.
      summary: `High-risk build in ${correlation.projectId || "this project"} requires founder approval before build.`,
      evidence: {
        // Identifiers and verification facts only. The assertion, the signature,
        // the challenge and the evidence body stay in task state; publishing
        // them buys nothing and widens the blast radius of this endpoint.
        challengePresent: Boolean(request.challenge),
        keyFingerprint: fingerprintOf(state),
        signatureVerified: Boolean(state.founderApproval?.verified),
        evidencePath: state.founderApproval?.evidence?.path || null,
        rekeyed: Boolean(rekeyedAt),
      },
    });
  }

  // --- non-approval founder decisions --------------------------------------
  // A blocker the factory cannot resolve alone is also a decision the founder
  // owns, and it belongs in the same history: "what have I been asked, and what
  // did I answer" is one question, not two.
  const blocker = state.blocker;
  if (blocker?.outcome === "decision-required") {
    const resolvedAt = at("task-resumed").at(-1) || null;
    const askedAt = at("stage-decision-required").at(-1) || at("recovery-escalated").at(-1) || state.updatedAt || null;
    const answered = Boolean(resolvedAt && askedAt && resolvedAt >= askedAt);
    out.push({
      kind: "founder-decision",
      ...correlation,
      state: answered ? "consumed" : isStale(askedAt, now, expiryMs) ? "expired" : "requested",
      requestedAt: askedAt,
      decidedAt: answered ? resolvedAt : null,
      updatedAt: resolvedAt || askedAt,
      actor: answered ? "founder" : "system",
      summary: truncate(blocker.summary || blocker.whatFailed || "The factory needs a founder decision."),
      evidence: {
        challengePresent: false,
        keyFingerprint: null,
        signatureVerified: false,
        // A Decision Card is the founder-facing artifact; reference it, never
        // inline it — it can quote agent output.
        evidencePath: state.decisionCard?.path || null,
        rekeyed: false,
        stage: blocker.stage || null,
        classification: blocker.classification || null,
      },
    });
  }

  return out;
}

function approvalState({ approvedAt, rejectedAt, rekeyedAt, resumedAfter, requestedAt, now, expiryMs, awaiting }) {
  if (rejectedAt && (!approvedAt || rejectedAt > approvedAt)) return "rejected";
  if (approvedAt) return resumedAfter ? "consumed" : "approved";
  // A re-key replaces the authority the request was issued under, so an
  // undecided request that has been re-keyed is reported as revoked: the
  // signature it was waiting for can no longer be produced.
  if (rekeyedAt) return "revoked";
  if (!awaiting && isStale(requestedAt, now, expiryMs)) return "expired";
  return isStale(requestedAt, now, expiryMs) && !awaiting ? "expired" : "requested";
}

function isAwaiting(state) {
  return state.task?.risk === "high"
    && Boolean(state.founderApprovalRequest)
    && !state.founderApproval?.verified
    && state.status !== "complete";
}

function isStale(at, now, expiryMs) {
  const then = Date.parse(at || "");
  const current = Date.parse(now);
  return Number.isFinite(then) && Number.isFinite(current) && current - then > expiryMs;
}

function objectiveIdFor(state, statePath) {
  const fromId = /^(obj-[a-z0-9]+)-/i.exec(state.task?.id || "");
  if (fromId) return fromId[1];
  return state.objectiveId || null;
}

function fingerprintOf(state) {
  const value = state.founderApprovalAuthority?.fingerprint;
  return typeof value === "string" && value.length ? value.slice(0, 32) : null;
}

function truncate(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function stateFiles(root, out = []) {
  if (!existsSync(root)) return out;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) stateFiles(path, out);
    else if (entry.isFile() && entry.name === "state.json") out.push(path);
  }
  return out;
}
