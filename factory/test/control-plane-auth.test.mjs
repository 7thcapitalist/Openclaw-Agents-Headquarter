// The viewer gate and the publisher gate.
//
// DC-2026-004 put company state on a public URL behind one shared secret, and
// required the check to live at a single boundary. That makes this module the
// whole of the access control for the hosted view, so it is tested against the
// ways a gate actually fails rather than only the happy path:
//
//   - a forged or tampered session
//   - an expired session
//   - an unset credential read as permission
//   - one credential accepted where the other was required
//
// The last is the one worth stating plainly: the write token must never open
// the read path, and the view password must never open the write path. They are
// separate secrets precisely so that rotating one does not force rotating the
// other, and a fallback between them would quietly undo that.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const MODULE = "../../control-plane/api/_lib/auth.mjs";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.HQ_SESSION_SECRET = "session-secret-for-tests";
  process.env.HQ_VIEW_PASSWORD = "view-password-for-tests";
  process.env.HQ_WRITE_TOKEN = "write-token-for-tests";
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

function requestWith(headers) {
  return new Request("https://example.invalid/api/mirror", { headers });
}

test("a session round-trips", async () => {
  const { issueSession, verifySession } = await import(MODULE);
  assert.equal(verifySession(issueSession()), true);
});

test("a session signed with a different secret is refused", async () => {
  const { issueSession, verifySession } = await import(MODULE);
  const token = issueSession();
  process.env.HQ_SESSION_SECRET = "a-different-secret";
  assert.equal(verifySession(token), false);
});

test("a tampered payload is refused", async () => {
  const { issueSession, verifySession } = await import(MODULE);
  const token = issueSession();
  const [payload, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 10 ** 12 })).toString("base64url");
  assert.notEqual(forged, payload);
  assert.equal(verifySession(`${forged}.${signature}`), false);
});

test("an expired session is refused even though its signature is valid", async () => {
  const { issueSession, verifySession, SESSION_TTL } = await import(MODULE);
  const token = issueSession();
  assert.equal(verifySession(token, { now: Date.now() + SESSION_TTL + 1000 }), false);
});

test("garbage is refused rather than throwing", async () => {
  const { verifySession } = await import(MODULE);
  for (const value of ["", ".", "a.b", "not-a-token", null, undefined, 42, {}]) {
    assert.equal(verifySession(value), false, `rejected: ${String(value)}`);
  }
});

test("the view password is compared, not guessed at", async () => {
  const { passwordMatches } = await import(MODULE);
  assert.equal(passwordMatches("view-password-for-tests"), true);
  assert.equal(passwordMatches("view-password-for-test"), false);
  assert.equal(passwordMatches("VIEW-PASSWORD-FOR-TESTS"), false);
  assert.equal(passwordMatches(""), false);
  assert.equal(passwordMatches(undefined), false);
});

test("the publisher gate accepts only a bearer write token", async () => {
  const { isPublisher } = await import(MODULE);
  assert.equal(isPublisher(requestWith({ authorization: "Bearer write-token-for-tests" })), true);
  assert.equal(isPublisher(requestWith({ authorization: "Bearer wrong" })), false);
  assert.equal(isPublisher(requestWith({ authorization: "write-token-for-tests" })), false);
  assert.equal(isPublisher(requestWith({})), false);
});

test("neither credential opens the other's gate", async () => {
  const { isPublisher, passwordMatches } = await import(MODULE);
  // The write token must not work as the view password...
  assert.equal(passwordMatches("write-token-for-tests"), false);
  // ...and the view password must not work as the write token.
  assert.equal(isPublisher(requestWith({ authorization: "Bearer view-password-for-tests" })), false);
});

test("a session cookie is not accepted as a publisher credential", async () => {
  const { isPublisher, issueSession } = await import(MODULE);
  const session = issueSession();
  assert.equal(isPublisher(requestWith({ authorization: `Bearer ${session}` })), false);
  assert.equal(isPublisher(requestWith({ cookie: `hq_session=${session}` })), false);
});

test("an unset credential fails closed rather than allowing", async () => {
  const { isPublisher, passwordMatches, verifySession, issueSession } = await import(MODULE);
  const token = issueSession();

  delete process.env.HQ_VIEW_PASSWORD;
  assert.throws(() => passwordMatches(""), /HQ_VIEW_PASSWORD is not configured/);
  assert.throws(() => passwordMatches("anything"), /HQ_VIEW_PASSWORD is not configured/);

  delete process.env.HQ_WRITE_TOKEN;
  assert.throws(
    () => isPublisher(requestWith({ authorization: "Bearer anything" })),
    /HQ_WRITE_TOKEN is not configured/,
  );

  delete process.env.HQ_SESSION_SECRET;
  assert.throws(() => verifySession(token), /HQ_SESSION_SECRET is not configured/);
});

test("the session cookie is HttpOnly, Secure, SameSite=Strict and scoped to the site", async () => {
  const { sessionCookie, clearedCookie, COOKIE_NAME } = await import(MODULE);
  const cookie = sessionCookie("value");
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) {
    assert.ok(cookie.includes(attribute), `missing ${attribute}`);
  }
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
  assert.ok(clearedCookie().includes("Max-Age=0"));
});

test("the viewer gate reads the session cookie and nothing else", async () => {
  const { isViewer, issueSession } = await import(MODULE);
  const session = issueSession();
  assert.equal(isViewer(requestWith({ cookie: `hq_session=${session}` })), true);
  assert.equal(isViewer(requestWith({ cookie: `other=${session}` })), false);
  assert.equal(isViewer(requestWith({ authorization: `Bearer ${session}` })), false);
  assert.equal(isViewer(requestWith({})), false);
});

test("a refusal never says which credential was checked", async () => {
  const { refuse } = await import(MODULE);
  const body = await refuse().json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(body.error, "unauthorized");
  assert.doesNotMatch(JSON.stringify(body), /password|token|secret|HQ_/i);
});
