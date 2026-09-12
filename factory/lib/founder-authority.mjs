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
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    // Refuse a symlink. An attacker who can write the data directory could
    // otherwise point the anchor at a key it controls while the result still
    // reported `source: "enrolled"` — tampering invisible in the very field
    // meant to surface it.
    if (lstatSync(path).isSymbolicLink()) {
      process.stderr.write(`[founder-authority] refusing symlinked approval key at ${path}\n`);
      return null;
    }
    return readEd25519Pem(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// The HQ root this process should look in, without every caller having to say so.
//
// Threading an `hqRoot` option through every gate did not work: exactly one
// production call site passed it, so every other gate — the builder gate, the
// release gate, resume paths, and all the CLI scripts — silently fell back to
// the task's own key. Resolution therefore has to work by default.
let configuredRoot = null;

// Called once at startup by an entrypoint that knows its root (the dashboard
// server, the factory CLIs). Optional: the defaults below already find the
// standard layout.
export function configureTrustedAuthority({ hqRoot } = {}) {
  configuredRoot = hqRoot ? resolve(hqRoot) : null;
  return configuredRoot;
}

// This file lives at <hq>/factory/lib/founder-authority.mjs, so the repository
// root — and therefore the enrolled key under dashboard/backend/data — is two
// directories up. Derived rather than configured so a CLI that never calls
// configureTrustedAuthority() is still anchored.
function moduleDerivedRoot() {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  } catch {
    return null;
  }
}

function candidateRoots(env) {
  return [
    configuredRoot,
    env?.AGENT_LAB_ROOT ? resolve(env.AGENT_LAB_ROOT) : null,
    moduleDerivedRoot(),
  ].filter(Boolean);
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

  // An explicit hqRoot first, then the roots this process can work out for
  // itself. Without these defaults the anchor was unreachable from every gate
  // except one dashboard endpoint.
  for (const root of [hqRoot ? resolve(hqRoot) : null, ...candidateRoots(env)].filter(Boolean)) {
    const pem = fromFile(enrolledKeyPath(root));
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
