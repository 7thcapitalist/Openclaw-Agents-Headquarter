// The delivery half that mirror.mjs deliberately omits.
//
// `factory/lib/hq/mirror.mjs` builds the one object allowed to cross the
// publish boundary and performs no network I/O — asserted from its source by
// test. That split is the same one `connector-outbox.mjs` makes: deciding WHAT
// may leave the machine is kept apart from the act of SENDING it, so that the
// rule about what may leave cannot be quietly widened by a caller in a hurry.
//
// This module is the sending half, and it keeps the split honest by importing
// the boundary rather than reimplementing it. Every panel it gathers goes
// through `buildMirrorSnapshot()`; there is no path here that writes a field
// straight to the network.
//
// Direction is the other invariant. Everything here is outbound: the machine
// opens a connection to the control plane and closes it. Nothing in this file
// listens, and a failure to publish is never allowed to become a failure of the
// factory — a stale mirror is the designed degradation (DC-2026-003 rollback
// level 1 is "stop the publisher").

import { buildAgentScorecards } from "./agent-scorecards.mjs";
import { buildBudgetSnapshot } from "./budget-snapshot.mjs";
import { buildCompanyState } from "./company-state.mjs";
import { buildDecisionHistory } from "./decision-history.mjs";
import { buildDeploymentsSnapshot } from "./deployments.mjs";
import { buildGoalsSnapshot } from "./goals.mjs";
import { buildOperationsSnapshot } from "./operations.mjs";
import { buildMirrorSnapshot, MIRROR_CONTRACT } from "./mirror.mjs";

// One slow or broken panel must not cost the whole publish. A mirror missing
// one section and saying so is worth more than no mirror at all, so each source
// is gathered independently and a failure is recorded as data rather than
// thrown.
async function gather(name, produce) {
  try {
    return { name, value: await produce() };
  } catch (error) {
    return { name, value: { unavailable: true, reason: String(error?.message || error).slice(0, 200) } };
  }
}

/**
 * Collect every panel the local dashboard renders.
 *
 * Runs in-process on the factory machine and reads the same builders the
 * dashboard routes use, rather than calling the dashboard over HTTP — the
 * publisher must keep working when the dashboard process is down, since the
 * two fail for different reasons.
 *
 * `tasks` is injected rather than discovered here. Task discovery lives in
 * `dashboard/backend/lib/`, and `factory/` must not import from `dashboard/`:
 * the dependency runs the other way round, and inverting it here would make
 * the factory's libraries need the dashboard in order to load.
 */
export async function collectSources({ hqRoot, tasks = [], now = new Date() } = {}) {
  const panels = await Promise.all([
    gather("company", () => buildCompanyState({ hqRoot, tasks, now })),
    gather("goals", () => buildGoalsSnapshot({ hqRoot })),
    gather("decisions", () => buildDecisionHistory({ hqRoot })),
    gather("operations", () => buildOperationsSnapshot({ hqRoot })),
    gather("deployments", () => buildDeploymentsSnapshot({ hqRoot })),
    gather("scorecards", () => buildAgentScorecards({ hqRoot })),
    gather("budgets", () => buildBudgetSnapshot({ hqRoot })),
  ]);

  return Object.fromEntries(panels.map(({ name, value }) => [name, value]));
}

/**
 * Build the snapshot that will cross the boundary.
 *
 * Nothing is trusted to have been clean on the way in: every panel above is
 * passed through `buildMirrorSnapshot()`, which walks the whole structure and
 * strips secrets, host paths, reasoning blocks and oversized fields whatever
 * key they sit under.
 */
export async function buildSnapshot({ hqRoot, tasks = [], publisher = "factory-machine", now = new Date() } = {}) {
  const sources = await collectSources({ hqRoot, tasks, now });
  return buildMirrorSnapshot({
    hqRoot,
    sources,
    now: now.toISOString(),
    publisher,
  });
}

// Remove the credential from any text on its way back out of this module.
//
// This exists because the obvious implementation leaks: returning a failed
// response's body verbatim hands the caller whatever the endpoint chose to say,
// and an endpoint that reflects its Authorization header would put the token in
// a log file that outlives the request. A rotatable credential that has been
// written to a log is no longer rotatable on the founder's schedule.
function withoutCredential(text, credential) {
  if (!text || !credential) return text || "";
  return text.split(credential).join("[redacted]");
}

/**
 * Deliver one snapshot. Outbound only.
 *
 * The credential is read from the environment and never logged, never returned,
 * and never placed in an error message — a publisher that prints its own token
 * on failure is how a rotatable credential becomes a permanent one.
 */
export async function publishSnapshot({
  snapshot,
  endpoint = process.env.HQ_CONTROL_PLANE_URL,
  token = process.env.HQ_WRITE_TOKEN,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
} = {}) {
  if (!endpoint) return { ok: false, reason: "HQ_CONTROL_PLANE_URL is not configured" };
  if (!token) return { ok: false, reason: "HQ_WRITE_TOKEN is not configured" };
  if (snapshot?.contract !== MIRROR_CONTRACT) {
    return { ok: false, reason: `snapshot contract must be ${MIRROR_CONTRACT}` };
  }

  const url = new URL("/api/mirror", endpoint).toString();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(snapshot),
      signal: abort.signal,
    });
    if (!response.ok) {
      // The status is useful. The body is not trusted: an endpoint that is
      // misconfigured, or hostile, can echo back what it was sent — including
      // the credential in the Authorization header. Bounding the text is not
      // enough, because the token would fit well inside the bound. Strip it
      // explicitly before it can reach a caller, a log, or a pm2 file.
      const detail = await response.text().catch(() => "");
      return { ok: false, status: response.status, reason: withoutCredential(detail, token).slice(0, 200) };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    if (error?.name === "AbortError") return { ok: false, reason: `timed out after ${timeoutMs}ms` };
    return { ok: false, reason: String(error?.message || error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build and deliver once.
 *
 * Returns a result rather than throwing. The caller is a loop on the founder's
 * machine, and an unhandled rejection there would stop publishing silently —
 * which looks exactly like a healthy publisher with nothing to say.
 */
export async function publishOnce({ hqRoot, tasks = [], publisher, endpoint, token, fetchImpl, now = new Date() } = {}) {
  let snapshot;
  try {
    snapshot = await buildSnapshot({ hqRoot, tasks, publisher, now });
  } catch (error) {
    return { ok: false, reason: `snapshot build failed: ${String(error?.message || error).slice(0, 200)}` };
  }

  const result = await publishSnapshot({ snapshot, endpoint, token, fetchImpl });
  return {
    ...result,
    publishedAt: snapshot.publishedAt,
    // Counts and kinds only. The redaction report is the one place a publisher
    // could accidentally write down the secret it just removed.
    redaction: snapshot.redaction,
    panels: Object.keys(snapshot.panels || {}),
  };
}
