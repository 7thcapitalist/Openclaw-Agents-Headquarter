// The overnight plan, shaped for the mirror.
//
// The founder plans a night's work in the local dashboard: a short list of
// objectives, run one after another while he is asleep. The console has never
// been able to show it, because there is no `overnight` panel in the snapshot —
// so "what is the factory doing tonight" is a question only answerable from the
// tunnel, and a plan the console cannot see is a plan it must not offer to
// change.
//
// WHY THE QUEUE IS INJECTED RATHER THAN READ. `readOvernightQueue` lives in
// `dashboard/backend/lib/overnightQueue.mjs`, and `factory/` must not import
// from `dashboard/` — the dependency runs the other way round. This module is
// therefore a pure shaper: the publisher script reads the queue and hands it
// here, exactly as it already does for `tasks`.
//
// WHAT IS DROPPED ON THE WAY OUT. Each queue item carries `repo`, an absolute
// path on this machine. `mirror.mjs` would strip it, but relying on that would
// mean publishing a host path and trusting a later walk to catch it. It is
// dropped here, at the point where the shape is decided.

export const OVERNIGHT_CONTRACT = "hq.overnight/1";

// The queue's own vocabulary, kept rather than translated: these are the exact
// strings the local dashboard shows, and one screen that renames them is how
// the two surfaces start meaning different things by the same word.
const ITEM_STATUSES = ["queued", "running", "complete", "failed"];
const RUN_STATUSES = ["idle", "running", "stopped", "complete", "needs-attention"];

function text(value, fallback = null) {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s : fallback;
}

function iso(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Shape one overnight queue into a panel.
 *
 * Never throws: a malformed queue file costs this one panel, not the snapshot.
 * An unreadable queue is reported as `unavailable` with a reason, which is the
 * convention every other panel follows and the only honest thing to render.
 *
 * @param {object|null} queue   the value of readOvernightQueue(), or null
 * @param {object}      options
 * @param {number}      options.limit  how many objectives a plan may hold
 */
export function buildOvernightPanel(queue, { limit = null, now = new Date(), reason = null } = {}) {
  const asOf = (now instanceof Date ? now : new Date(now)).toISOString();

  if (!queue || typeof queue !== "object") {
    return {
      version: 1,
      contract: OVERNIGHT_CONTRACT,
      asOf,
      available: false,
      reason: reason || "The overnight plan could not be read on the factory machine.",
      items: [],
      summary: emptySummary(),
    };
  }

  const rawItems = Array.isArray(queue.items) ? queue.items : [];
  const items = rawItems.map((item, index) => ({
    id: text(item?.id, `item-${index}`),
    objective: text(item?.objective, "(no objective recorded)"),
    projectId: text(item?.projectId),
    status: ITEM_STATUSES.includes(item?.status) ? item.status : "queued",
    addedAt: iso(item?.addedAt),
    startedAt: iso(item?.startedAt),
    endedAt: iso(item?.endedAt),
    // The queue records a founder-readable sentence on failure; the raw exit
    // code is not one and stays on the machine.
    error: text(item?.error),
    // `repo` is deliberately absent. See the header.
  }));

  const counts = Object.fromEntries(ITEM_STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
  const status = RUN_STATUSES.includes(queue.status) ? queue.status : "idle";

  return {
    version: 1,
    contract: OVERNIGHT_CONTRACT,
    asOf,
    available: true,
    status,
    startedAt: iso(queue.startedAt),
    stoppedAt: iso(queue.stoppedAt),
    currentItemId: text(queue.currentItemId),
    // The runner checks this between objectives, so a stop request is pending
    // until the one in flight finishes. The console must say that rather than
    // implying the run already died.
    stopRequested: Boolean(queue.stopRequested),
    limit: Number.isFinite(limit) ? limit : null,
    full: Number.isFinite(limit) ? items.length >= limit : false,
    items,
    summary: {
      total: items.length,
      // Counts of items, kept under their own key. A flat spread here collided
      // `running` (how many objectives are running) with `running` (is the run
      // going) — two different facts that must not share a name.
      counts,
      // "Is there a plan at all" and "is it going" are different questions and
      // the console asks both.
      planned: items.length > 0,
      isRunning: status === "running",
      needsAttention: status === "needs-attention" || counts.failed > 0,
    },
  };
}

function emptySummary() {
  return {
    total: 0,
    counts: { queued: 0, running: 0, complete: 0, failed: 0 },
    planned: false, isRunning: false, needsAttention: false,
  };
}
