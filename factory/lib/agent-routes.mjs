// Which model route a retry should use after one has proved it will not deliver.
//
// The factory picks a runtime AGENT id (openclaw-runner.selectAgentId); OpenClaw
// then picks the MODEL for that agent from a chain in its own config. That chain
// fails over on a provider error — a quota refusal, an unreachable endpoint. It
// does not fail over when the agent is reached, answers, ends its turn, and
// simply never writes the result file the gate protocol requires: from the
// provider's side that turn succeeded, so nothing rotates and the retry lands on
// the identical route. openclaw-runner already says as much in the diagnostic it
// writes ("retrying it unchanged will repeat"); this module is what lets the
// retry act on it.
//
// Node builtins only.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultOpenClawConfigPath() {
  return process.env.OPENCLAW_CONFIG || join(homedir(), ".openclaw", "openclaw.json");
}

// "anthropic/claude-sonnet-5" -> "anthropic". A bare model id has no provider,
// which is treated as its own bucket rather than as a match for everything.
export function providerOf(route) {
  const text = String(route || "").trim();
  if (!text) return "";
  const slash = text.indexOf("/");
  return slash > 0 ? text.slice(0, slash) : text;
}

function chainFrom(model) {
  if (!model || typeof model !== "object") return [];
  const out = [];
  for (const entry of [model.primary, ...(Array.isArray(model.fallbacks) ? model.fallbacks : [])]) {
    const route = String(entry || "").trim();
    if (route && !out.includes(route)) out.push(route);
  }
  return out;
}

// The routes available to one runtime agent, in preference order: its own chain
// when it declares one, otherwise the defaults it inherits. An agent with no
// configured model is not an error — OpenClaw resolves it — it just means this
// module has nothing to rotate through and says so with an empty chain.
export function readAgentChain(agentId, { configPath = defaultOpenClawConfigPath(), config = null } = {}) {
  let parsed = config;
  if (!parsed) {
    if (!agentId || !existsSync(configPath)) return [];
    try { parsed = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { return []; }
  }
  const agents = parsed?.agents;
  if (!agents || typeof agents !== "object") return [];
  const entries = agents.entries && typeof agents.entries === "object" ? agents.entries : agents.items;
  const entry = Array.isArray(entries)
    ? entries.find((item) => item?.id === agentId)
    : (entries && typeof entries === "object" ? entries[agentId] : null);
  const own = chainFrom(entry?.model);
  if (own.length) return own;
  return chainFrom(agents.defaults?.model);
}

// The next route to try, given the ones that already ran without delivering.
//
// A different PROVIDER is preferred over merely a different model: the failure
// this exists for is a seat/session problem, and a sibling model on the same
// provider seat reproduces it. Falling back to any unexhausted route keeps a
// single-provider host working rather than stranding it.
export function nextRoute(chain, { exhausted = [] } = {}) {
  const spent = new Set((exhausted || []).map((route) => String(route || "").trim()).filter(Boolean));
  if (!spent.size) return null;
  const available = (chain || []).filter((route) => !spent.has(route));
  if (!available.length) return null;
  const spentProviders = new Set([...spent].map(providerOf));
  return available.find((route) => !spentProviders.has(providerOf(route))) || available[0];
}

// The whole decision in one call, for the runner: null means "change nothing".
export function rotatedRouteFor(agentId, exhausted, options = {}) {
  if (!exhausted?.length) return null;
  return nextRoute(readAgentChain(agentId, options), { exhausted });
}
