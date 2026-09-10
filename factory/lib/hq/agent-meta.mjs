function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickInteger(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function parseEnvelope(source) {
  const text = typeof source?.stdout === "string" ? source.stdout.trim() : "";
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return asObject(parsed);
  } catch {
    return null;
  }
}

export function parseAgentMeta(source, { durationMsFallback = null } = {}) {
  const envelope = parseEnvelope(source);
  if (!envelope) return null;
  if (envelope.ok === false || envelope.status === "error" || envelope.status === "timeout") return null;

  const meta = asObject(envelope.meta?.agentMeta)
    || asObject(envelope.agentMeta)
    || asObject(envelope.result?.agentMeta)
    || asObject(envelope.meta)
    || null;
  const usage = asObject(meta?.usage)
    || asObject(envelope.usage)
    || asObject(envelope.result?.usage)
    || null;

  const nested = findUsageEnvelope(envelope);
  const provider = pickString(meta?.provider, envelope.provider, envelope.modelProvider, envelope.result?.provider, nested?.provider);
  const model = pickString(meta?.model, envelope.model, envelope.result?.model, nested?.model);
  const tokensIn = pickInteger(
    usage?.tokensIn,
    usage?.input,
    envelope.tokensIn,
    envelope.inputTokens,
    envelope.result?.tokensIn,
    envelope.result?.inputTokens,
    nested?.tokensIn,
  );
  const tokensOut = pickInteger(
    usage?.tokensOut,
    usage?.output,
    envelope.tokensOut,
    envelope.outputTokens,
    envelope.result?.tokensOut,
    envelope.result?.outputTokens,
    nested?.tokensOut,
  );
  if (!provider || !model || tokensIn == null || tokensOut == null) return null;

  let durationMs = pickInteger(meta?.durationMs, envelope.durationMs, envelope.result?.durationMs);
  if (durationMs == null && Number.isFinite(durationMsFallback)) {
    durationMs = Math.max(0, Math.trunc(durationMsFallback));
  }

  const record = { provider, model, tokensIn, tokensOut };
  if (durationMs != null) record.durationMs = durationMs;
  return record;
}

function findUsageEnvelope(value, depth = 0) {
  if (!asObject(value) || depth > 5) return null;
  const usage = asObject(value.usage) || asObject(value.tokenUsage) || asObject(value.usageStats);
  if (usage) {
    const provider = pickString(value.provider, value.modelProvider, value.model?.provider);
    const model = pickString(value.model, value.modelId, value.modelName);
    const tokensIn = pickInteger(usage.tokensIn, usage.input, usage.inputTokens, usage.promptTokens, usage.prompt_tokens);
    const tokensOut = pickInteger(usage.tokensOut, usage.output, usage.outputTokens, usage.completionTokens, usage.completion_tokens);
    if (provider && model && tokensIn != null && tokensOut != null) return { provider, model, tokensIn, tokensOut };
  }
  for (const child of Object.values(value)) {
    const found = findUsageEnvelope(child, depth + 1);
    if (found) return found;
  }
  return null;
}

// Did the agent actually run and finish its turn, and simply not write the
// result file it was asked for?
//
// This is the difference between "the model could not be reached" and "the
// model answered, said it would start, and stopped" — which look identical
// from the outside (both leave no result file) but need opposite handling.
// The first is worth retrying as-is; the second will repeat forever on the
// same route, and the auto-retry sweep only revives infra-class blockers, so
// mislabelling the second as infra spends the task's revival budget on a
// dispatch that cannot succeed.
//
// Deliberately conservative: only an explicit success signal counts. Anything
// unrecognised returns completed:false and keeps the previous behaviour.
export function describeAgentCompletion(source) {
  const envelope = parseEnvelope(source);
  const unknown = { completed: false, provider: null, model: null, stopReason: null };
  if (!envelope) return unknown;
  if (envelope.ok === false || envelope.status === "error" || envelope.status === "timeout") return unknown;

  const result = asObject(envelope.result) || envelope;
  const trace = asObject(result.executionTrace) || asObject(envelope.executionTrace);
  const completion = asObject(result.completion) || asObject(envelope.completion);
  const stopReason = pickString(
    result.stopReason,
    envelope.stopReason,
    completion?.stopReason,
    completion?.finishReason,
  );
  const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
  const succeeded = attempts.some((attempt) => asObject(attempt)?.result === "success");

  // A turn that stopped normally, or a provider attempt that reported success.
  if (stopReason !== "stop" && !succeeded) return unknown;

  return {
    completed: true,
    provider: pickString(trace?.winnerProvider, result.provider, envelope.provider),
    model: pickString(trace?.winnerModel, result.model, envelope.model),
    stopReason,
  };
}
