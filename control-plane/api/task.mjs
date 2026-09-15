// One task's detail. Read by the founder; written by the factory machine
// alongside the main snapshot.
//
// GET /api/task?id=<taskId> — requires a viewer session, exactly like the
// mirror. There is no POST: this endpoint publishes nothing and the machine
// writes its blobs directly, outbound-only, the same way it writes the mirror.

import { isViewer } from "./_lib/auth.mjs";
import { requestLike, sendJson } from "./_lib/http.mjs";
import { readTaskDetail } from "./_lib/store.mjs";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" }, { allow: "GET" });

    const request = requestLike(req);
    if (!isViewer(request)) return sendJson(res, 401, { error: "unauthorized" });

    const url = new URL(req.url || "/", "https://control.invalid");
    const id = url.searchParams.get("id");
    if (!id) return sendJson(res, 400, { error: "id is required" });

    const detail = await readTaskDetail(id);
    // A task with no published detail and a malformed id are the same answer on
    // purpose: the endpoint never reveals which ids exist to a caller probing.
    if (!detail) return sendJson(res, 404, { error: "no detail published for that task" });
    return sendJson(res, 200, detail);
  } catch (error) {
    if (error?.code === "unconfigured") {
      return sendJson(res, 503, { error: "control plane is not configured", detail: error.message });
    }
    console.error("[task] unhandled error", JSON.stringify({
      name: error?.name ?? null,
      message: String(error?.message ?? error).slice(0, 500),
      status: error?.status ?? error?.statusCode ?? null,
      code: error?.code ?? null,
    }));
    return sendJson(res, 502, { error: "task detail unavailable" });
  }
}
