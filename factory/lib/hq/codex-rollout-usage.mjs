import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Codex writes the session's real usage into its rollout transcript as
// cumulative `total_token_usage`. The envelope the harness hands back carries
// only a per-message fragment (in=410 out=349 for a 36-attempt builder node),
// which is why the ledger booked ~$0.085 against ~$98 of real spend.
// `input_tokens` there INCLUDES the cached portion, so the fresh input is the
// difference — the ledger convention is tokensIn = uncached, cached separate.

export function readRolloutUsage(path) {
  let last = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes("total_token_usage")) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const total = row?.payload?.info?.total_token_usage ?? row?.info?.total_token_usage ?? row?.total_token_usage;
    if (total && Number.isFinite(Number(total.input_tokens))) last = total;
  }
  if (!last) return null;
  const input = Number(last.input_tokens) || 0;
  const cached = Math.min(Number(last.cached_input_tokens) || 0, input);
  return { tokensIn: input - cached, cachedInputTokens: cached, tokensOut: Number(last.output_tokens) || 0 };
}

export function codexSessionsDir(agentId, home = homedir()) {
  return join(home, ".openclaw", "agents", agentId, "agent", "codex-home", "sessions");
}

function listRollouts(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listRollouts(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

// A rollout belongs to a dispatch only if its transcript carries that dispatch's
// result path: the handoff prompt names `results/<dispatchId>.json`, and dispatch
// ids are unique for the life of the task. mtime alone cannot tell two
// overlapping runs of the same agent apart, so it is only a cheap pre-filter.
function rolloutBelongsTo(file, dispatchId) {
  return readFileSync(file, "utf8").includes(`results/${dispatchId}.json`);
}

// Replace a Codex dispatch's fragment usage with the rollout's session totals.
// Sums only the rollouts that name this dispatch; with no dispatchId, or no
// match, the original meta is returned untouched (never worse than before,
// never another run's spend).
export function withRolloutUsage(meta, { agentId, dispatchId, startedAtMs, sessionsDir = codexSessionsDir(agentId) } = {}) {
  if (!meta || meta.provider !== "openai" || !agentId || !dispatchId) return meta;
  try {
    const sum = { tokensIn: 0, cachedInputTokens: 0, tokensOut: 0 };
    let found = 0;
    for (const file of listRollouts(sessionsDir)) {
      if (statSync(file).mtimeMs < startedAtMs) continue;
      if (!rolloutBelongsTo(file, dispatchId)) continue;
      const usage = readRolloutUsage(file);
      if (!usage) continue;
      sum.tokensIn += usage.tokensIn; sum.cachedInputTokens += usage.cachedInputTokens; sum.tokensOut += usage.tokensOut; found += 1;
    }
    return found ? { ...meta, ...sum } : meta;
  } catch {
    return meta;
  }
}
