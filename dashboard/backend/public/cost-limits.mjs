const MAX_RECENT_TASKS = 12;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value, fallback = "—") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function tokenTotal(item) {
  const total = finiteNumber(item?.totalTokens);
  if (total !== null) return total;
  const input = finiteNumber(item?.tokensIn);
  const output = finiteNumber(item?.tokensOut);
  return input !== null || output !== null ? (input || 0) + (output || 0) : null;
}

function normalizeBucket(bucket) {
  return {
    totalTokens: tokenTotal(bucket),
    estimatedUsd: finiteNumber(bucket?.estimatedUsd),
    taskCount: finiteNumber(bucket?.taskCount),
  };
}

function hasBucketData(bucket) {
  return Object.values(bucket).some((value) => value !== null);
}

export function fmtUsd(value, approximate = false) {
  const amount = finiteNumber(value);
  if (amount === null) return "n/a";
  return `${approximate ? "~" : ""}$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtTokens(value) {
  const amount = finiteNumber(value);
  return amount === null ? "—" : Math.round(amount).toLocaleString("en-US");
}

export function fmtCount(value) {
  const amount = finiteNumber(value);
  return amount === null ? "—" : Math.round(amount).toLocaleString("en-US");
}

function fmtDate(value) {
  if (typeof value !== "string" || !value.trim()) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function normalizeCosts(payload) {
  const ok = Boolean(payload && typeof payload === "object" && !payload.__error);
  const source = ok ? payload : {};
  const recentTasks = Array.isArray(source.recentTasks)
    ? source.recentTasks.slice(0, MAX_RECENT_TASKS).map((task) => ({
      taskId: text(task?.taskId, "Unknown task"),
      objective: text(task?.objective, ""),
      project: text(task?.project, "Global HQ"),
      totalTokens: tokenTotal(task),
      estimatedUsd: finiteNumber(task?.estimatedUsd),
      estimateApprox: task?.hasUnknownPricing === true,
      stages: Array.isArray(task?.stages) ? task.stages.map((stage) => ({
        stage: text(stage?.stage),
        provider: text(stage?.provider),
        model: text(stage?.model),
        totalTokens: tokenTotal(stage),
        estimatedUsd: finiteNumber(stage?.estimatedUsd),
        estimateApprox: stage?.hasUnknownPricing === true,
      })) : [],
    }))
    : [];
  const today = normalizeBucket(source.totals?.today);
  const last7Days = normalizeBucket(source.totals?.last7Days);
  const byProject = Array.isArray(source.totals?.byProject)
    ? source.totals.byProject.map((project) => ({
      project: text(project?.project, "Global HQ"),
      ...normalizeBucket(project),
    }))
    : [];

  return {
    ok,
    empty: ok && recentTasks.length === 0 && byProject.length === 0
      && !hasBucketData(today) && !hasBucketData(last7Days),
    recentTasks,
    aiUsage: normalizeAiUsage(source.aiUsage),
    totals: { today, last7Days, byProject },
  };
}

function normalizeRollups(value) {
  return (Array.isArray(value) ? value : []).map((row) => ({
    ...row,
    totalTokens: tokenTotal(row),
    label: text(row?.label || row?.provider || row?.model || row?.agent || row?.project || row?.objective || row?.taskId || row?.stage, "Unknown"),
    share: finiteNumber(row?.share),
  }));
}

export function normalizeAiUsage(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const capacity = (Array.isArray(source.capacity) ? source.capacity : []).map((provider) => ({
    provider: text(provider?.provider, "unknown"),
    label: text(provider?.label, text(provider?.provider, "unknown")),
    status: text(provider?.status, "unavailable"),
    confidence: text(provider?.confidence, "unavailable"),
    source: text(provider?.source, "unavailable"),
    updatedAt: text(provider?.updatedAt, ""),
    stale: provider?.stale === true,
    reason: text(provider?.reason, "No authoritative remaining-capacity source is available."),
    windows: (Array.isArray(provider?.windows) ? provider.windows : []).map((window) => ({
      name: text(window?.name, "Current window"),
      unit: text(window?.unit, "units"),
      limit: finiteNumber(window?.limit),
      used: finiteNumber(window?.used),
      remaining: finiteNumber(window?.remaining),
      percentRemaining: finiteNumber(window?.percentRemaining),
      resetAt: text(window?.resetAt, ""),
      source: text(window?.source, "unavailable"),
      confidence: text(window?.confidence, "unavailable"),
      note: text(window?.note, ""),
    })),
  }));
  const factory = normalizeUsageSummary(source.factory);
  const otherLocal = {
    available: source.otherLocal?.available === true,
    stale: source.otherLocal?.stale === true,
    updatedAt: text(source.otherLocal?.updatedAt, ""),
    source: text(source.otherLocal?.source, "OpenClaw sessions"),
    error: text(source.otherLocal?.error, ""),
    summary: normalizeUsageSummary(source.otherLocal?.summary),
  };
  return { available: Boolean(value), asOf: text(source.asOf, ""), capacity, runtime: source.runtime || { status: "unavailable", source: "OpenClaw sessions command", updatedAt: "", stale: false, reason: "No runtime snapshot." }, factory, otherLocal, dataQuality: Array.isArray(source.dataQuality) ? source.dataQuality : [] };
}

function normalizeUsageSummary(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    totalTokens: finiteNumber(source.totalTokens),
    records: finiteNumber(source.records),
    usageConfidence: text(source.usageConfidence, "unavailable"),
    byProvider: normalizeRollups(source.byProvider),
    byModel: normalizeRollups(source.byModel),
    byAgent: normalizeRollups(source.byAgent),
    byProject: normalizeRollups(source.byProject),
    byObjective: normalizeRollups(source.byObjective),
    byTask: normalizeRollups(source.byTask),
    byStage: normalizeRollups(source.byStage),
  };
}

export function normalizePlanLimits(payload) {
  const ok = Boolean(payload && typeof payload === "object" && !payload.__error);
  const source = ok ? payload : {};
  const rawProviders = Array.isArray(source.providers) ? source.providers : inferredProviderRows(source);
  const providers = rawProviders.map((provider) => {
    const officialSource = provider?.official && typeof provider.official === "object" ? provider.official : null;
    const official = officialSource ? {
      limit: finiteNumber(officialSource.limit),
      remaining: finiteNumber(officialSource.remaining),
      used: finiteNumber(officialSource.used),
      unit: text(officialSource.unit, "units"),
      percentRemaining: finiteNumber(officialSource.percentRemaining),
      resetsAt: text(officialSource.resetsAt, ""),
    } : null;
    const inferredSource = provider?.inferred && typeof provider.inferred === "object" ? provider.inferred : null;
    const inferred = inferredSource ? {
      window: text(inferredSource.window),
      calls: finiteNumber(inferredSource.calls),
      tokens: finiteNumber(inferredSource.tokens),
      note: text(inferredSource.note, ""),
    } : null;
    const cooldownSource = provider?.lastCooldown && typeof provider.lastCooldown === "object" ? provider.lastCooldown : null;
    const lastCooldown = cooldownSource ? {
      at: text(cooldownSource.at, ""),
      kind: text(cooldownSource.kind, "cooldown"),
      detail: text(cooldownSource.detail, ""),
    } : null;
    const hasOfficialSignal = official && [official.limit, official.remaining, official.used, official.percentRemaining]
      .some((value) => value !== null);
    let state = "unavailable";
    if (provider?.available !== false && provider?.confidence === "official" && hasOfficialSignal) state = "official";
    else if (provider?.available !== false && inferred) state = "inferred";

    return {
      label: text(provider?.label, text(provider?.provider, "unknown")),
      confidence: text(provider?.confidence, "unavailable"),
      asOf: text(provider?.asOf, ""),
      state,
      official,
      inferred,
      lastCooldown,
      reason: text(provider?.reason, state === "unavailable" ? "no usable signal" : ""),
    };
  });

  return {
    ok,
    empty: ok && providers.length === 0,
    unavailableReason: text(source.unavailableReason, ""),
    providers,
  };
}

function inferredProviderRows(source) {
  if (!Array.isArray(source.usageWindows)) return [];
  const cooldownByProvider = new Map();
  for (const item of Array.isArray(source.cooldownHistory) ? source.cooldownHistory : []) {
    const key = text(item?.provider, "unknown");
    const previous = cooldownByProvider.get(key);
    if (!previous || String(item?.at || "") > String(previous.at || "")) cooldownByProvider.set(key, item);
  }
  return source.usageWindows.map((window) => ({
    provider: window.provider,
    label: window.label,
    confidence: "inferred",
    asOf: source.asOf,
    inferred: {
      window: window.label,
      calls: window.dispatches,
      tokens: (window.tokensIn || 0) + (window.tokensOut || 0),
      note: "dashboard dispatches only",
    },
    lastCooldown: cooldownByProvider.get(window.provider) || null,
  }));
}

function badge(label, kind) {
  return `<span class="badge ${kind}">${esc(label)}</span>`;
}

function relativeTime(value) {
  if (!value) return "never";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function capacityWindow(window) {
  const known = window.remaining !== null && window.percentRemaining !== null;
  const bar = known ? `<div class="ai-capacity-bar"><span style="width:${Math.max(0, Math.min(100, window.percentRemaining))}%"></span></div>` : `<div class="ai-capacity-unavailable">Remaining capacity unavailable</div>`;
  const details = known
    ? `<div class="ai-capacity-values"><strong>${fmtCount(window.percentRemaining)}% remaining</strong><span>Used: ${fmtCount(window.used)} ${esc(window.unit)} · Remaining: ${fmtCount(window.remaining)} ${esc(window.unit)}</span></div>`
    : `<div class="ai-capacity-values"><strong>Unavailable</strong><span>${esc(window.note || "The provider does not expose a supported quota value here.")}</span></div>`;
  return `<div class="ai-window"><div class="ai-window-heading"><strong>${esc(window.name)}</strong><span>${window.resetAt ? `Resets ${esc(fmtDate(window.resetAt))}` : "Reset time unavailable"}</span></div>${bar}${details}<small class="cost-secondary">Source: ${esc(window.source)} · ${esc(window.confidence)}</small></div>`;
}

function capacityCards(aiUsage) {
  if (!aiUsage.capacity.length) return `<div class="empty-state">No provider capacity records are available.</div>`;
  const runtime = aiUsage.runtime;
  const runtimeCard = `<article class="ai-provider-card"><div class="ai-provider-heading"><div><strong>OpenClaw runtime</strong><span>Factory gateway / session visibility</span></div>${badge(runtime.status, runtime.status === "healthy" ? "health-healthy" : "badge-warn")}</div><div class="ai-capacity-unavailable">${esc(runtime.reason || (runtime.status === "healthy" ? "Runtime session source is reachable." : "Runtime session source unavailable."))}</div><small class="cost-secondary">${runtime.stale ? "⚠ stale · " : ""}Source: ${esc(runtime.source)}${runtime.updatedAt ? ` · updated ${esc(relativeTime(runtime.updatedAt))}` : ""}</small></article>`;
  return `<div class="ai-capacity-grid">${aiUsage.capacity.map((provider) => `<article class="ai-provider-card"><div class="ai-provider-heading"><div><strong>${esc(provider.label)}</strong><span>${esc(provider.provider)}</span></div>${badge(provider.status, provider.status === "healthy" ? "health-healthy" : "badge-warn")}</div>${provider.windows.length ? provider.windows.map(capacityWindow).join("") : `<div class="ai-capacity-unavailable">${esc(provider.reason)}</div>`}<small class="cost-secondary">${provider.stale ? "⚠ stale · " : ""}Source: ${esc(provider.source)}${provider.updatedAt ? ` · updated ${esc(relativeTime(provider.updatedAt))}` : ""}</small></article>`).join("")}${runtimeCard}</div>`;
}

function usageTable(title, rows) {
  if (!rows.length) return `<div class="ai-breakdown-empty">No recorded usage for ${esc(title.toLowerCase())}.</div>`;
  const total = rows.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
  return `<div class="ai-breakdown"><h4>${esc(title)}</h4><div class="table-wrap"><table class="cost-table"><thead><tr><th>Source</th><th>Tokens</th><th>Share of recorded usage</th></tr></thead><tbody>${rows.slice(0, 10).map((row) => { const share = total > 0 ? (row.totalTokens / total) * 100 : 0; return `<tr><th scope="row">${esc(row.label)}</th><td>${esc(fmtTokens(row.totalTokens))}</td><td>${esc(share.toFixed(1))}% <span class="cost-secondary">${esc(row.usageConfidence || "recorded")}</span></td></tr>`; }).join("")}</tbody></table></div></div>`;
}

function aiUsageSection(aiUsage) {
  const factory = aiUsage.factory;
  const other = aiUsage.otherLocal;
  const totalLabel = factory.totalTokens === null ? "No recorded Factory tokens" : `${fmtTokens(factory.totalTokens)} Factory tokens recorded`;
  return `<div class="ai-usage-section"><div class="ai-capacity-heading"><div><span class="eyebrow">AI Usage</span><h3>Can the Factory keep running?</h3></div><div><span class="cost-secondary">${esc(aiUsage.asOf ? `Updated ${relativeTime(aiUsage.asOf)}` : "Live snapshot")}</span><button class="btn secondary tiny" data-refresh-ai-usage>Refresh</button></div></div><p class="muted small">Provider account capacity is separate from Factory consumption. Quota is shown only when a provider reports it authoritatively.</p>${capacityCards(aiUsage)}<div class="ai-consumption-heading"><div><span class="eyebrow">Consumption</span><h3>What is consuming capacity?</h3></div><span class="cost-secondary">${esc(totalLabel)}</span></div><div class="ai-source-strip"><span>${badge("Factory", "badge-type")} ${fmtTokens(factory.totalTokens)} recorded tokens · ${esc(factory.usageConfidence)}</span><span>${badge("Other local", "badge-type")} ${other.available ? `${fmtTokens(other.summary.totalTokens)} recorded tokens` : "unavailable"} · ${esc(other.source)}</span></div><div class="ai-breakdown-grid">${usageTable("By provider", factory.byProvider)}${usageTable("By model", factory.byModel)}${usageTable("By agent", factory.byAgent)}${usageTable("By project", factory.byProject)}${usageTable("By objective", factory.byObjective)}${usageTable("By task", factory.byTask)}${usageTable("By stage", factory.byStage)}</div><div class="ai-quality"><strong>Data quality</strong>${aiUsage.dataQuality.map((item) => `<span>${item.confidence === "authoritative" ? "✓" : item.confidence === "recorded" ? "⚠" : "—"} ${esc(item.label)}: ${esc(item.confidence)}</span>`).join("")}</div></div>`;
}

function stageBreakdown(stages) {
  const content = stages.length ? `<div class="table-wrap cost-stage-wrap"><table class="cost-table">
    <thead><tr><th scope="col">Stage</th><th scope="col">Provider</th><th scope="col">Model</th><th scope="col">Tokens</th><th scope="col">Estimated cost</th></tr></thead>
    <tbody>${stages.map((stage) => `<tr><td>${esc(stage.stage)}</td><td>${esc(stage.provider)}</td><td>${esc(stage.model)}</td><td>${esc(fmtTokens(stage.totalTokens))}</td><td>${esc(fmtUsd(stage.estimatedUsd, stage.estimateApprox))}</td></tr>`).join("")}</tbody>
  </table></div>` : `<div class="cost-stage-empty">No stage breakdown available.</div>`;
  return `<details class="drill cost-drill"><summary>Stage breakdown</summary>${content}</details>`;
}

export function recentTasksTable(vm) {
  if (!vm.recentTasks.length) return `<div class="empty-state cost-empty">No recent task cost data.</div>`;
  return `<div class="cost-section"><h3>Recent tasks</h3><div class="table-wrap"><table class="cost-table">
    <thead><tr><th scope="col">Task</th><th scope="col">Project</th><th scope="col">Total tokens</th><th scope="col">Estimated cost</th></tr></thead>
    <tbody>${vm.recentTasks.map((task) => `<tr><td><strong>${esc(task.taskId)}</strong>${task.objective ? `<span class="cost-secondary">${esc(task.objective)}</span>` : ""}${stageBreakdown(task.stages)}</td><td>${esc(task.project)}</td><td>${esc(fmtTokens(task.totalTokens))}</td><td>${esc(fmtUsd(task.estimatedUsd, task.estimateApprox))}${task.estimateApprox ? `<span class="cost-secondary">Includes unknown pricing</span>` : ""}</td></tr>`).join("")}</tbody>
  </table></div></div>`;
}

function totalsRow(label, bucket) {
  return `<tr><th scope="row">${esc(label)}</th><td>${esc(fmtCount(bucket.taskCount))}</td><td>${esc(fmtTokens(bucket.totalTokens))}</td><td>${esc(fmtUsd(bucket.estimatedUsd))}</td></tr>`;
}

export function totalsBlock(vm) {
  const { today, last7Days, byProject } = vm.totals;
  if (!hasBucketData(today) && !hasBucketData(last7Days) && !byProject.length) {
    return `<div class="empty-state cost-empty">No aggregate cost data.</div>`;
  }
  return `<div class="cost-section"><h3>Totals</h3><div class="table-wrap"><table class="cost-table">
    <thead><tr><th scope="col">Period</th><th scope="col">Tasks</th><th scope="col">Tokens</th><th scope="col">Estimated cost</th></tr></thead>
    <tbody>${totalsRow("Today", today)}${totalsRow("Last 7 days", last7Days)}</tbody>
  </table></div>${byProject.length ? `<h4>By project</h4><div class="table-wrap"><table class="cost-table">
    <thead><tr><th scope="col">Project</th><th scope="col">Tasks</th><th scope="col">Tokens</th><th scope="col">Estimated cost</th></tr></thead>
    <tbody>${byProject.map((project) => totalsRow(project.project, project)).join("")}</tbody>
  </table></div>` : `<div class="cost-secondary">No per-project totals available.</div>`}</div>`;
}

function cooldownLine(cooldown) {
  if (!cooldown) return "";
  const detail = cooldown.detail ? ` — ${cooldown.detail}` : "";
  const at = cooldown.at ? ` at ${fmtDate(cooldown.at)}` : "";
  return `<span class="cost-secondary">Latest cooldown: ${esc(cooldown.kind)}${esc(at)}${esc(detail)}</span>`;
}

function providerSignal(provider) {
  if (provider.state === "official") {
    const data = provider.official;
    const values = [
      `Remaining: ${fmtCount(data.remaining)} ${data.unit}`,
      `Used: ${fmtCount(data.used)} ${data.unit}`,
      `Limit: ${fmtCount(data.limit)} ${data.unit}`,
    ];
    if (data.percentRemaining !== null) values.push(`${fmtCount(data.percentRemaining)}% remaining`);
    if (data.resetsAt) values.push(`Resets ${fmtDate(data.resetsAt)}`);
    return values.join(" · ");
  }
  if (provider.state === "inferred") {
    const data = provider.inferred;
    const note = data.note ? ` · ${data.note}` : "";
    return `${fmtCount(data.calls)} calls / ~${fmtTokens(data.tokens)} tokens in ${data.window}${note}`;
  }
  return provider.reason;
}

export function planHeadroomTable(vm) {
  if (!vm.providers.length) {
    const reason = vm.unavailableReason ? `<strong>${esc(vm.unavailableReason)}</strong>` : "No plan headroom data.";
    return `<div class="empty-state cost-empty">${reason}</div>`;
  }
  return `<div class="cost-section"><h3>Plan headroom</h3><div class="table-wrap"><table class="cost-table">
    <thead><tr><th scope="col">Provider</th><th scope="col">Source</th><th scope="col">Headroom signal</th></tr></thead>
    <tbody>${vm.providers.map((provider) => {
      const kind = provider.state === "official" ? "health-healthy" : provider.state === "inferred" ? "badge-warn" : "health-failed";
      const asOf = provider.asOf ? `<span class="cost-secondary">As of ${esc(fmtDate(provider.asOf))}</span>` : "";
      return `<tr><th scope="row">${esc(provider.label)}</th><td>${badge(provider.state, kind)}<span class="cost-source-label">${esc(provider.state)}</span>${asOf}</td><td>${esc(providerSignal(provider))}${cooldownLine(provider.lastCooldown)}</td></tr>`;
    }).join("")}</tbody>
  </table></div></div>`;
}

export function costLimitsPanel(costs, planLimits) {
  try {
    const costVm = normalizeCosts(costs);
    const planVm = normalizePlanLimits(planLimits);
    const status = costVm.aiUsage.available ? badge("Read only", "badge-type") : badge("Degraded", "badge-warn");
    const costFailure = costVm.ok ? "" : `<div class="gap-banner">Cost data is temporarily unavailable.</div>`;
    const planFailure = planVm.ok ? "" : `<div class="gap-banner">Plan limits are temporarily unavailable.</div>`;
    const bothEmpty = costVm.ok && costVm.empty && !costVm.aiUsage.available && planVm.ok && planVm.empty && !planVm.unavailableReason;

    return `<section class="activity-panel cost-limits-panel" aria-labelledby="cost-limits-title">
      <div class="panel-heading"><div><span class="eyebrow">Founder capacity</span><h2 id="cost-limits-title">AI Usage <span class="cost-secondary">· Cost &amp; Limits</span></h2></div>${status}</div>
      ${costFailure}${planFailure}
      ${bothEmpty ? `<div class="empty-state"><strong>No cost or limit data yet.</strong><span>Usage will appear after factory tasks are recorded.</span></div>` : `${costVm.aiUsage.available ? aiUsageSection(costVm.aiUsage) : ""}<details class="ai-task-costs"><summary>Task-level cost and history</summary>${costVm.ok ? `${recentTasksTable(costVm)}${totalsBlock(costVm)}` : ""}${planVm.ok ? planHeadroomTable(planVm) : ""}</details>`}
    </section>`;
  } catch {
    return `<section class="activity-panel cost-limits-panel" aria-labelledby="cost-limits-title"><div class="panel-heading"><div><span class="eyebrow">Spend</span><h2 id="cost-limits-title">Cost &amp; Limits</h2></div>${badge("Degraded", "badge-warn")}</div><div class="gap-banner">Cost and plan-limit data could not be displayed.</div></section>`;
  }
}
