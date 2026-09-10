// Where the founder's approval key really comes from (FCT-P0-04, follow-on).
//
// The problem this exists to solve, found by independent review:
//
//   `hasValidFounderApproval()` verified a signature against
//   `state.founderApprovalAuthority.publicKey` — a field in the very task-state
//   file that an attacker with write access controls. Swap the key, restate the
//   fingerprint, sign with your own private key, and the gate agrees. The v2
//   fingerprint binding did not help: it compared two fields in that same file.
//
// A signature check is only as good as the key it trusts. So the key has to
// come from somewhere the task cannot edit. This module is that somewhere.
//
// Resolution order (first hit wins):
//   1. an explicitly injected authority — the dashboard and CLI already read the
//      enrolled key and can hand it down;
//   2. the enrolled browser key under the HQ data directory (mode 0600);
//   3. `FACTORY_FOUNDER_PUBLIC_KEY`, a path set in the deployment environment.
//
// When an anchor resolves, it OVERRIDES whatever the task state claims. When
// none resolves, the task's own record is used and the result is flagged
// `anchored: false` so the weaker position is visible rather than assumed.

import { createHash, createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function fingerprintOf(publicKeyPem) {
  return createHash("sha256").update(String(publicKeyPem)).digest("hex");
}

// Parse and normalise an Ed25519 SPKI key, or return null. Never throws: a
// malformed anchor must not take down every gate that consults it.
function readEd25519Pem(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const key = raw.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(raw)
      : createPublicKey({ key: Buffer.from(raw, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return null;
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch {
    return null;
  }
}

function fromFile(path) {
  try {
    if (!path || !existsSync(path)) return null;
    return readEd25519Pem(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function enrolledKeyPath(hqRoot) {
  return join(resolve(hqRoot), "dashboard", "backend", "data", "factory", "founder-approval-key.pem");
}

/**
 * Resolve the approval authority this deployment actually trusts.
 *
 * @returns {{publicKey:string, fingerprint:string, source:string}|null}
 */
export function resolveTrustedFounderAuthority({ hqRoot = null, injected = null, env = process.env } = {}) {
  if (injected) {
    const pem = readEd25519Pem(injected.publicKey || injected.pem || injected);
    if (pem) return { publicKey: pem, fingerprint: fingerprintOf(pem), source: "injected" };
  }

  if (hqRoot) {
    const pem = fromFile(enrolledKeyPath(hqRoot));
    if (pem) return { publicKey: pem, fingerprint: fingerprintOf(pem), source: "enrolled" };
  }

  const envPath = env?.FACTORY_FOUNDER_PUBLIC_KEY;
  if (envPath) {
    const pem = fromFile(resolve(envPath));
    if (pem) return { publicKey: pem, fingerprint: fingerprintOf(pem), source: "env" };
  }

  return null;
}

/**
 * Decide which key a gate should verify against, and say how much that is worth.
 *
 * `anchored: true`  — the key came from outside the task state; editing the task
 *                     file cannot change it.
 * `anchored: false` — no external anchor is configured, so the task's own record
 *                     is all we have. Callers must surface this, not hide it.
 *
 * A task whose recorded authority DISAGREES with the anchor is a tampering
 * signal: the anchor wins and `mismatch` is set so the caller can refuse.
 */
export function authorityForVerification(state, options = {}) {
  const recorded = state?.founderApprovalAuthority || null;
  const recordedFingerprint = recorded?.fingerprint
    || (recorded?.publicKey ? fingerprintOf(recorded.publicKey) : null);

  const trusted = resolveTrustedFounderAuthority(options);
  if (!trusted) {
    return {
      publicKey: recorded?.publicKey || null,
      fingerprint: recordedFingerprint,
      anchored: false,
      mismatch: false,
      source: "task-state",
    };
  }

  return {
    publicKey: trusted.publicKey,
    fingerprint: trusted.fingerprint,
    anchored: true,
    mismatch: Boolean(recordedFingerprint && recordedFingerprint !== trusted.fingerprint),
    recordedFingerprint,
    source: trusted.source,
  };
}
