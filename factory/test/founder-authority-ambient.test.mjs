// Where an approval anchor is allowed to come from.
//
// `resolveTrustedFounderAuthority` searches three kinds of place: roots the
// caller named, roots this process worked out for itself, and an environment
// variable. The middle kind is the useful default for a gate running inside a
// real deployment and the wrong answer for anything reasoning about a root in
// isolation — it lets the enclosing checkout's enrolled key answer for a root
// that has none.
//
// That cost 24 tests across six files, and cost them invisibly: it only shows
// up on a machine with real founder state, because `dashboard/backend/data/` is
// gitignored and therefore absent in CI and in every git worktree. These tests
// hold the distinction directly, so the next regression fails here — in one
// obvious place — instead of scattering across the approval suites.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { configureTrustedAuthority, enrolledKeyPath, resolveTrustedFounderAuthority } from "../lib/founder-authority.mjs";

function pem() {
  return generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
}

// A root laid out the way a real deployment is, with an enrolled key in it.
function deployment(publicKeyPem = pem()) {
  const root = mkdtempSync(join(tmpdir(), "hq-ambient-"));
  const path = enrolledKeyPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, publicKeyPem);
  return { root, publicKeyPem };
}

// This file drives the module's process-level switch directly, so it puts it
// back afterwards rather than leaving it set for whatever runs next.
function withProcessAmbient(enabled, body) {
  configureTrustedAuthority({ ambient: enabled });
  try { return body(); } finally { configureTrustedAuthority({ ambient: true }); }
}

test("a root the caller named is used whether or not ambient roots are searched", () => {
  const { root, publicKeyPem } = deployment();
  for (const ambient of [true, false]) {
    const resolved = resolveTrustedFounderAuthority({ hqRoot: root, ambient, env: {} });
    assert.equal(resolved?.source, "enrolled");
    assert.equal(resolved?.publicKey, publicKeyPem);
  }
});

test("with ambient off, a root with no enrolled key resolves to nothing", () => {
  const empty = mkdtempSync(join(tmpdir(), "hq-ambient-empty-"));
  assert.equal(
    resolveTrustedFounderAuthority({ hqRoot: empty, ambient: false, env: {} }),
    null,
    "an unanchored deployment must report itself unanchored",
  );
});

test("with ambient on, a root with no enrolled key can still be answered for by another", () => {
  // This is the behaviour that broke the suites, asserted deliberately rather
  // than discovered again: it is correct for a gate inside a real deployment,
  // and it is why anything reasoning about an isolated root must opt out.
  const { root, publicKeyPem } = deployment();
  const empty = mkdtempSync(join(tmpdir(), "hq-ambient-empty2-"));
  const resolved = resolveTrustedFounderAuthority({
    hqRoot: empty,
    ambient: true,
    env: { AGENT_LAB_ROOT: root },
  });
  assert.equal(resolved?.publicKey, publicKeyPem, "the ambient root answered for a root that has no key");
});

test("the environment anchor survives opting out of ambient roots", () => {
  // FACTORY_FOUNDER_PUBLIC_KEY names a key explicitly; it is not a guess about
  // where this process is running, so detaching from ambient roots must not
  // take it away.
  const keyFile = join(mkdtempSync(join(tmpdir(), "hq-ambient-env-")), "founder.pub");
  const publicKeyPem = pem();
  writeFileSync(keyFile, publicKeyPem);
  const empty = mkdtempSync(join(tmpdir(), "hq-ambient-empty3-"));

  const resolved = resolveTrustedFounderAuthority({
    hqRoot: empty,
    ambient: false,
    env: { FACTORY_FOUNDER_PUBLIC_KEY: keyFile },
  });
  assert.equal(resolved?.source, "env");
  assert.equal(resolved?.publicKey, publicKeyPem);
});

test("configureTrustedAuthority({ ambient: false }) detaches the whole process", () => {
  const { root } = deployment();
  const empty = mkdtempSync(join(tmpdir(), "hq-ambient-empty4-"));

  withProcessAmbient(false, () => {
    assert.equal(
      resolveTrustedFounderAuthority({ hqRoot: empty, env: { AGENT_LAB_ROOT: root } }),
      null,
      "a detached process must not inherit the enclosing deployment's authority",
    );
  });

  // ...and the detachment is not permanent.
  assert.ok(resolveTrustedFounderAuthority({ hqRoot: empty, env: { AGENT_LAB_ROOT: root } }));
});

test("a per-call ambient option overrides the process-level setting, in both directions", () => {
  const { root } = deployment();
  const empty = mkdtempSync(join(tmpdir(), "hq-ambient-empty5-"));
  const env = { AGENT_LAB_ROOT: root };

  withProcessAmbient(false, () => {
    assert.ok(
      resolveTrustedFounderAuthority({ hqRoot: empty, env, ambient: true }),
      "an explicit ambient:true re-enables the search for one call",
    );
  });
  withProcessAmbient(true, () => {
    assert.equal(
      resolveTrustedFounderAuthority({ hqRoot: empty, env, ambient: false }),
      null,
      "an explicit ambient:false disables it for one call",
    );
  });
});

test("FACTORY_AUTHORITY_AMBIENT=0 detaches across a process boundary", () => {
  // A spawned CLI inherits the environment but not module state, so the switch
  // has to exist in the environment too — founder-approve.mjs is run as a child
  // by the approval suites.
  const { root } = deployment();
  const empty = mkdtempSync(join(tmpdir(), "hq-ambient-empty6-"));

  for (const value of ["0", "false"]) {
    assert.equal(
      resolveTrustedFounderAuthority({ hqRoot: empty, env: { AGENT_LAB_ROOT: root, FACTORY_AUTHORITY_AMBIENT: value } }),
      null,
      `FACTORY_AUTHORITY_AMBIENT=${value} must detach`,
    );
  }
  // Anything else leaves the default alone — this must not become a footgun
  // where a typo silently disarms the anchor.
  assert.ok(resolveTrustedFounderAuthority({ hqRoot: empty, env: { AGENT_LAB_ROOT: root, FACTORY_AUTHORITY_AMBIENT: "1" } }));
  assert.ok(resolveTrustedFounderAuthority({ hqRoot: empty, env: { AGENT_LAB_ROOT: root, FACTORY_AUTHORITY_AMBIENT: "" } }));
});

test("an injected key still wins over everything", () => {
  const { root } = deployment();
  const injected = pem();
  const resolved = resolveTrustedFounderAuthority({
    injected: { publicKey: injected },
    hqRoot: root,
    env: { AGENT_LAB_ROOT: root },
  });
  assert.equal(resolved?.source, "injected");
  assert.equal(resolved?.publicKey, injected);
});
