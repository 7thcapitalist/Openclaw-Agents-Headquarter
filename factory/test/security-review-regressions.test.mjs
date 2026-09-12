// Regressions for defects found by the independent security review of PR #156
// (FCT-P0-04). Each test names the finding it locks down.

import test from "node:test";
import { anchorFounderKey } from "./helpers/anchor.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completeStage,
  createState,
  evidenceSha256,
  founderApprovalPayload,
  founderApprovalStatus,
  hasValidFounderApproval,
  isAwaitingFounderApproval,
  recordFounderApproval,
  unsignedFounderAssertion,
} from "../lib/task-workflow.mjs";
import {
  contentSecurityPolicy,
  csrfProtection,
} from "../../dashboard/backend/lib/httpSecurity.mjs";
import { redact, redactText } from "../../dashboard/backend/lib/securityAudit.mjs";
import {
  markdownRenderingAvailable,
  renderUntrustedMarkdown,
  sanitizeHtml,
} from "../../dashboard/backend/lib/safeMarkdown.mjs";

const pipelineTest = markdownRenderingAvailable() ? test : test.skip;

const task = {
  id: "issue-42",
  outcome: "Ship it",
  acceptanceCriteria: ["It works"],
  project: "demo",
  workType: "backend",
  risk: "high",
  issue: "https://example.com/issues/42",
};

function newKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

function blockedTask(publicKeyPem) {
  // The gate fails closed without a key vouched for outside task state, so a
  // test that drives the approval path must configure one, as a deployment does.
  anchorFounderKey(publicKeyPem);
  const worktree = mkdtempSync(join(tmpdir(), "hq-rev-"));
  mkdirSync(join(worktree, "evidence"), { recursive: true });
  for (const stage of ["product", "architect"]) {
    writeFileSync(join(worktree, "evidence", `${stage}.md`), `${stage}\n`);
  }
  writeFileSync(join(worktree, "evidence", "approval.md"), "approved\n");

  let state = createState({ task, repo: "/tmp/repo", branch: "factory/issue-42", worktree, founderPublicKey: publicKeyPem });
  for (const stage of ["product", "architect"]) {
    state = completeStage(state, {
      stage,
      actor: state.assignments[stage],
      outcome: "pass",
      summary: `${stage} ok`,
      evidence: [{ path: `evidence/${stage}.md` }],
    });
  }
  return { state, worktree, evidence: { path: "evidence/approval.md" } };
}

function signAssertion(state, evidenceAbs, privateKey, overrides = {}) {
  const unsigned = {
    ...unsignedFounderAssertion(state, {
      approvedAt: new Date().toISOString(),
      evidenceSha256: evidenceSha256(evidenceAbs),
    }),
    ...overrides,
  };
  return {
    ...unsigned,
    signature: sign(null, Buffer.from(founderApprovalPayload(state, unsigned)), privateKey).toString("base64"),
  };
}

// ── Finding 2 (HIGH): expiry must not deadlock an approved task ──────────────

test("finding 2: a recorded approval does not expire out from under a long pipeline", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask(key.publicKeyPem);

  // Sign with a genuinely old timestamp, under a TTL wide enough to accept it,
  // so the signature really does cover that date. Mutating approvedAt after
  // signing would only prove the signature check works.
  const longLived = structuredClone(state);
  longLived.founderApprovalRequest.expiresAfterSeconds = 365 * 24 * 3600;
  const assertion = signAssertion(longLived, join(worktree, evidence.path), key.privateKey, {
    approvedAt: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
  });
  const approved = recordFounderApproval(longLived, { assertion, evidence });
  assert.equal(approved.status, "active");

  // Now the deployment tightens the TTL to something the pipeline outran. The
  // recorded approval must survive: this is the deadlock the review found,
  // where an approved task died at release and could not be re-approved.
  const aged = structuredClone(approved);
  aged.founderApprovalRequest.expiresAfterSeconds = 1;

  assert.equal(
    hasValidFounderApproval(aged),
    true,
    "a recorded approval must stay valid; expiry bounds the signing window, not the whole pipeline",
  );
  assert.equal(isAwaitingFounderApproval(aged), false);
  assert.equal(founderApprovalStatus(aged).satisfied, true);
});

test("finding 2: expiry still refuses a stale signature at the moment of recording", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask(key.publicKeyPem);
  state.founderApprovalRequest.expiresAfterSeconds = 60;

  const stale = signAssertion(state, join(worktree, evidence.path), key.privateKey, {
    approvedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });
  assert.throws(() => recordFounderApproval(state, { assertion: stale, evidence }), /expired/i);
});

// ── Finding 1 (partial): tampering must not DISABLE a control ────────────────

test("finding 1: deleting the challenge does not satisfy the gate", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask(key.publicKeyPem);
  const assertion = signAssertion(state, join(worktree, evidence.path), key.privateKey);

  const tampered = structuredClone(state);
  delete tampered.founderApprovalRequest.challenge;
  const withoutChallenge = { ...assertion };
  delete withoutChallenge.challenge;

  // Two undefined values used to compare equal and pass.
  assert.throws(
    () => recordFounderApproval(tampered, { assertion: withoutChallenge, evidence }),
    /missing challenge/i,
  );
  assert.equal(hasValidFounderApproval({ ...tampered, founderApproval: { assertion: withoutChallenge, evidence } }), false);
});

test("finding 1: deleting the TTL field does not mean the approval never expires", () => {
  const key = newKeypair();
  const { state, worktree, evidence } = blockedTask(key.publicKeyPem);
  delete state.founderApprovalRequest.expiresAfterSeconds;

  const ancient = signAssertion(state, join(worktree, evidence.path), key.privateKey, {
    approvedAt: new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString(),
  });
  assert.throws(
    () => recordFounderApproval(state, { assertion: ancient, evidence }),
    /expired/i,
    "a missing TTL must fall back to the default, not disable expiry",
  );
});

// ── Finding 8: the release gate says what is actually wrong ──────────────────

test("finding 8: an unauthorized high-risk task reports the real reason", () => {
  const key = newKeypair();
  const { state } = blockedTask(key.publicKeyPem);

  const status = founderApprovalStatus(state);
  assert.equal(status.required, true);
  assert.equal(status.satisfied, false);
  assert.match(status.reason, /No signed founder approval/i);
});

// ── Finding 4: link text must not carry raw HTML into the output ─────────────

pipelineTest("finding 4: raw HTML inside link text is escaped, not emitted live", () => {
  const html = renderUntrustedMarkdown(`[<img src=x onerror=alert(1)>](https://ok.example)`);
  // Inspect real tags only. The payload SHOULD appear as escaped text — that is
  // the fix working — so a substring search on the decoded string would flag
  // exactly the correct output.
  const liveTags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)];
  assert.ok(
    !liveTags.some((m) => m[1].toLowerCase() === "img"),
    `an <img> reached the output as live markup: ${html}`,
  );
  assert.ok(
    !liveTags.some((m) => /\son[a-z]+\s*=/i.test(m[2] || "")),
    `an event handler survived on a live tag: ${html}`,
  );
  assert.match(html, /&lt;img/, "the payload should still be visible as escaped text");
});

pipelineTest("finding 4: nested inline markup in a link still renders correctly", () => {
  // Regression the same bug caused: using token.text leaked literal Markdown.
  const html = renderUntrustedMarkdown(`[**bold**](https://ok.example)`);
  assert.match(html, /<strong>bold<\/strong>/, `nested markup was lost: ${html}`);
});

// ── Finding 7: a crafted title must not suppress link hardening ──────────────

pipelineTest("finding 7: a title containing 'rel=' does not strip the link's rel", () => {
  const html = renderUntrustedMarkdown(`[y](https://x.example "rel=")`);
  assert.match(html, /rel="noopener noreferrer nofollow"/, `rel fallback was suppressed: ${html}`);
  assert.match(html, /target="_blank"/);
});

test("finding 7: every anchor with an href leaves with a safe rel", () => {
  for (const input of [
    '<a href="https://x.example" title="rel=">y</a>',
    '<a href="https://x.example" title="href=">y</a>',
    '<a href="https://x.example">y</a>',
  ]) {
    const html = sanitizeHtml(input);
    assert.match(html, /rel="noopener noreferrer nofollow"/, `no rel on: ${html}`);
  }
});

// ── Finding 5: redaction covers real-world field spellings ───────────────────

test("finding 5: plurals, compounds and env-var spellings are redacted", () => {
  const out = redact({
    tokens: ["t1", "t2"],
    secrets: { a: "s" },
    signatures: ["s1"],
    apiKeys: ["k1"],
    accessToken: "at_live_xxx",
    refreshToken: "rt_live_xxx",
    passwordHash: "$2b$abc",
    newPassword: "hunter3",
    passphrase: "open sesame",
    privKey: "-----BEGIN PRIVATE KEY-----",
    credentials: "u:p",
    DASHBOARD_PASSWORD: "hunter2",
    FACTORY_FOUNDER_PRIVATE_KEY: "/x/k.pem",
    nested: { deep: { secretValue: "leak-me" } },
  });

  const serialized = JSON.stringify(out);
  for (const leaked of [
    "t1", "at_live_xxx", "rt_live_xxx", "$2b$abc", "hunter3", "open sesame",
    "BEGIN PRIVATE KEY", "u:p", "hunter2", "/x/k.pem", "leak-me", "k1", "s1",
  ]) {
    assert.ok(!serialized.includes(leaked), `audit redaction leaked ${leaked}: ${serialized}`);
  }
});

test("finding 5: non-sensitive fields that merely contain a keyword survive", () => {
  const out = redact({ tokenCount: 12, hasPassword: true, signatureAlgorithm: "Ed25519", taskId: "issue-42" });
  assert.equal(out.tokenCount, 12);
  assert.equal(out.hasPassword, true);
  assert.equal(out.signatureAlgorithm, "Ed25519");
  assert.equal(out.taskId, "issue-42");
});

test("finding 5: free-text reasons are scrubbed, not merely truncated", () => {
  assert.ok(!redactText("failed with password=hunter2 while connecting").includes("hunter2"));
  assert.ok(!redactText("token: abc123def456").includes("abc123def456"));
  assert.ok(
    !redactText("-----BEGIN PRIVATE KEY-----MIIEvQ-----END PRIVATE KEY-----").includes("MIIEvQ"),
  );
  // Ordinary text is left alone.
  assert.equal(redactText("QA could not reach the staging host."), "QA could not reach the staging host.");
});

// ── Finding 6: the origin check must not trust a self-nominated host ─────────

function runCsrf(headers, { trustProxy = false } = {}) {
  const middleware = csrfProtection({ exemptPaths: [], trustProxy });
  const req = {
    method: "POST",
    path: "/api/founder/approvals/x/submit",
    headers,
    session: { csrfToken: "the-real-token" },
    body: {},
  };
  let statusCode = 200;
  let payload = null;
  let passed = false;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  middleware(req, res, () => { passed = true; });
  return { passed, statusCode, payload };
}

test("finding 6: x-forwarded-host cannot nominate its own allowed origin", () => {
  const spoofed = runCsrf(
    {
      host: "127.0.0.1:8080",
      "x-forwarded-host": "evil.example.com",
      origin: "https://evil.example.com",
      "x-csrf-token": "the-real-token",
    },
    { trustProxy: false },
  );
  assert.equal(spoofed.passed, false, "a spoofed x-forwarded-host must not authorise its own origin");
  assert.equal(spoofed.statusCode, 403);
});

test("finding 6: x-forwarded-host is honoured only when a proxy is trusted", () => {
  const headers = {
    host: "internal:8080",
    "x-forwarded-host": "hq.example.com",
    origin: "https://hq.example.com",
    "x-csrf-token": "the-real-token",
  };
  assert.equal(runCsrf(headers, { trustProxy: true }).passed, true);
  assert.equal(runCsrf(headers, { trustProxy: false }).passed, false);
});

test("finding 6: a genuine same-origin request still passes", () => {
  const ok = runCsrf({
    host: "127.0.0.1:8080",
    origin: "http://127.0.0.1:8080",
    "x-csrf-token": "the-real-token",
  });
  assert.equal(ok.passed, true);
});

// ── Finding 10: agent markdown must not beacon the founder ───────────────────

test("finding 10: the CSP does not permit arbitrary remote images", () => {
  const csp = contentSecurityPolicy();
  const img = csp.split(";").find((d) => d.trim().startsWith("img-src")).trim();
  assert.equal(img, "img-src 'self' data:", `remote images would let a report beacon the founder: ${img}`);
});
