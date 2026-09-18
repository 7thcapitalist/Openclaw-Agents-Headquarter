export const IDLE_REASON_LABELS = Object.freeze({
  "seat-unknown": "Anthropic headroom unknown",
  "founder-active": "founder objective active",
  "founder-queued": "founder work queued",
  "open-pr-cap": "PRs awaiting founder",
  "short-window-low": "short-window headroom below reserve",
  "weekly-low": "weekly headroom below reserve",
  "no-expiring-surplus": "no credit is close to expiring",
  "self-improvement-running": "self-improvement objective already running",
  "daily-cap": "daily self-improvement limit reached",
  "no-eligible-finding": "no eligible finding",
  "open-prs-unknown": "open PR status unknown",
  "launch-recheck-failed": "launch conditions changed before start",
  "not-evaluated": "not evaluated yet",
  "state-unavailable": "learning state unavailable",
});

export function idleReasonLabel(code, state = {}) {
  if (code == null || code === "") return null;
  if (code === "open-pr-cap") {
    const count = Number(state.openPrCount ?? state.openPrsAwaitingFounder);
    if (Number.isFinite(count)) return `${count} PR${count === 1 ? "" : "s"} awaiting founder`;
  }
  return IDLE_REASON_LABELS[code] || String(code);
}
