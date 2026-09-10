import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, isRecoverableFailure } from "../lib/failure-classification.mjs";

// The INFRA vocabulary decides two consequential things: whether recovery
// repairs the factory or suspects the project (`repairTargetFor`), and whether
// the resume sweep may retry the work unattended (`isRetriableInfraBlocker`).
// A project defect misfiled as infrastructure is therefore retried in silence
// and never reaches the founder. These two lists pin both directions.

// Ordinary review, QA and security prose about the PRODUCT. Every one of these
// contains a word that reads as environmental out of context — which is exactly
// how a bare-verb regex swallowed them.
const PROJECT_FAILURES = [
  "QA: 3 tests fail",
  "builder could not implement A",
  "reviewer: the retry helper could not run to completion under load",
  "QA: 523 assertions failed in the parser suite",
  "security: the auth profile parser accepts an empty signature",
  "reviewer: orphaned promise in the queue drain path leaks a handle",
  "QA: the server failed to start in the integration test after the config change",
  "reviewer: capacity planning helper returns NaN for zero nodes",
  "QA: quota enforcement is off by one",
  "builder: cannot start the worker without a config file — missing default",
  "reviewer: 500 error is returned instead of 400 for malformed input",
  "QA: usage limit banner renders twice",
];

// Real environment failures the factory must absorb without paging anyone.
const INFRA_FAILURES = [
  "[openclaw] Could not start the CLI",
  "agent did not write its result file",
  "rate limit exceeded, retry after 60s",
  "HTTP 503 from provider",
  "status: 500",
  "upstream returned 502",
  "ETIMEDOUT connecting to api",
  "all models failed",
  "seat cooldown active",
  "usage limit exceeded",
  "quota exhausted",
  "ran out of credits",
  "provider anthropic unavailable",
  "auth profile claude-cli missing",
  "orphaned session detected after host restart",
  "socket hang up",
  "could not launch the agent harness",
  "unable to reach the provider",
  "temporarily unavailable",
  "no result file at evidence/x.json",
  "429 Too Many Requests",
];

test("a verdict about the product is never classified as infrastructure", () => {
  for (const error of PROJECT_FAILURES) {
    assert.equal(classifyFailure({ error, outcome: "fail", source: "project" }), "PROJECT_ERROR",
      `misclassified as environmental, so it would be retried silently: ${error}`);
  }
});

test("environment failures are classified as infrastructure", () => {
  for (const error of INFRA_FAILURES) {
    assert.equal(classifyFailure({ error, outcome: "fail", source: "execution" }), "INFRASTRUCTURE_ERROR",
      `would be treated as a project defect and page the founder: ${error}`);
  }
});

test("both classes stay machine-recoverable rather than dead-ending", () => {
  assert.equal(isRecoverableFailure(classifyFailure({ error: "QA: 3 tests fail", outcome: "fail", source: "project" })), true);
  assert.equal(isRecoverableFailure(classifyFailure({ error: "[openclaw] Could not start the CLI", outcome: "fail" })), true);
});

test("an explicit founder decision outranks any prose match", () => {
  assert.equal(classifyFailure({ error: "rate limit exceeded", outcome: "decision-required" }), "FOUNDER_DECISION_REQUIRED");
  assert.equal(classifyFailure({ error: "anything", founderDecision: true }), "FOUNDER_DECISION_REQUIRED");
});
