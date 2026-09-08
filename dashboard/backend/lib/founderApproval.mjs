// One-click founder approval for high-risk builds.
//
// This is NOT a new approval system. It is a thin server-side orchestration
// around the EXISTING Ed25519 gate in factory/lib/task-workflow.mjs:
// `recordFounderApproval()` / `validateFounderAssertion()` are unchanged and
// still the only thing that can move a high-risk task past `builder`.
//
// The only change is where the signature comes from. Instead of the founder
// running a CLI with an on-disk private key, the founder enrolls a
// NON-EXTRACTABLE Ed25519 key generated in their browser (WebCrypto + IndexedDB,
// scoped to the dashboard origin). The dashboard and the factory agents never
// see the private key and cannot export it. An agent calling the submit
// endpoint directly still fails signature verification — it has no key.
//
// Flow: enroll (once) → prepare (server writes the approval evidence, returns
// the exact bytes to sign) → browser signs with the non-extractable key →
// submit (server verifies with the existing gate, records, resumes the work).

import { createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  evidenceSha256,
  founderApprovalPayload,
  isAwaitingFounderApproval,
  publicKeyFingerprint,
  readState,
  recordFounderApproval,
  writeState,
} from "../../../factory/lib/task-workflow.mjs";
import { writeHandoff } from "../../../factory/lib/handoff.mjs";
import { findObjectiveStatePath, findTaskStatePath } from "./founderControlPlane.mjs";

const EVIDENCE_REL = "evidence/founder-approval.md";

function factoryDataDir(root) {
  return join(root, "dashboard", "backend", "data", "factory");
}
function enrolledKeyFile(root) {
  return join(factoryDataDir(root), "founder-approval-key.pem");
}
function enrolledKeyMetaFile(root) {
  return join(factoryDataDir(root), "founder-approval-key.json");
}

function writeFileAtomic(path, data, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { encoding: "utf8", mode });
  renameSync(tmp, path);
}

// Canonicalise an Ed25519 SPKI public key (PEM or base64 DER) to PEM, or throw.
function canonicalEd25519PublicKeyPem(input) {
  const text = String(input || "").trim();
  if (!text) throw new Error("A public key is required.");
  let keyObject;
  try {
    keyObject = text.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(text)
      : createPublicKey({ key: Buffer.from(text, "base64"), format: "der", type: "spki" });
  } catch {
    throw new Error("Public key is not a readable SPKI key.");
  }
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new Error("Founder approval keys must be Ed25519.");
  }
  return keyObject.export({ type: "spki", format: "pem" }).toString();
}

// ── enrollment ───────────────────────────────────────────────────────────────

export function getEnrolledFounderKey(root) {
  const file = enrolledKeyFile(root);
  if (existsSync(file)) {
    const pem = readFileSync(file, "utf8");
    let meta = {};
    try { meta = JSON.parse(readFileSync(enrolledKeyMetaFile(root), "utf8")); } catch { /* optional */ }
    return {
      enrolled: true,
      source: "browser",
      pem,
      fingerprint: publicKeyFingerprint(pem),
      enrolledAt: meta.enrolledAt || null,
      history: Array.isArray(meta.history) ? meta.history : [],
    };
  }
  const envPath = process.env.FACTORY_FOUNDER_PUBLIC_KEY;
  if (envPath && existsSync(resolve(envPath))) {
    const pem = readFileSync(resolve(envPath), "utf8");
    return { enrolled: true, source: "env", pem, fingerprint: publicKeyFingerprint(pem), enrolledAt: null, history: [] };
  }
  return { enrolled: false, source: null, pem: null, fingerprint: null, enrolledAt: null, history: [] };
}

// Enroll or rotate the founder's browser approval key.
//   - First enrollment (no browser key on file): trust-on-first-use, gated only
//     by the authenticated dashboard session. Logged loudly.
//   - Rotation (a browser key is already enrolled): the request MUST carry
//     `rotationSignature` — a signature over the new PEM made by the CURRENT
//     enrolled key. An agent without that key cannot rotate.
export function enrollFounderKey(root, { publicKeyPem, rotationSignature, at = new Date().toISOString(), actor = "founder" } = {}) {
  const pem = canonicalEd25519PublicKeyPem(publicKeyPem);
  const fingerprint = publicKeyFingerprint(pem);
  const current = getEnrolledFounderKey(root);

  if (current.enrolled && current.source === "browser") {
    if (current.fingerprint === fingerprint) {
      return { fingerprint, rotated: false, enrolledAt: current.enrolledAt, unchanged: true };
    }
    if (!rotationSignature) {
      const err = new Error("A browser key is already enrolled. Rotation must be signed by the current key.");
      err.statusCode = 409;
      throw err;
    }
    const ok = safeVerify(Buffer.from(pem), current.pem, rotationSignature);
    if (!ok) {
      const err = new Error("Rotation signature is not valid for the currently enrolled key.");
      err.statusCode = 403;
      throw err;
    }
  }

  const history = [
    ...(current.history || []),
    ...(current.source === "browser" && current.fingerprint
      ? [{ fingerprint: current.fingerprint, retiredAt: at }]
      : []),
  ].slice(-20);

  writeFileAtomic(enrolledKeyFile(root), pem, 0o600);
  writeFileAtomic(
    enrolledKeyMetaFile(root),
    `${JSON.stringify({ fingerprint, enrolledAt: at, algorithm: "Ed25519", actor, history }, null, 2)}\n`,
    0o600,
  );
  // Deliberately loud: a surprise enrollment is a security event.
  console.warn(`[founder-approval] approval key ${current.enrolled ? "ROTATED" : "ENROLLED"} — SHA256 fingerprint ${fingerprint} at ${at}`);
  return { fingerprint, rotated: Boolean(current.enrolled && current.source === "browser"), enrolledAt: at, previousSource: current.source };
}

function safeVerify(payload, publicKeyPem, signatureB64) {
  try {
    return verifySignature(null, payload, publicKeyPem, Buffer.from(String(signatureB64), "base64"));
  } catch {
    return false;
  }
}

// ── locate the task behind an inbox approval item ────────────────────────────

function locateTask(root, taskId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(taskId || ""))) throw badRequest("Invalid task id.");
  const statePath = findTaskStatePath(root, taskId);
  if (!statePath) throw notFound("No such task.");
  return { statePath, state: readState(statePath) };
}

function badRequest(message) { const e = new Error(message); e.statusCode = 400; return e; }
function notFound(message) { const e = new Error(message); e.statusCode = 404; return e; }
function conflict(message) { const e = new Error(message); e.statusCode = 409; return e; }

// ── prepare ─────────────────────────────────────────────────────────────────

// Write the approval evidence into the task worktree and return the exact
// unsigned assertion the browser must sign. Authorises nothing on its own.
export function prepareFounderApproval(root, taskId, { note = "", at = new Date().toISOString() } = {}) {
  const { statePath, state } = locateTask(root, taskId);
  if (!isAwaitingFounderApproval(state)) throw conflict("This task is not waiting for a founder approval.");

  const enrolled = getEnrolledFounderKey(root);
  if (!enrolled.enrolled) throw conflict("No founder approval key is enrolled yet.");
  const authority = state.founderApprovalAuthority?.fingerprint || publicKeyFingerprint(state.founderApprovalAuthority?.publicKey || "");
  if (authority !== enrolled.fingerprint) {
    const err = conflict("This task was created under a different approval key. Re-key it to your current key, then approve.");
    err.code = "KEY_MISMATCH";
    err.details = { taskAuthority: authority, enrolled: enrolled.fingerprint };
    throw err;
  }

  const worktree = resolve(state.worktree);
  if (!existsSync(worktree)) throw conflict("Task worktree is missing.");
  const evidenceAbs = join(worktree, EVIDENCE_REL);
  mkdirSync(dirname(evidenceAbs), { recursive: true });
  writeFileSync(evidenceAbs, renderEvidence(state, { note, at }), "utf8");

  // Field order here MUST match founderApprovalPayload(); the browser signs
  // JSON.stringify(unsigned) verbatim and the server re-derives the same bytes.
  const unsigned = {
    version: 1,
    taskId: state.task.id,
    challenge: state.founderApprovalRequest.challenge,
    decision: "approve-high-risk-build",
    approvedAt: at,
    evidenceSha256: evidenceSha256(evidenceAbs),
  };
  return {
    unsigned,
    payloadToSign: founderApprovalPayload(state, unsigned),
    evidencePath: EVIDENCE_REL,
    taskId: state.task.id,
    project: state.task.project || null,
    objective: state.task.outcome || null,
    keyFingerprint: enrolled.fingerprint,
  };
}

function renderEvidence(state, { note, at }) {
  return [
    "# Founder approval — high-risk build",
    "",
    `- Task: ${state.task.id}`,
    `- Project: ${state.task.project || "(unknown)"}`,
    `- Objective: ${state.task.outcome}`,
    `- Challenge: ${state.founderApprovalRequest?.challenge || "(none)"}`,
    `- Approved at: ${at}`,
    `- Approved via: Headquarters one-click (browser-held non-extractable Ed25519 key)`,
    `- Note: ${note ? String(note).replace(/\s+/g, " ").trim().slice(0, 500) : "(none)"}`,
    "",
    "The founder authorised this high-risk build from the Founder Inbox after",
    "reviewing what the factory is asking permission to do. The signing key never",
    "left the founder's browser; the dashboard and factory agents cannot read it.",
    "",
  ].join("\n");
}

// ── submit ──────────────────────────────────────────────────────────────────

// Verify the browser signature through the EXISTING gate, record it, and resume
// the owning objective/task. `runObjective` / `runTask` are injected so the
// caller (server) owns the background execution and tests stay synchronous.
export async function submitFounderApproval(root, hqRoot, taskId, { assertion } = {}, { runObjective, runTask } = {}) {
  const { statePath, state } = locateTask(root, taskId);
  if (!isAwaitingFounderApproval(state)) throw conflict("This task is not waiting for a founder approval.");
  if (!assertion || typeof assertion !== "object") throw badRequest("A signed assertion is required.");

  // recordFounderApproval → validateFounderAssertion: Ed25519 verify against the
  // key snapshotted in state. A forged / unsigned body throws here.
  let next;
  try {
    next = recordFounderApproval(state, { assertion, evidence: { path: EVIDENCE_REL } });
  } catch (error) {
    throw badRequest(`Approval rejected: ${error.message}`);
  }
  writeState(statePath, next);
  if (next.status === "active") {
    try { writeHandoff({ hqRoot, statePath, state: next }); } catch { /* handoff is best-effort */ }
  }

  const resume = await resumeAfterApproval(root, hqRoot, statePath, next, { runObjective, runTask });
  return { taskId: next.task.id, status: next.status, currentStage: next.currentStage, resume };
}

async function resumeAfterApproval(root, hqRoot, statePath, state, { runObjective, runTask }) {
  const objectiveId = String(state.task.id).match(/^(obj-[0-9a-f]{8})-/)?.[1] || null;
  if (objectiveId && typeof runObjective === "function") {
    const objectivePath = findObjectiveStatePath(root, objectiveId);
    if (objectivePath) {
      try {
        await runObjective({ objectivePath, stateRoot: dirname(dirname(dirname(objectivePath))) });
        return { kind: "objective", objectiveId, started: true };
      } catch (error) {
        return { kind: "objective", objectiveId, started: false, error: String(error.message || error) };
      }
    }
  }
  if (typeof runTask === "function") {
    try {
      await runTask({ statePath });
      return { kind: "task", started: true };
    } catch (error) {
      return { kind: "task", started: false, error: String(error.message || error) };
    }
  }
  return { kind: "none", started: false, reason: "no runner wired" };
}

// ── reject ──────────────────────────────────────────────────────────────────

// Declining authorises nothing, so it needs no signature — just the
// authenticated session. The task stops, visibly and auditably; it does not
// resume.
export function rejectFounderApproval(root, taskId, { reason = "", at = new Date().toISOString() } = {}) {
  const { statePath, state } = locateTask(root, taskId);
  if (!isAwaitingFounderApproval(state)) throw conflict("This task is not waiting for a founder approval.");

  const clean = String(reason || "").replace(/\s+/g, " ").trim().slice(0, 500);
  state.founderRejections = [...(state.founderRejections || []), { at, reason: clean || null }];
  state.blocker = {
    stage: "builder",
    outcome: "fail",
    founderRejected: true,
    summary: clean ? `Founder rejected this high-risk build: ${clean}` : "Founder rejected this high-risk build.",
    actor: "founder",
    at,
  };
  state.updatedAt = at;
  state.events.push({ at, type: "founder-approval-rejected", stage: "builder", actor: "founder", ...(clean ? { reason: clean } : {}) });
  writeState(statePath, state);
  return { taskId: state.task.id, status: state.status, rejected: true };
}

// ── re-key a pending task to the currently enrolled key ──────────────────────

// A task created before the founder enrolled a browser key carries the old
// authority. This repoints it (authenticated founder action, logged) so it can
// be approved one-click. It does NOT weaken the gate: the new key still has to
// produce a valid signature.
export function rekeyPendingApproval(root, taskId, { at = new Date().toISOString() } = {}) {
  const { statePath, state } = locateTask(root, taskId);
  if (!isAwaitingFounderApproval(state)) throw conflict("This task is not waiting for a founder approval.");
  if (state.founderApproval) throw conflict("This task is already approved.");

  const enrolled = getEnrolledFounderKey(root);
  if (!enrolled.enrolled || enrolled.source !== "browser") {
    throw conflict("Enroll a browser approval key before re-keying a task.");
  }
  const from = state.founderApprovalAuthority?.fingerprint || null;
  if (from === enrolled.fingerprint) return { taskId: state.task.id, rekeyed: false, unchanged: true };

  state.founderApprovalAuthority = {
    algorithm: "Ed25519",
    publicKey: enrolled.pem,
    fingerprint: enrolled.fingerprint,
  };
  state.updatedAt = at;
  state.events.push({ at, type: "founder-approval-authority-rekeyed", stage: "builder", actor: "founder", from, to: enrolled.fingerprint });
  writeState(statePath, state);
  return { taskId: state.task.id, rekeyed: true, from, to: enrolled.fingerprint };
}
