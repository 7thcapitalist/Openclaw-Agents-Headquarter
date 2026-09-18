import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { idleTriggerConfig } from "./decide.mjs";
import { mutateTransactionalState, readTransactionalState } from "../store/transactional-json.mjs";

export const IDLE_MODES = Object.freeze(["off", "shadow", "on"]);

export function idleModePath(stateRoot) {
  return join(resolve(stateRoot), "_idle-trigger", "mode.json");
}

export function readModeOverride(stateRoot) {
  const path = idleModePath(stateRoot);
  if (!existsSync(path)) return null;
  try {
    const value = readTransactionalState(path);
    return IDLE_MODES.includes(value?.mode) ? value : null;
  } catch {
    return null;
  }
}

export function setIdleMode(stateRoot, mode, { by = "founder", now = new Date().toISOString() } = {}) {
  if (!IDLE_MODES.includes(mode)) throw Object.assign(new Error("mode must be off, shadow, or on"), { statusCode: 422 });
  const next = { version: 1, mode, setBy: String(by || "founder").slice(0, 80), at: now };
  return mutateTransactionalState(idleModePath(stateRoot), {
    commandId: `idle-mode:${randomUUID()}`,
    replayable: false,
    mutate: () => next,
    toResponse: (state) => state,
  });
}

export function effectiveMode(config = {}, stateRoot) {
  const override = stateRoot ? readModeOverride(stateRoot) : null;
  return override
    ? { mode: override.mode, source: "override", override }
    : { mode: idleTriggerConfig(config).mode, source: "config", override: null };
}
