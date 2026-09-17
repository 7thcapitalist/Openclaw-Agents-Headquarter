// Ids of every task that is a node of an objective the founder cancelled.
//
// Cancelling writes the objective only; its nodes' task states keep whatever
// status and blocker they stopped with. Anything that reads task states on its
// own has to ask this, or it acts on work the founder ended:
//
//   * the Founder Inbox and the console kept asking for decisions on six
//     cancelled duplicates on 2026-09-16 (#293);
//   * the auto-retry sweep would revive a cancelled objective's task that was
//     left `active` — lifemaxing obj-d4e18cad-integration sat exactly like that
//     after its objective was cancelled, and would have re-run its review.
//
// Pure read of `<stateRoot>/<project>/objectives/<id>/objective-state.json`.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export function cancelledObjectiveTaskIds(stateRoot) {
  const ids = new Set();
  if (!existsSync(stateRoot)) return ids;
  for (const project of readdirSync(stateRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const objDir = join(stateRoot, project.name, "objectives");
    if (!existsSync(objDir)) continue;
    for (const entry of readdirSync(objDir, { withFileTypes: true })) {
      const path = join(objDir, entry.name, "objective-state.json");
      if (!existsSync(path)) continue;
      let obj;
      try { obj = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
      if (obj.status !== "cancelled") continue;
      for (const node of [...Object.values(obj.nodes || {}), obj.integration]) {
        if (node?.id) ids.add(node.id);
      }
    }
  }
  return ids;
}
