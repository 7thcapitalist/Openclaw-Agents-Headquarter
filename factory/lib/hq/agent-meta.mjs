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
