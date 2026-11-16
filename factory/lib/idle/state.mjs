import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { mutateTransactionalState, readTransactionalState } from "../store/transactional-json.mjs";

export function idleStatePath(stateRoot) { return join(resolve(stateRoot), "_idle-trigger", "state.json"); }
export function emptyIdleState() {
  return { version: 1, lastHeartbeatAt: null, lastFingerprint: null, idleReason: "not-evaluated", launches: [], wouldHaveLaunched: [], proposals: [], credit: { usedBySelfImprovement: 0, wouldHaveExpired: 0, basis: "estimate" } };
}
export function readIdleState(stateRoot) {
  const path = idleStatePath(stateRoot);
  if (!existsSync(path)) return emptyIdleState();
  try {
    const stored = readTransactionalState(path);
    return { ...emptyIdleState(), ...stored, credit: { ...emptyIdleState().credit, ...(stored.credit || {}) } };
  }
  catch { return emptyIdleState(); }
}
export function updateIdleState(stateRoot, update) {
  const path = idleStatePath(stateRoot);
  return mutateTransactionalState(path, {
    commandId: `idle-trigger:${randomUUID()}`, replayable: false,
    mutate: (current) => update({ ...emptyIdleState(), ...(current || {}), credit: { ...emptyIdleState().credit, ...(current?.credit || {}) } }),
    toResponse: () => null,
  });
}
export function launchesOnDay(state, now) {
  const day = String(now).slice(0, 10);
  return (state?.launches || []).filter((entry) => String(entry.at).slice(0, 10) === day).length;
}
