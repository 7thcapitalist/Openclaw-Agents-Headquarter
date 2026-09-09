import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findQuestion, listPendingQuestions, recordQuestion, updateQuestion } from "../../dashboard/backend/lib/founderControlPlane.mjs";

test("founder questions persist lifecycle state and can be resumed", () => {
  const root = mkdtempSync(join(tmpdir(), "founder-questions-"));
  const created = recordQuestion(root, {
    id: "question-demo",
    agentId: "main",
    question: "What is blocking the factory?",
    status: "queued",
    askedAt: "2026-09-09T00:00:00.000Z",
  });

  assert.equal(created.status, "queued");
  assert.deepEqual(listPendingQuestions(root).map((item) => item.id), ["question-demo"]);
  assert.equal(updateQuestion(root, "question-demo", { status: "running" }).status, "running");
  assert.equal(findQuestion(root, "question-demo").status, "running");
  assert.equal(updateQuestion(root, "question-demo", { status: "answered", answer: "Nothing is blocked." }).answer, "Nothing is blocked.");
  assert.deepEqual(listPendingQuestions(root), []);
});

test("founder question UI uses an asynchronous status endpoint", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../../dashboard/backend/public/app.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../../dashboard/backend/server.mjs", import.meta.url), "utf8");
  assert.match(server, /res\.status\(202\)\.json\(\{ question: item \}\)/);
  assert.match(server, /app\.get\("\/api\/founder\/questions\/:id"/);
  assert.match(app, /\/api\/founder\/questions\/\$\{encodeURIComponent\(id\)\}/);
  assert.match(app, /setInterval\(refresh, 2000\)/);
});
