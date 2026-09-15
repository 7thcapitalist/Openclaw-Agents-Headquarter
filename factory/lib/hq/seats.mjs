// Which model seat a role actually routes to.
//
// The console needs to answer "what is this agent running on", and nothing
// emitted it. `harness` is the family (openclaw / claude / codex), not the seat:
// it does not tell you that the reviewer routes to anthropic/claude-sonnet-5.
//
// Two sources, in order of honesty:
//   1. the live runtime (`openclaw agents list --json`), which is what is
//      actually loaded right now
//   2. ~/.openclaw/openclaw.json, the configured seat
//
// The runtime is preferred and the config is the fallback, because the runtime
// read is frequently unavailable — every agent in the live mirror carries
// `runtimeResolved: false` and the whole `runtime` panel is null. Reporting no
// seat at all in that case, when the configuration plainly states one, is less
// useful than reporting the configured seat and saying that is what it is.

import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** Strip an `@version` suffix; `openai/gpt-5.6-sol@2` and `…-sol` are one seat. */
export function cleanSeat(model) {
  if (!model || typeof model !== "string") return null;
  return model.split("@")[0].trim() || null;
}

function normalizeModel(model) {
  if (!model) return null;
  if (typeof model === "string") return { primary: cleanSeat(model), fallbacks: [] };
  const primary = cleanSeat(model.primary);
  if (!primary) return null;
  return { primary, fallbacks: (Array.isArray(model.fallbacks) ? model.fallbacks : []).map(cleanSeat).filter(Boolean) };
}

/**
 * Read the configured seat per runtime agent id. Never throws: an unreadable or
 * absent config costs the seat column, never the snapshot.
 */
export function readConfiguredSeats({ configPath = join(homedir(), ".openclaw", "openclaw.json") } = {}) {
  try {
    if (!existsSync(configPath)) return { seats: {}, defaultSeat: null };
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const defaultSeat = normalizeModel(config?.agents?.defaults?.model);
    const seats = {};
    for (const [id, entry] of Object.entries(config?.agents?.entries || {})) {
      const explicit = normalizeModel(entry?.model);
      if (explicit) { seats[id] = explicit; continue; }
      // An entry may instead list the models it is allowed to load, in which
      // case the first is the seat it takes by default.
      const listed = Object.keys(entry?.models || {}).map(cleanSeat).filter(Boolean);
      if (listed.length) seats[id] = { primary: listed[0], fallbacks: listed.slice(1) };
    }
    return { seats, defaultSeat };
  } catch {
    return { seats: {}, defaultSeat: null };
  }
}

/**
 * The seat for one role. `runtimeModel` is what the live runtime reports, if
 * anything. Returns null when neither source knows, so the console can say
 * "unknown" rather than invent one.
 */
export function resolveSeat({ runtimeAgentId, runtimeModel = null, seats = {}, defaultSeat = null }) {
  const live = cleanSeat(runtimeModel);
  if (live) return { primary: live, fallbacks: [], source: "runtime" };
  const configured = runtimeAgentId ? seats[runtimeAgentId] : null;
  if (configured) return { ...configured, source: "config" };
  if (defaultSeat) return { ...defaultSeat, source: "config-default" };
  return null;
}
