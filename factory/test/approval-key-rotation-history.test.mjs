// A rotated founder approval key must leave a record of the key it superseded.
//
// Regression: `founder-approval-key.json` had `history: []` after TWO real
// rotations (2026-09-08 fingerprint 4670509b…, 2026-09-12 fingerprint
// ccd785ea…, both visible in the dashboard log). The consequence is not
// cosmetic: task-ca3c3cdf's outstanding approval request is bound to the
// retired authority, so signing it today reads as "I signed" to the founder and
// "not approved" to the factory — with nothing on file to explain why.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { enrollFounderKey, getEnrolledFounderKey } from "../../dashboard/backend/lib/founderApproval.mjs";

function pemOf(keys) {
  return keys.publicKey.export({ type: "spki", format: "pem" }).toString();
}

function signWith(privateKey, payload) {
  return sign(null, Buffer.from(payload), privateKey).toString("base64");
}

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "key-rotation-"));
  mkdirSync(join(root, "dashboard", "backend", "data", "factory"), { recursive: true });
  return root;
}

function metaOf(root) {
  return JSON.parse(readFileSync(join(root, "dashboard", "backend", "data", "factory", "founder-approval-key.json"), "utf8"));
}

test("rotating a browser-enrolled key records the superseded key with both timestamps", () => {
  const root = freshRoot();
  const first = generateKeyPairSync("ed25519");
  const second = generateKeyPairSync("ed25519");

  enrollFounderKey(root, { publicKeyPem: pemOf(first), actor: "founder" });
  const afterFirst = metaOf(root);
  assert.deepEqual(afterFirst.history, [], "nothing is superseded by a first enrollment");

  const rotationSignature = signWith(first.privateKey, pemOf(second));
  enrollFounderKey(root, { publicKeyPem: pemOf(second), actor: "founder", rotationSignature });

  const meta = metaOf(root);
  assert.equal(meta.history.length, 1, "the superseded key must be recorded");
  const retired = meta.history[0];
  assert.equal(retired.fingerprint, afterFirst.fingerprint);
  assert.equal(retired.enrolledAt, afterFirst.enrolledAt, "enrolledAt identifies when the retired key was valid from");
  assert.ok(retired.retiredAt, "retiredAt identifies when it stopped being valid");
  assert.notEqual(meta.fingerprint, retired.fingerprint);
});

test("an env-sourced key's rotation is recorded, and prior history is not erased", (t) => {
  const root = freshRoot();
  const envKey = generateKeyPairSync("ed25519");
  const envPath = join(root, "env-key.pem");
  writeFileSync(envPath, pemOf(envKey));

  // Pre-existing history on file, from an earlier rotation.
  const prior = { fingerprint: "aaaa1111", enrolledAt: "2026-09-01T00:00:00.000Z", retiredAt: "2026-09-05T00:00:00.000Z", source: "browser" };
  writeFileSync(
    join(root, "dashboard", "backend", "data", "factory", "founder-approval-key.json"),
    JSON.stringify({ fingerprint: "unused", enrolledAt: "2026-09-05T00:00:00.000Z", algorithm: "Ed25519", actor: "founder", history: [prior] }, null, 2),
  );

  const originalEnv = process.env.FACTORY_FOUNDER_PUBLIC_KEY;
  process.env.FACTORY_FOUNDER_PUBLIC_KEY = envPath;
  t.after(() => {
    if (originalEnv === undefined) delete process.env.FACTORY_FOUNDER_PUBLIC_KEY;
    else process.env.FACTORY_FOUNDER_PUBLIC_KEY = originalEnv;
  });

  const current = getEnrolledFounderKey(root);
  assert.equal(current.source, "env");
  assert.deepEqual(current.history, [prior], "env-sourced keys must still carry the recorded history");

  const next = generateKeyPairSync("ed25519");
  const rotationSignature = signWith(envKey.privateKey, pemOf(next));
  enrollFounderKey(root, { publicKeyPem: pemOf(next), actor: "founder", rotationSignature });

  const meta = metaOf(root);
  assert.equal(meta.history.length, 2, "the earlier entry survives and the env key is added");
  assert.deepEqual(meta.history[0], prior, "prior history must not be erased");
  assert.equal(meta.history[1].fingerprint, current.fingerprint, "the retired env key must be identifiable");
  assert.equal(meta.history[1].source, "env");
  assert.ok(meta.history[1].retiredAt);
});

test("a retired authority can be identified from history, so a stale request is explainable", () => {
  const root = freshRoot();
  const first = generateKeyPairSync("ed25519");
  const second = generateKeyPairSync("ed25519");
  enrollFounderKey(root, { publicKeyPem: pemOf(first), actor: "founder" });
  const boundAuthority = metaOf(root).fingerprint;

  enrollFounderKey(root, {
    publicKeyPem: pemOf(second), actor: "founder",
    rotationSignature: signWith(first.privateKey, pemOf(second)),
  });

  const meta = metaOf(root);
  // This is the question that could not be answered before: an approval request
  // names authority X — is X a key we ever had, and when did it stop counting?
  const match = meta.history.find((h) => h.fingerprint === boundAuthority);
  assert.ok(match, "a request bound to a retired authority must be traceable to a real past key");
  assert.ok(match.retiredAt, "and must say when that key stopped being valid");
});
