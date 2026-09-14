// The API handlers must answer the way Vercel's Node runtime expects.
//
// This test exists because of a failure that no build check could have caught.
// The functions deployed correctly the whole time; they hung. Vercel calls a
// handler as `(req, res)` and waits for `res.end()`. The handlers took a Web
// `Request` and returned a Web `Response`, which the runtime ignores, so every
// call sat open until the gateway timed out.
//
// The symptom is what made it expensive: a hang is not a 404 and not a 500. It
// looks exactly like a function that was never deployed, which is what it was
// twice diagnosed as. The thing that finally distinguished them was a request —
// `/api/nonexistent` returned a fast 404 while `/api/session` hung, proving the
// routing was fine and the handler was not.
//
// So the check is a request, not a file inspection: every route is invoked with
// a fake req/res and must END THE RESPONSE. A handler that returns something
// instead of ending the response fails here rather than in production.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

const hqRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const apiDir = join(hqRoot, "control-plane", "api");

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.HQ_SESSION_SECRET = "session-secret-for-tests";
  process.env.HQ_VIEW_PASSWORD = "view-password-for-tests";
  process.env.HQ_WRITE_TOKEN = "write-token-for-tests";
  // Deliberately absent: BLOB_READ_WRITE_TOKEN. An authenticated request should
  // then fail closed with 503, never hang and never fall open.
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

function routes() {
  return readdirSync(apiDir).filter((name) => name.endsWith(".mjs"));
}

// A req that behaves like Node's: an async-iterable stream with lowercase headers.
function fakeReq({ method = "GET", headers = {}, body = "" } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  req[Symbol.asyncIterator] = async function* () {
    if (body) yield Buffer.from(body);
  };
  return req;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(payload) {
      this.body = payload;
      this.ended = true;
    },
  };
  return res;
}

async function call(route, options) {
  const module = await import(join(apiDir, route));
  const res = fakeRes();
  await module.default(fakeReq(options), res);
  return res;
}

test("every route takes (req, res) rather than a Web Request", async () => {
  for (const route of routes()) {
    const module = await import(join(apiDir, route));
    assert.equal(typeof module.default, "function", `${route} must export a default handler`);
    assert.ok(
      module.default.length >= 2,
      `${route} must accept (req, res) — a one-argument handler is the Web signature, which this runtime ignores`,
    );
  }
});

test("every route ends the response instead of returning one", async () => {
  for (const route of routes()) {
    const res = await call(route, { method: "GET" });
    assert.equal(res.ended, true, `${route} left the response open — this is the hang`);
    assert.equal(typeof res.statusCode, "number");
  }
});

test("an unauthenticated read is refused, not served and not hung", async () => {
  const res = await call("mirror.mjs", { method: "GET" });
  assert.equal(res.ended, true);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: "unauthorized" });
});

test("an unauthenticated write is refused before the body is read", async () => {
  const res = await call("mirror.mjs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contract: "hq.mirror/1", publishedAt: new Date().toISOString() }),
  });
  assert.equal(res.ended, true);
  assert.equal(res.statusCode, 401);
});

test("a wrong write credential is refused", async () => {
  const res = await call("mirror.mjs", {
    method: "POST",
    headers: { authorization: "Bearer not-the-write-token", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.statusCode, 401);
});

test("an authenticated write with a bad contract is rejected, not stored", async () => {
  const res = await call("mirror.mjs", {
    method: "POST",
    headers: { authorization: "Bearer write-token-for-tests", "content-type": "application/json" },
    body: JSON.stringify({ contract: "something/else", publishedAt: new Date().toISOString() }),
  });
  assert.equal(res.ended, true);
  assert.equal(res.statusCode, 422);
});

test("session reports not-authenticated without a cookie", async () => {
  const res = await call("session.mjs", { method: "GET" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { authenticated: false });
});

test("signing in with the right password sets a hardened cookie", async () => {
  const res = await call("session.mjs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "view-password-for-tests" }),
  });
  assert.equal(res.statusCode, 200);
  const cookie = res.headers["set-cookie"];
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict"]) {
    assert.ok(cookie.includes(attribute), `session cookie missing ${attribute}`);
  }
});

test("signing in with the wrong password is refused and sets no cookie", async () => {
  const res = await call("session.mjs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong" }),
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("an unsupported method is answered, not ignored", async () => {
  for (const route of routes()) {
    const res = await call(route, { method: "PATCH" });
    assert.equal(res.ended, true);
    assert.equal(res.statusCode, 405, `${route} must answer 405`);
  }
});

test("no response body ever contains a credential", async () => {
  const secrets = ["view-password-for-tests", "write-token-for-tests", "session-secret-for-tests"];
  const responses = [
    await call("mirror.mjs", { method: "GET" }),
    await call("session.mjs", { method: "GET" }),
    await call("session.mjs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    }),
  ];
  for (const res of responses) {
    for (const secret of secrets) {
      assert.ok(!String(res.body).includes(secret), "a response echoed a credential");
    }
  }
});
