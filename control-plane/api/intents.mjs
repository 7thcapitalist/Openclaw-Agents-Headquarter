// The founder intent queue endpoint.
//
// POST   { kind, args }   — the founder asks for something (viewer session)
// GET                     — what is queued and what became of it
// GET  ?claim=1           — the factory machine claims pending work (write token)
// PATCH { id, status }    — the machine reports a result (write token)
//
// The two credentials do different things here and neither substitutes for the
// other: a viewer may ASK, and only the machine may CLAIM or REPORT. A stolen
// session can therefore queue a request the founder could already make in the
// local dashboard, and nothing more — it cannot mark work done, and it cannot
// read another machine's claim.
//
// AN INTENT IDENTIFIES AN ACTION. IT NEVER CARRIES A COMMAND. This endpoint
// stores; it does not execute, and it does not decide which kinds are legal.
// That decision lives in factory/lib/integrations/intent-protocol.mjs on the
// machine, which re-validates everything it claims. See _lib/queue.mjs for why
// the allowlist is deliberately not duplicated here.

import { isPublisher, isViewer } from "./_lib/auth.mjs";
import { readJson, requestLike, sendJson } from "./_lib/http.mjs";
import { checkShape, claim, enqueue, listPending, listResults, report } from "./_lib/queue.mjs";

export default async function handler(req, res) {
  try {
    const request = requestLike(req);
    const url = new URL(req.url || "/", "https://control.invalid");

    if (req.method === "GET") {
      // Claiming is a write in everything but HTTP verb, so it takes the write
      // credential — never the viewer session.
      if (url.searchParams.get("claim") === "1") {
        if (!isPublisher(request)) return sendJson(res, 401, { error: "unauthorized" });
        const pending = await listPending({ limit: 20 });
        const claimed = [];
        for (const intent of pending) {
          const record = await claim(intent.id);
          if (record) claimed.push(record);
        }
        return sendJson(res, 200, { claimed });
      }

      if (!isViewer(request)) return sendJson(res, 401, { error: "unauthorized" });
      const [pending, results] = await Promise.all([listPending({ limit: 50 }), listResults({ limit: 25 })]);
      return sendJson(res, 200, { pending, results });
    }

    if (req.method === "POST") {
      if (!isViewer(request)) return sendJson(res, 401, { error: "unauthorized" });

      let body;
      try {
        body = await readJson(req, { maxBytes: 64 * 1024 });
      } catch {
        return sendJson(res, 400, { error: "body is not JSON" });
      }

      const problem = checkShape(body);
      if (problem) return sendJson(res, 422, { error: problem });

      try {
        const id = await enqueue({ kind: body.kind, args: body.args ?? {} });
        // 202, not 200: the founder's action is accepted, not performed. It
        // happens when the machine next polls, and saying so in the status code
        // is the honest version of eventual consistency.
        return sendJson(res, 202, { id, status: "pending" });
      } catch (error) {
        if (error?.code === "queue_full") return sendJson(res, 429, { error: "intent queue is full" });
        throw error;
      }
    }

    if (req.method === "PATCH") {
      if (!isPublisher(request)) return sendJson(res, 401, { error: "unauthorized" });

      let body;
      try {
        body = await readJson(req, { maxBytes: 64 * 1024 });
      } catch {
        return sendJson(res, 400, { error: "body is not JSON" });
      }

      const id = body?.id;
      const status = body?.status;
      if (typeof id !== "string" || !id) return sendJson(res, 422, { error: "id is required" });
      if (!["done", "failed", "rejected"].includes(status)) {
        return sendJson(res, 422, { error: "status must be done, failed or rejected" });
      }

      const record = await report(id, { status, detail: body?.detail ?? null });
      return sendJson(res, 200, record);
    }

    return sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, POST, PATCH" });
  } catch (error) {
    if (error?.code === "unconfigured") {
      return sendJson(res, 503, { error: "control plane is not configured", detail: error.message });
    }
    console.error("[intents] unhandled error", JSON.stringify({
      name: error?.name ?? null,
      message: String(error?.message ?? error).slice(0, 500),
      status: error?.status ?? error?.statusCode ?? null,
      code: error?.code ?? null,
      method: req.method,
    }));
    return sendJson(res, 502, { error: "intent queue unavailable" });
  }
}
