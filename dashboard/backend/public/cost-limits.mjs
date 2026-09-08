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
    totals: { today, last7Days, byProject },
  };
}

export function normalizePlanLimits(payload) {
  const ok = Boolean(payload && typeof payload === "object" && !payload.__error);
  const source = ok ? payload : {};
  const providers = Array.isArray(source.providers) ? source.providers.map((provider) => {
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
  }) : [];

  return {
    ok,
    empty: ok && providers.length === 0,
    unavailableReason: text(source.unavailableReason, ""),
    providers,
  };
}

function badge(label, kind) {
  return `<span class="badge ${kind}">${esc(label)}</span>`;
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
    const availableCount = Number(costVm.ok) + Number(planVm.ok);
    const status = availableCount === 2 ? badge("Read only", "badge-type") : badge("Degraded", "badge-warn");
    const costFailure = costVm.ok ? "" : `<div class="gap-banner">Cost data is temporarily unavailable.</div>`;
    const planFailure = planVm.ok ? "" : `<div class="gap-banner">Plan limits are temporarily unavailable.</div>`;
    const bothEmpty = costVm.ok && costVm.empty && planVm.ok && planVm.empty && !planVm.unavailableReason;

    return `<section class="activity-panel cost-limits-panel" aria-labelledby="cost-limits-title">
      <div class="panel-heading"><div><span class="eyebrow">Spend</span><h2 id="cost-limits-title">Cost &amp; Limits</h2></div>${status}</div>
      ${costFailure}${planFailure}
      ${bothEmpty ? `<div class="empty-state"><strong>No cost or limit data yet.</strong><span>Usage will appear after factory tasks are recorded.</span></div>` : `${costVm.ok ? `${recentTasksTable(costVm)}${totalsBlock(costVm)}` : ""}${planVm.ok ? planHeadroomTable(planVm) : ""}`}
    </section>`;
  } catch {
    return `<section class="activity-panel cost-limits-panel" aria-labelledby="cost-limits-title"><div class="panel-heading"><div><span class="eyebrow">Spend</span><h2 id="cost-limits-title">Cost &amp; Limits</h2></div>${badge("Degraded", "badge-warn")}</div><div class="gap-banner">Cost and plan-limit data could not be displayed.</div></section>`;
  }
}
