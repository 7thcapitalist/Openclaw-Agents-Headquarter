// Read-only model-seat credit headroom.
//
// Numeric headroom is reported only when it was read from `openclaw models
// status`. Seat-pause history can add context to an unknown record, but it
// never supplies or implies a numeric value and never upgrades the status.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { cleanSeat, readConfiguredSeats, resolveSeat } from "./hq/seats.mjs";
import { parseUsageWindow } from "./model-usage-window.mjs";

const DEFAULT_LOOKBACK_HOURS = 24;

function normalizedLookback(value) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_LOOKBACK_HOURS;
}

function timestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function describeUnknownReason(seat, modelsOut) {
  const output = String(modelsOut || "");
  const escapedSeat = seat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`${escapedSeat}[^\\n]*(?:\\[indeterminate\\]|\\bindeterminate\\b)`, "i").test(output)) {
    return "openclaw models status reports this seat as [indeterminate]";
  }
  if (seat.split("/")[0] === "openai") {
    return "openclaw models status did not report a 5h usage window for this seat";
  }
  return "openclaw models status does not report a numeric usage window for this seat";
}

function inferredSeatHistory({ roles, seatPauses, now, lookbackHours }) {
  const nowMs = timestamp(now) ?? Date.now();
  const since = nowMs - lookbackHours * 60 * 60 * 1000;
  const roleSet = new Set(roles);
  const recent = (Array.isArray(seatPauses) ? seatPauses : []).filter((pause) => {
    const at = timestamp(pause?.at);
    return roleSet.has(pause?.actor) && at !== null && at >= since && at <= nowMs;
  });
  const roleList = roles.join(", ") || "(none)";

  if (recent.length) {
    return {
      basis: "recent-seat-exhaustion-events",
      windowHours: lookbackHours,
      sampleCount: recent.length,
      note: `${recent.length} seatExhausted dispatch(es) were recorded for role(s) ${roleList} in the last ${lookbackHours}h. This is an inference from seat-exhaustion events, not a direct read of remaining headroom.`,
    };
  }
  return {
    basis: "no-recent-seat-exhaustion-events",
    windowHours: lookbackHours,
    note: `No seatExhausted dispatches were recorded for role(s) ${roleList} in the last ${lookbackHours}h. This is an inference from the absence of seat-exhaustion events, not a direct read of remaining headroom.`,
  };
}

export function readCreditHeadroom({
  modelsOut = "",
  pipelineSeats = [],
  seatPauses = [],
  now = Date.now(),
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
} = {}) {
  const windows = parseUsageWindow(modelsOut);
  const hours = normalizedLookback(lookbackHours);
  const seats = new Map();

  for (const entry of Array.isArray(pipelineSeats) ? pipelineSeats : []) {
    const seat = cleanSeat(entry?.seat);
    if (!seat) continue;
    if (!seats.has(seat)) seats.set(seat, new Set());
    if (entry?.roleId) seats.get(seat).add(entry.roleId);
  }

  return [...seats.entries()].map(([seat, roleSet]) => {
    const roles = [...roleSet].sort();
    const readable = seat.split("/")[0] === "openai"
      && Number.isFinite(windows.shortWindow?.percentLeft);
    if (readable) {
      return {
        seat,
        roles,
        status: "available",
        shortWindow: windows.shortWindow,
        weekWindow: windows.weekWindow,
        reason: null,
        inference: null,
      };
    }
    return {
      seat,
      roles,
      status: "unknown",
      shortWindow: null,
      weekWindow: null,
      reason: describeUnknownReason(seat, modelsOut),
      inference: inferredSeatHistory({ roles, seatPauses, now, lookbackHours: hours }),
    };
  });
}

export function collectPipelineSeats({ configPath } = {}) {
  const configured = configPath === undefined
    ? readConfiguredSeats()
    : readConfiguredSeats({ configPath });
  return Object.keys(configured.seats).sort().map((roleId) => ({
    roleId,
    resolved: resolveSeat({
      runtimeAgentId: roleId,
      runtimeModel: null,
      seats: configured.seats,
      defaultSeat: configured.defaultSeat,
    }),
  })).filter((entry) => entry.resolved?.primary).map((entry) => ({
    roleId: entry.roleId,
    seat: entry.resolved.primary,
  }));
}

export function collectRecentSeatPauses({
  hqRoot,
  now = Date.now(),
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
} = {}) {
  if (!hqRoot) return [];
  const root = join(hqRoot, "dashboard", "backend", "data", "factory");
  const stateFiles = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "state.json") stateFiles.push(path);
    }
  };
  try { walk(root); } catch { return []; }

  const nowMs = timestamp(now) ?? Date.now();
  const hours = normalizedLookback(lookbackHours);
  const since = nowMs - hours * 60 * 60 * 1000;
  const pauses = [];
  for (const file of stateFiles) {
    let state;
    try { state = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
    for (const dispatch of state.dispatches || []) {
      const at = dispatch?.completedAt || dispatch?.at;
      const atMs = timestamp(at);
      if (!dispatch?.seatExhausted || atMs === null || atMs < since || atMs > nowMs) continue;
      const actor = dispatch.agentId || dispatch.actor;
      if (actor) pauses.push({ actor, stage: dispatch.stage || null, at });
    }
  }
  return pauses;
}

export function readPipelineCreditHeadroom({
  modelsOut = "",
  hqRoot,
  configPath,
  now = Date.now(),
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
} = {}) {
  return readCreditHeadroom({
    modelsOut,
    pipelineSeats: collectPipelineSeats({ configPath }),
    seatPauses: collectRecentSeatPauses({ hqRoot, now, lookbackHours }),
    now,
    lookbackHours,
  });
}
