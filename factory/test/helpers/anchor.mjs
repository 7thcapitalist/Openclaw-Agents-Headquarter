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

/** Remove the anchor, so a test can exercise the unanchored (fail-closed) path. */
export function clearFounderAnchor() {
  delete process.env.FACTORY_FOUNDER_PUBLIC_KEY;
}
