export const noneAdapter = {
  id: "none",
  async deploy() {
    return { url: null, providerDeploymentId: null, logsUrl: null, notConfigured: true };
  },
};
