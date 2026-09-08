import { noneAdapter } from "./adapters/none.mjs";
import { vercelAdapter } from "./adapters/vercel.mjs";

export const defaultAdapters = Object.freeze({ vercel: vercelAdapter, none: noneAdapter });

export function selectProvider(manifest, { adapters = defaultAdapters, config = null } = {}) {
  const id = manifest?.provider ?? config?.deploy?.defaultProvider ?? "vercel";
  const adapter = adapters[id];
  if (!adapter || typeof adapter.deploy !== "function") throw new Error(`Unknown deployment provider: ${id}`);
  if (adapter.id !== id) throw new Error(`Deployment provider adapter "${id}" has mismatched id "${adapter.id}".`);
  adapter.validateConfig?.(manifest);
  return adapter;
}
