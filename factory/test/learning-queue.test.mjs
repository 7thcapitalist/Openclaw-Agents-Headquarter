import test from "node:test";
import assert from "node:assert/strict";
import { emptyStore, reconcile, setStatus, selectFindings, findById, pruneEvidence } from "../lib/learning/queue.mjs";
import {
  readEntries, nextEntryId, entryFromFinding, appendEntryToBody, renderDigest, targetFileForFinding,
} from "../lib/learning/knowledge.mjs";

const NOW = "2026-09-03T00:00:00Z";
const LATER = "2026-09-10T00:00:00Z";

function finding(over = {}) {
  return {
    kind: "failure",
    scope: "global",
    project: "demo",
    targetRole: "builder",
    fingerprint: "builder-fail:backend:ambiguous-acceptance-criteria",
    title: "Builder failed (ambiguous criteria)",
    observation: "two tasks",
    recommendation: "require acceptance tests",
    confidence: "medium",
    occurrences: 1,
    taskIds: ["issue-42"],
    evidence: [{ path: "issue-42:dispatch:builder#1", excerpt: "not testable" }],
    ...over,
  };
}

test("reconcile assigns ids, dedupes by fingerprint, and reinforces on new tasks", () => {
  let { store, added } = reconcile(emptyStore(), [finding()], { now: NOW });
  assert.deepEqual(added, ["L-0001"]);
  ({ store } = reconcile(store, [finding({ taskIds: ["issue-42", "issue-51"], occurrences: 2 })], { now: LATER }));
  const f = findById(store, "L-0001");
  assert.deepEqual(f.taskIds, ["issue-42", "issue-51"]);
  assert.ok(f.history.some((h) => h.event === "reinforced"));
});

test("a promoted finding that recurs is flagged, not silently reopened", () => {
  let { store } = reconcile(emptyStore(), [finding()], { now: NOW });
  ({ store } = setStatus(store, "L-0001", "promoted", { now: NOW }));
  ({ store } = reconcile(store, [finding({ taskIds: ["issue-42", "issue-99"] })], { now: LATER }));
  const f = findById(store, "L-0001");
  assert.equal(f.status, "promoted");
  assert.equal(f.recurredAfter, "promoted");
  assert.ok(f.history.some((h) => h.event === "recurred-after-promoted"));
});

test("dismiss drops raw excerpts but keeps the index", () => {
  let { store } = reconcile(emptyStore(), [finding()], { now: NOW });
  ({ store } = setStatus(store, "L-0001", "dismissed", { reason: "handled", now: NOW }));
  const f = findById(store, "L-0001");
  assert.equal(f.status, "dismissed");
  assert.equal(f.dismissReason, "handled");
  assert.deepEqual(f.evidence, []);
  assert.equal(f.title, "Builder failed (ambiguous criteria)");
});

test("selectFindings filters by status/kind and pruneEvidence respects the window", () => {
  let { store } = reconcile(emptyStore(), [finding(), finding({ kind: "success", fingerprint: "clean-delivery:backend:codex:low", targetRole: null })], { now: NOW });
  assert.equal(selectFindings(store, { status: "open", kind: "failure" }).length, 1);
  ({ store } = pruneEvidence(store, { days: 1, now: "2027-01-01T00:00:00Z" }));
  assert.ok(store.findings.every((f) => f.evidence.length === 0));
});

test("knowledge entries render and parse round-trip with stable ids", () => {
  const entry = entryFromFinding({ ...finding(), id: "L-0007" }, { now: NOW });
  assert.equal(entry.fileKey, targetFileForFinding(finding()));
  let body = "# Lessons Learned\n\n<!-- Learning Agent appends entries below this line. -->\n";
  const first = appendEntryToBody(body, entry, { now: NOW });
  assert.ok(first.appended);
  assert.match(first.id, /^LL-2026-001$/);
  const again = appendEntryToBody(first.body, entryFromFinding({ ...finding(), id: "L-0007" }, { now: NOW }), { now: NOW });
  assert.equal(again.appended, false, "same finding is not appended twice");
  const parsed = readEntries(first.body);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "LL-2026-001");
  assert.equal(nextEntryId(first.body, "LL", "2026"), "LL-2026-002");
});

test("renderDigest lists open patterns and recurred findings", () => {
  let { store } = reconcile(emptyStore(), [
    finding({ kind: "pattern", fingerprint: "p1", occurrences: 3, title: "Recurring X" }),
    finding({ kind: "failure", fingerprint: "f1", title: "One-off Y" }),
  ], { now: NOW });
  const text = renderDigest({ store, analysis: { analyzedTasks: 5 }, now: NOW });
  assert.match(text, /Analyzed 5 terminal task/);
  assert.match(text, /Recurring X/);
  assert.match(text, /Top recurring patterns/);
});
