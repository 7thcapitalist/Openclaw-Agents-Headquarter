import test from "node:test";
import assert from "node:assert/strict";
import { isSecretFilename, scrubText, assertInsideDir } from "../lib/intel/redact.mjs";

test("isSecretFilename flags secret-looking files and passes context files", () => {
  for (const name of [".env", ".env.local", "id_rsa", "server.pem", "app.key", "secrets.yaml", "aws-credentials.json"]) {
    assert.equal(isSecretFilename(name), true, name);
    assert.equal(isSecretFilename(`some/dir/${name}`), true, name);
  }
  for (const name of ["TECH_CONTEXT.md", "ownership.json", "README.md", "environment.md"]) {
    assert.equal(isSecretFilename(name), false, name);
  }
});

test("scrubText replaces key material and reports hits, leaving prose intact", () => {
  const input = [
    "OpenAI key sk-abcdefghijklmnopqrstuvwx12345",
    "GitHub token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    "DB postgres://user:hunter2@db.internal:5432/app",
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEpAIBAAKCAQEA...",
    "-----END RSA PRIVATE KEY-----",
    "This ordinary sentence stays.",
  ].join("\n");
  const { text, hits } = scrubText(input);
  assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwx12345"));
  assert.ok(!text.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
  assert.ok(!text.includes("hunter2@"));
  assert.ok(!text.includes("BEGIN RSA PRIVATE KEY"));
  assert.match(text, /\[redacted: openai-sk\]/);
  assert.match(text, /This ordinary sentence stays\./);
  const names = hits.map((h) => h.name);
  assert.ok(names.includes("openai-sk"));
  assert.ok(names.includes("gh-token"));
  assert.ok(names.includes("db-url"));
  assert.ok(names.includes("pem-block"));
});

test("scrubText on clean prose returns it unchanged with no hits", () => {
  const { text, hits } = scrubText("The vision is to compress founder attention.");
  assert.equal(text, "The vision is to compress founder attention.");
  assert.deepEqual(hits, []);
});

test("assertInsideDir resolves children and rejects escapes", () => {
  assert.equal(assertInsideDir("/base/ctx", "VISION.md"), "/base/ctx/VISION.md");
  assert.equal(assertInsideDir("/base/ctx", "sub/MEMORY.md"), "/base/ctx/sub/MEMORY.md");
  assert.throws(() => assertInsideDir("/base/ctx", "../../.env"), /escapes context dir/);
  assert.throws(() => assertInsideDir("/base/ctx", "/etc/passwd"), /escapes context dir/);
});
