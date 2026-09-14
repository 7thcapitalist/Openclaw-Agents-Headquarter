// The publisher is the only thing on this machine that talks to the internet,
// so what it refuses matters more than what it sends.
//
// Three properties are worth holding by test rather than by care:
//
//   1. it never sends anything that did not go through the publish boundary
//   2. it never writes the credential anywhere — not a log line, not an error,
//      not a returned object; a token that leaks on failure stops being
//      rotatable, which is the one thing DC-2026-003 required of it
//   3. it fails soft: no publish failure may become a factory failure, because
//      "stop the publisher" is rollback level 1 and must cost only freshness

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { MIRROR_CONTRACT } from "../lib/hq/mirror.mjs";
import { collectSources, publishSnapshot, publishOnce } from "../lib/hq/publisher.mjs";

const hqRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SECRET = "write-token-value-that-must-never-appear";

function validSnapshot(overrides = {}) {
  return { version: 1, contract: MIRROR_CONTRACT, publishedAt: new Date().toISOString(), panels: {}, ...overrides };
}

test("it refuses to send without an endpoint or a token", async () => {
  const unreachable = () => {
    throw new Error("network must not be touched");
  };
  assert.equal(
    (await publishSnapshot({ snapshot: validSnapshot(), endpoint: "", token: SECRET, fetchImpl: unreachable })).ok,
    false,
  );
  assert.equal(
    (await publishSnapshot({ snapshot: validSnapshot(), endpoint: "https://x.invalid", token: "", fetchImpl: unreachable })).ok,
    false,
  );
});

test("it refuses a snapshot that did not come from the publish boundary", async () => {
  const unreachable = () => {
    throw new Error("network must not be touched");
  };
  for (const snapshot of [{ contract: "something/else" }, {}, null, { contract: null }]) {
    const result = await publishSnapshot({
      snapshot,
      endpoint: "https://x.invalid",
      token: SECRET,
      fetchImpl: unreachable,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /contract must be/);
  }
});

test("it posts to /api/mirror with a bearer credential", async () => {
  let seen = null;
  const result = await publishSnapshot({
    snapshot: validSnapshot(),
    endpoint: "https://control.invalid",
    token: SECRET,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(seen.url, "https://control.invalid/api/mirror");
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.headers.authorization, `Bearer ${SECRET}`);
});

test("a rejected publish never returns or reports the credential", async () => {
  // The endpoint echoes the token back, which is the nastiest realistic case:
  // a misconfigured server reflecting what it was sent.
  const result = await publishSnapshot({
    snapshot: validSnapshot(),
    endpoint: "https://control.invalid",
    token: SECRET,
    fetchImpl: async () => new Response(`rejected credential ${SECRET}`, { status: 401 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  // The body is bounded but not trusted; assert the caller cannot be handed the
  // secret through any field of the result.
  assert.doesNotMatch(JSON.stringify(result).replace(SECRET, "LEAK"), /LEAK/);
});

test("a network failure is returned, not thrown", async () => {
  const result = await publishSnapshot({
    snapshot: validSnapshot(),
    endpoint: "https://control.invalid",
    token: SECRET,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ECONNREFUSED/);
});

test("publishOnce reports a build failure instead of throwing", async () => {
  const result = await publishOnce({
    hqRoot: "/nonexistent/path/that/cannot/be/read",
    endpoint: "https://control.invalid",
    token: SECRET,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  // Either it built a degraded snapshot and sent it, or it reported the
  // failure — but it must not throw, and it must not hang.
  assert.equal(typeof result.ok, "boolean");
});

test("one broken panel costs that panel, not the publish", async () => {
  const sources = await collectSources({ hqRoot: "/nonexistent/path", tasks: [] });
  const names = Object.keys(sources);
  assert.ok(names.length >= 7, `expected every panel to be present, got ${names.length}`);
  // Whatever failed must be recorded as data the renderer can show, not absent.
  for (const [name, value] of Object.entries(sources)) {
    assert.ok(value && typeof value === "object", `${name} must still be an object`);
  }
});

test("the publisher module opens no server and performs no inbound I/O", () => {
  const source = readFileSync(join(hqRoot, "factory", "lib", "hq", "publisher.mjs"), "utf8");
  for (const forbidden of ["createServer", "net.", "listen(", "node:http", "node:net", "WebSocket"]) {
    assert.ok(!source.includes(forbidden), `publisher must not reference ${forbidden}`);
  }
});

test("the publish boundary is imported, never reimplemented", () => {
  const source = readFileSync(join(hqRoot, "factory", "lib", "hq", "publisher.mjs"), "utf8");
  assert.match(source, /import \{[^}]*buildMirrorSnapshot[^}]*\} from "\.\/mirror\.mjs"/);
  // No second definition of what may leave the machine.
  assert.ok(!source.includes("function sanitize"), "sanitize belongs to mirror.mjs alone");
});

test("factory/ does not import from dashboard/", () => {
  const source = readFileSync(join(hqRoot, "factory", "lib", "hq", "publisher.mjs"), "utf8");
  assert.ok(!/from "[^"]*dashboard\//.test(source), "the dependency runs dashboard -> factory, not back");
});
