// Worker-thread fixture: applies one patch to a specific node inside a real
// objective-state.json-shaped document via mutateTransactionalState — the
// exact primitive factory/lib/objective/orchestrator.mjs's patchNode() uses
// — to prove concurrent node completions on one objective cannot clobber
// each other (this campaign's own PROBLEM statement example).
import { parentPort, workerData } from "node:worker_threads";
import { mutateTransactionalState } from "../../../lib/store/transactional-json.mjs";

const { objectivePath, nodeId } = workerData;
mutateTransactionalState(objectivePath, {
  commandId: `patch-${nodeId}`,
  mutate: (state) => {
    const next = structuredClone(state);
    next.nodes[nodeId] = { ...next.nodes[nodeId], status: "gate-satisfied" };
    next.events.push({ at: new Date().toISOString(), type: "node-completed", node: nodeId });
    return next;
  },
});
parentPort.postMessage({ ok: true });
