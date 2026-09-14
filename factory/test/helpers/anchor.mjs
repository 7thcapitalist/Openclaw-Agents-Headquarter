// Test helper: give the process a trusted founder-approval anchor.
//
// The gate fails closed when no key outside the task state vouches for the
// approval authority, because an unresolvable anchor used to fall back to the
// task's own record — restoring the key-swap vulnerability. A test that
// exercises the approval path therefore has to configure an authority, exactly
// as a real deployment does.
//
// Writing the test's own generated public key to a file and pointing
// FACTORY_FOUNDER_PUBLIC_KEY at it is the faithful model: the deployment trusts
// the founder's key, and the task carries the same one.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureTrustedAuthority } from "../../lib/founder-authority.mjs";

/**
 * Stop the enclosing HQ checkout from anchoring this process.
 *
 * `clearFounderAnchor()` only ever removed the environment variable, which is
 * one of three places an anchor can come from. The others are AGENT_LAB_ROOT
 * and the root derived from the module's own location — so on a machine with a
 * real enrolled founder key, a test that believed it had cleared the anchor was
 * still anchored, by the developer's own deployment.
 *
 * That is invisible in CI and in every git worktree, because
 * `dashboard/backend/data/` is gitignored and therefore absent. It is not
 * invisible in the checkout that actually runs the factory, where it failed 24
 * tests across six files that assert an unanchored deployment reports itself
 * unanchored.
 *
 * A test suite is not an HQ deployment and must not inherit one's authority.
 * Call this once per test file that reasons about roots it creates itself.
 */
export function detachAmbientAnchor() {
  configureTrustedAuthority({ ambient: false });
  // A spawned CLI inherits the environment but not this module's state, so the
  // same decision has to cross the process boundary. founder-approve.mjs is run
  // as a child by these suites and would otherwise re-derive the enclosing
  // checkout's root and reject the test's own key as "not the key this
  // deployment trusts".
  process.env.FACTORY_AUTHORITY_AMBIENT = "0";
}

/**
 * Anchor this process to `publicKeyPem` and return the file path.
 * Also sets the variable in `process.env` so spawned CLIs inherit it.
 */
export function anchorFounderKey(publicKeyPem) {
  const dir = mkdtempSync(join(tmpdir(), "hq-test-anchor-"));
  const path = join(dir, "founder.pub");
  writeFileSync(path, String(publicKeyPem), { mode: 0o600 });
  process.env.FACTORY_FOUNDER_PUBLIC_KEY = path;
  return path;
}

/**
 * Remove the anchor, so a test can exercise the unanchored (fail-closed) path.
 *
 * Also detaches from the enclosing deployment: an "unanchored" test that is
 * still reachable from the machine's own enrolled key is not testing the
 * unanchored path at all.
 */
export function clearFounderAnchor() {
  delete process.env.FACTORY_FOUNDER_PUBLIC_KEY;
  detachAmbientAnchor();
}
