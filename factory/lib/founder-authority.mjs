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

// Whether this process may also anchor itself on roots it worked out for
// itself. True is right for anything running inside an HQ checkout. A process
// that is NOT one — a harness, a sandbox, a CLI run from elsewhere — can say so
// once and stop the enclosing deployment's key from answering on its behalf.
let ambientRootsEnabled = true;

// Called once at startup by an entrypoint that knows its root (the dashboard
// server, the factory CLIs). Optional: the defaults below already find the
// standard layout.
export function configureTrustedAuthority({ hqRoot, ambient = true } = {}) {
  configuredRoot = hqRoot ? resolve(hqRoot) : null;
  ambientRootsEnabled = ambient !== false;
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

// Whether `env` permits anchoring on roots nobody named. The variable exists
// for processes that cannot call configureTrustedAuthority() before the code
// under test runs — a spawned CLI inherits its parent's environment but not its
// module state, so a harness that has detached in-process must also be able to
// say so across a process boundary.
function ambientAllowedByEnv(env) {
  const value = env?.FACTORY_AUTHORITY_AMBIENT;
  return !(value === "0" || value === "false");
}

// Roots nobody named — worked out from the environment and from this module's
// own location. Distinct from `configuredRoot` and from a per-call `hqRoot`,
// which are statements about which deployment the caller means.
function ambientRoots(env) {
  return [
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
 * `ambient` decides which question is being asked. With it true (the default)
 * this answers "what authority does this MACHINE trust", searching the
 * configured root, AGENT_LAB_ROOT, and the root derived from this module's own
 * location. With it false it answers the narrower "what authority does THIS
 * deployment trust", and looks only where the caller pointed.
 *
 * The distinction is invisible on a machine hosting one HQ and load-bearing
 * anywhere else: with `ambient` on, a gate asked about one root can be anchored
 * by a key belonging to another. Callers that must reason about a specific root
 * in isolation — anything verifying that an unanchored deployment REPORTS
 * itself unanchored — have to pass `ambient: false`, or the machine's own key
 * answers for a root that does not have one.
 *
 * @returns {{publicKey:string, fingerprint:string, source:string}|null}
 */
export function resolveTrustedFounderAuthority({ hqRoot = null, injected = null, env = process.env, ambient } = {}) {
  if (injected) {
    const pem = readEd25519Pem(injected.publicKey || injected.pem || injected);
    if (pem) return { publicKey: pem, fingerprint: fingerprintOf(pem), source: "injected" };
  }

  // Roots the caller named first, then — unless this process has opted out —
  // the ones it can work out for itself. Without those defaults the anchor was
  // unreachable from every gate except one dashboard endpoint, so they stay on
  // by default.
  const useAmbient = (ambient === undefined ? ambientRootsEnabled : ambient !== false)
    && ambientAllowedByEnv(env);
  const roots = [
    hqRoot ? resolve(hqRoot) : null,
    configuredRoot,
    ...(useAmbient ? ambientRoots(env) : []),
  ].filter(Boolean);
  for (const root of roots) {
    const pem = fromFile(enrolledKeyPath(root));
    if (pem) return { publicKey: pem, fingerprint: fingerprintOf(pem), source: "enrolled" };
  }

  // The env anchor is a property of the environment, not of a root, so it stays
  // available either way — a caller that names a root with no enrolled key is
  // still anchored by an explicitly configured public key.
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
