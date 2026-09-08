import { readDeploymentState } from "./store.mjs";

export function emptyDeploymentStatus() {
  return {
    state: "not_deployed",
    productionUrl: null,
    health: null,
    lastDeploymentAt: null,
    founderActionRequired: false,
  };
}

export function readDeploymentStatus({ hqRoot, projectKey, onError = null }) {
  try {
    const state = readDeploymentState({ hqRoot, projectKey });
    if (!state) return emptyDeploymentStatus();
    return {
      state: state.state,
      productionUrl: state.productionUrl || null,
      health: state.health || null,
      lastDeploymentAt: state.lastDeploymentAt || null,
      founderActionRequired: Boolean(state.founderActionRequired),
    };
  } catch (error) {
    onError?.(error);
    return emptyDeploymentStatus();
  }
}
