// "Nothing published yet" must be distinguishable from "the store is broken".
//
// Against the live deployment an empty mirror answered 502 "mirror
// unavailable" rather than the empty state, because readSnapshot() matched
// not-found on one error shape and the store threw another. The empty state is
// the first thing a fresh deployment shows, so a bug there is visible exactly
// once and then hidden forever by the first successful publish.
//
// The two directions matter equally, and the second is the one worth guarding:
// a miss must read as empty, and a credential or transport failure must NOT.
// Reporting "nothing published yet" for a store you cannot reach is a lie that
// looks like calm — the founder would see a tidy empty page and conclude the
// publisher had never run.

import assert from "node:assert/strict";
import { test } from "node:test";

import { isNotFound } from "../../control-plane/api/_lib/store.mjs";

test("every shape of not-found reads as an empty mirror", () => {
  const misses = [
    { status: 404 },
    { statusCode: 404 },
    { name: "BlobNotFoundError" },
    { name: "NotFoundError" },
    { message: "The requested blob does not exist" },
    { message: "not found" },
    { message: "no such object" },
  ];
  for (const error of misses) {
    assert.equal(isNotFound(error), true, `should be a miss: ${JSON.stringify(error)}`);
  }
});

test("a broken store is never reported as an empty one", () => {
  const failures = [
    { status: 401, message: "Unauthorized" },
    { status: 403, message: "Forbidden" },
    { status: 500, message: "Internal Server Error" },
    { name: "TypeError", message: "fetch failed" },
    { message: "ECONNREFUSED" },
    { message: "BLOB_READ_WRITE_TOKEN is not configured" },
    { code: "unconfigured", message: "BLOB_READ_WRITE_TOKEN is not configured" },
    {},
    null,
    undefined,
  ];
  for (const error of failures) {
    assert.equal(isNotFound(error), false, `must not read as empty: ${JSON.stringify(error)}`);
  }
});

test("a 404 wins over a message that looks like a failure", () => {
  // The status is the stronger signal; a miss that also carries scary prose is
  // still a miss.
  assert.equal(isNotFound({ status: 404, message: "Internal Server Error" }), true);
});
