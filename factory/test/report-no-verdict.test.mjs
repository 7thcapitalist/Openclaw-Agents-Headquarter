import test from "node:test";
import assert from "node:assert/strict";
import { isNoVerdictContent, NO_VERDICT_LITERALS } from "../lib/hq/report/no-verdict.mjs";

test("no-verdict classification matches exactly the four contract phrases case-insensitively", () => {
  for (const phrase of NO_VERDICT_LITERALS) {
    assert.equal(isNoVerdictContent(`prefix ${phrase.toUpperCase()} suffix`), true, phrase);
  }
  assert.equal(isNoVerdictContent('{"outcome":"fail","summary":"CHANGES REQUIRED"}'), false);
  assert.equal(isNoVerdictContent('{"infraFailure":true,"summary":"rate limited"}'), false);
});
